import type { OutboundEmail, SendResult } from '../transport/ses';

export interface TemplateBody {
  subject: string;
  html: string;
  text?: string | null;
}

export interface Rendered {
  subject: string;
  html: string;
  text?: string;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

const escapeHtml = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Fill `{{name}}` placeholders. Values are HTML-escaped in the html body; a missing value is an error. */
export function renderTemplate(t: TemplateBody, data: Record<string, string>): Rendered {
  const fill = (s: string, escape: boolean) =>
    s.replace(PLACEHOLDER, (_, key: string) => {
      const value = data[key];
      if (value === undefined) throw new Error(`missing template data: ${key}`);
      return escape ? escapeHtml(value) : value;
    });
  return {
    subject: fill(t.subject, false),
    html: fill(t.html, true),
    ...(t.text ? { text: fill(t.text, false) } : {}),
  };
}

export interface TransactionalDeps {
  /** True when a hard bounce, complaint or erasure blocks this address. Unsubscribes never block login mail. */
  blockingSuppression: (to: string) => Promise<boolean>;
  send: (email: OutboundEmail) => Promise<SendResult>;
  log: (message: string, err?: unknown) => void;
}

export type TransactionalResult =
  | { status: 202; body: { messageId: string } }
  | { status: 409; body: { error: 'suppressed' } }
  | { status: 429 | 502; body: { error: string } };

/**
 * Send one login-type email (eng review D5). One suppression lookup; if that lookup fails the email
 * still goes out, because a database blip must not stop someone signing in.
 */
export async function sendTransactional(
  deps: TransactionalDeps,
  msg: { to: string; from: string; rendered: Rendered },
): Promise<TransactionalResult> {
  try {
    if (await deps.blockingSuppression(msg.to)) return { status: 409, body: { error: 'suppressed' } };
  } catch (err) {
    deps.log('transactional suppression lookup failed; sending anyway', err);
  }
  const result = await deps.send({ to: msg.to, from: msg.from, ...msg.rendered });
  if (result.ok) return { status: 202, body: { messageId: result.messageId } };
  return { status: result.status === 429 || result.type === 'retryable' ? 429 : 502, body: { error: result.error } };
}
