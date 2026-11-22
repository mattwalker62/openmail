import { AwsClient } from 'aws4fetch';

/**
 * Amazon SES v2 transport. Ported from Dollop's ses-client.ts with three changes:
 * - signing uses aws4fetch instead of hand-rolled SigV4, and the region comes from the lane;
 * - every tenant brings its own SES account, split into a transactional and a bulk lane
 *   (separate regions, so a bulk-send pause cannot stop login mail);
 * - one-click unsubscribe headers go inside Simple content, where SES v2 reads them.
 */

export interface SesLane {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  configurationSet: string;
}

export interface TenantLanes {
  transactional: SesLane;
  bulk: SesLane;
}

export type LaneKind = keyof TenantLanes;

export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  html: string;
  text?: string;
  unsubscribeUrl?: string;
  tags?: Array<{ name: string; value: string }>;
}

export type SesErrorType = 'retryable' | 'non_retryable' | 'fatal';

export interface SesErrorClass {
  type: SesErrorType;
  shouldRetry: boolean;
  shouldSuppress: boolean;
}

export type SendResult =
  | { ok: true; messageId: string }
  | ({ ok: false; status: number; error: string } & SesErrorClass);

interface Content {
  Data: string;
  Charset: 'UTF-8';
}

export interface SendEmailBody {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  ConfigurationSetName: string;
  Content: {
    Simple: {
      Subject: Content;
      Body: { Html: Content; Text?: Content };
      Headers?: Array<{ Name: string; Value: string }>;
    };
  };
  EmailTags?: Array<{ Name: string; Value: string }>;
}

const utf8 = (Data: string): Content => ({ Data, Charset: 'UTF-8' });

/** AWS region names only (e.g. eu-west-1, us-gov-west-1); the region becomes part of the SES hostname. */
export const AWS_REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

export function laneFor(lanes: TenantLanes, kind: LaneKind): SesLane {
  return lanes[kind];
}

export function buildSendEmailBody(email: OutboundEmail, lane: SesLane): SendEmailBody {
  const simple: SendEmailBody['Content']['Simple'] = {
    Subject: utf8(email.subject),
    Body: { Html: utf8(email.html), ...(email.text ? { Text: utf8(email.text) } : {}) },
  };
  if (email.unsubscribeUrl) {
    // RFC 8058 one-click unsubscribe; AWS asks for List-Unsubscribe before List-Unsubscribe-Post.
    simple.Headers = [
      { Name: 'List-Unsubscribe', Value: `<${email.unsubscribeUrl}>` },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    ];
  }

  const body: SendEmailBody = {
    FromEmailAddress: email.from,
    Destination: { ToAddresses: [email.to] },
    ConfigurationSetName: lane.configurationSet,
    Content: { Simple: simple },
  };
  if (email.tags?.length) {
    body.EmailTags = email.tags.map((t) => ({ Name: t.name, Value: t.value }));
  }
  return body;
}

const RETRYABLE: SesErrorClass = { type: 'retryable', shouldRetry: true, shouldSuppress: false };
const FATAL: SesErrorClass = { type: 'fatal', shouldRetry: false, shouldSuppress: false };
const PERMANENT = (shouldSuppress: boolean): SesErrorClass => ({
  type: 'non_retryable',
  shouldRetry: false,
  shouldSuppress,
});

function messageOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; Message?: string };
    return parsed.message ?? parsed.Message ?? body;
  } catch {
    return body;
  }
}

/**
 * Sort an SES failure into retry / give up / fix the configuration.
 * `errorType` is the x-amzn-ErrorType header, which SES sends as "Code" or "Code:uri".
 */
export function classifySesError(status: number, body: string, errorType?: string): SesErrorClass {
  const code = errorType?.split(':')[0];
  const message = messageOf(body).toLowerCase();

  if (status === 429 || status >= 500 || code === 'TooManyRequestsException' || code === 'Throttling') {
    return RETRYABLE;
  }
  if (status === 401 || status === 403) return FATAL;
  if (
    code === 'AccountSuspendedException' ||
    code === 'SendingPausedException' ||
    code === 'MailFromDomainNotVerifiedException'
  ) {
    return FATAL;
  }
  if (code === 'MessageRejected') {
    return PERMANENT(message.includes('suppression list') || message.includes('bounced'));
  }
  if (code === 'BadRequestException' || status === 400) {
    // A malformed address will never succeed; keep it from being mailed again.
    return PERMANENT(message.includes('address') || message.includes('@domain') || message.includes('email'));
  }
  return RETRYABLE;
}

export async function sendViaSes(lane: SesLane, email: OutboundEmail): Promise<SendResult> {
  if (!AWS_REGION.test(lane.region)) {
    return { ok: false, status: 0, error: `invalid SES region: ${lane.region}`, ...FATAL };
  }
  const aws = new AwsClient({
    accessKeyId: lane.accessKeyId,
    secretAccessKey: lane.secretAccessKey,
    service: 'ses',
    region: lane.region,
  });

  let res: Response;
  try {
    res = await aws.fetch(`https://email.${lane.region}.amazonaws.com/v2/email/outbound-emails`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildSendEmailBody(email, lane)),
    });
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), ...RETRYABLE };
  }

  const text = await res.text();
  if (res.ok) {
    const { MessageId } = JSON.parse(text) as { MessageId: string };
    return { ok: true, messageId: MessageId };
  }
  const errorType = res.headers.get('x-amzn-ErrorType') ?? undefined;
  return { ok: false, status: res.status, error: messageOf(text), ...classifySesError(res.status, text, errorType) };
}
