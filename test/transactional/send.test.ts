import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderTemplate, sendTransactional, type TransactionalDeps } from '../../src/transactional/send';
import { api, createTenant } from '../helpers';

const template = { subject: 'Sign in to {{site}}', html: '<a href="{{url}}">Sign in</a> {{name}}', text: 'Sign in: {{url}}' };

describe('renderTemplate', () => {
  it('fills placeholders, HTML-escaping values in the html body only', () => {
    const out = renderTemplate(template, { site: 'Beacon', url: 'https://x.test/l?a=1&b=2', name: '<b>Al</b>' });
    expect(out.subject).toBe('Sign in to Beacon');
    expect(out.html).toBe('<a href="https://x.test/l?a=1&amp;b=2">Sign in</a> &lt;b&gt;Al&lt;/b&gt;');
    expect(out.text).toBe('Sign in: https://x.test/l?a=1&b=2');
  });

  it('leaves no unfilled placeholder: a missing value is an error', () => {
    expect(() => renderTemplate(template, { site: 'Beacon' })).toThrow(/missing template data: url/);
  });
});

describe('sendTransactional (D5: fail open on the suppression lookup)', () => {
  const base = (over: Partial<TransactionalDeps> = {}): TransactionalDeps => ({
    blockingSuppression: vi.fn(async () => false),
    send: vi.fn(async () => ({ ok: true as const, messageId: 'tx-1' })),
    log: vi.fn(),
    ...over,
  });

  it('refuses a hard-bounced, complained or erased address without calling SES', async () => {
    const deps = base({ blockingSuppression: vi.fn(async () => true) });
    const result = await sendTransactional(deps, { to: 'x@example.com', from: 'f@x.test', rendered: { subject: 's', html: 'h' } });
    expect(result).toEqual({ status: 409, body: { error: 'suppressed' } });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('still sends when the suppression lookup itself fails, and logs it', async () => {
    const deps = base({ blockingSuppression: vi.fn(async () => { throw new Error('D1 down'); }) });
    const result = await sendTransactional(deps, { to: 'x@example.com', from: 'f@x.test', rendered: { subject: 's', html: 'h' } });
    expect(result).toEqual({ status: 202, body: { messageId: 'tx-1' } });
    expect(deps.log).toHaveBeenCalled();
  });

  it('answers 429 on an SES throttle so the caller can retry, and 502 on other failures', async () => {
    const throttled = base({ send: vi.fn(async () => ({ ok: false as const, status: 429, error: 'slow down', type: 'retryable' as const, shouldRetry: true, shouldSuppress: false })) });
    expect((await sendTransactional(throttled, { to: 'x@example.com', from: 'f', rendered: { subject: 's', html: 'h' } })).status).toBe(429);
    const broken = base({ send: vi.fn(async () => ({ ok: false as const, status: 403, error: 'bad creds', type: 'fatal' as const, shouldRetry: false, shouldSuppress: false })) });
    expect((await sendTransactional(broken, { to: 'x@example.com', from: 'f', rendered: { subject: 's', html: 'h' } })).status).toBe(502);
  });
});

describe('POST /v1/messages', () => {
  afterEach(() => vi.restoreAllMocks());

  async function tenantWithTemplate() {
    const t = await createTenant({ secretPrefix: 'SES_TEST' });
    const put = await SELF.fetch(`https://openmail.test/admin/tenants/${t.slug}/templates/login`, {
      method: 'PUT',
      headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
      body: JSON.stringify(template),
    });
    expect(put.status).toBe(200);
    return t;
  }

  it('sends the named template on the transactional lane and records it without the plain address', async () => {
    const t = await tenantWithTemplate();
    // Read the request inside the mock: Workers forbid touching its body from the test's context.
    let captured: { url: string; body: { Destination: { ToAddresses: string[] }; Content: { Simple: Record<string, unknown> } } } | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const req = input as Request;
      captured = { url: req.url, body: await req.json() };
      return new Response('{"MessageId":"m-1"}', { status: 200 });
    });

    const res = await api(t.apiKey, '/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ to: 'Reader@Example.com', template: 'login', data: { site: 'Beacon', url: 'https://b.test/l', name: 'Al' } }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ messageId: 'm-1' });
    expect(captured?.url).toBe('https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails');
    expect(captured?.body.Destination.ToAddresses).toEqual(['reader@example.com']);
    expect(captured?.body.Content.Simple).not.toHaveProperty('Headers'); // no unsubscribe header on login mail

    await new Promise((r) => setTimeout(r, 50));
    const row = await env.DB.prepare('select status, message_id, address_hash from transactional_messages where tenant_id = ?').bind(t.id).first<{ status: string; message_id: string; address_hash: string }>();
    expect(row?.status).toBe('sent');
    expect(row?.address_hash).not.toContain('@');
  });

  it('still sends a login email to someone who only unsubscribed from the newsletter', async () => {
    const t = await tenantWithTemplate();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"MessageId":"m-2"}', { status: 200 }));
    await api(t.apiKey, '/v1/suppressions', { method: 'POST', body: JSON.stringify({ email: 'u@example.com', kind: 'unsubscribe' }) });

    const res = await api(t.apiKey, '/v1/messages', { method: 'POST', body: JSON.stringify({ to: 'u@example.com', template: 'login', data: { site: 'B', url: 'https://b.test', name: 'U' } }) });
    expect(res.status).toBe(202);
  });

  it('refuses a hard-bounced address with 409 and an unknown template with 404', async () => {
    const t = await tenantWithTemplate();
    await api(t.apiKey, '/v1/suppressions', { method: 'POST', body: JSON.stringify({ email: 'b@example.com', kind: 'hard_bounce' }) });

    const blocked = await api(t.apiKey, '/v1/messages', { method: 'POST', body: JSON.stringify({ to: 'b@example.com', template: 'login', data: { site: 'B', url: 'https://b.test', name: 'B' } }) });
    expect(blocked.status).toBe(409);
    const unknown = await api(t.apiKey, '/v1/messages', { method: 'POST', body: JSON.stringify({ to: 'a@example.com', template: 'nope', data: {} }) });
    expect(unknown.status).toBe(404);
  });
});
