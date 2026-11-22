import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidSigningCertUrl } from '../../src/sns/verify';
import { api, createTenant } from '../helpers';
import { makeTestSigner } from './test-cert';

const signer = await makeTestSigner();
const cert = signer.certPem;

const CERT_URL = 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem';

async function sign(fields: Record<string, string>): Promise<string> {
  const order =
    fields.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const toSign = order.filter((f) => fields[f] !== undefined).map((f) => `${f}\n${fields[f]}\n`).join('');
  return signer.sign(toSign);
}

async function snsPost(tenantId: string, fields: Record<string, string>, tamper = false) {
  const Signature = await sign(fields);
  const body = { ...fields, ...(tamper ? { Message: fields.Message + ' ' } : {}), Signature, SignatureVersion: '2', SigningCertURL: CERT_URL };
  return SELF.fetch(`https://openmail.test/ses/${tenantId}`, { method: 'POST', body: JSON.stringify(body) });
}

async function tenantWithTopic(topic: string) {
  const t = await createTenant();
  const res = await SELF.fetch(`https://openmail.test/admin/tenants/${t.slug}/sns-topics`, {
    method: 'PUT',
    headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ topicArns: [topic] }),
  });
  expect(res.status).toBe(200);
  return t;
}

const notification = (topic: string, message: object) => ({
  Type: 'Notification',
  MessageId: crypto.randomUUID(),
  TopicArn: topic,
  Message: JSON.stringify(message),
  Timestamp: new Date().toISOString(),
});

const check = async (apiKey: string, email: string) =>
  (await (await api(apiKey, `/v1/suppressions/check?email=${email}`)).json()) as { suppressed: boolean; kinds: string[] };

describe('isValidSigningCertUrl', () => {
  it.each([
    ['https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem', true],
    ['https://sns.us-gov-west-1.amazonaws.com/SimpleNotificationService-abc.pem', true],
    ['https://sns.s3.amazonaws.com/SimpleNotificationService-abc.pem', false],
    ['https://sns.evil-bucket.s3.amazonaws.com/SimpleNotificationService-abc.pem', false],
    ['http://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem', false],
    ['https://sns.eu-west-1.amazonaws.com/other.pem', false],
  ])('%s → %s', (url, ok) => {
    expect(isValidSigningCertUrl(url)).toBe(ok);
  });
});

describe('POST /ses/:tenantId', () => {
  afterEach(() => vi.restoreAllMocks());
  const serveCert = () =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      return url === CERT_URL ? new Response(cert) : new Response('ok');
    });

  it('suppresses permanently bounced and complaining recipients from a signed notification', async () => {
    const topic = 'arn:aws:sns:eu-west-1:111111111111:bounces-a';
    const t = await tenantWithTopic(topic);
    serveCert();

    const bounce = await snsPost(t.id, notification(topic, {
      eventType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'Dead@Example.com' }] },
      mail: { messageId: 'm1' },
    }));
    expect(bounce.status).toBe(200);
    const complaint = await snsPost(t.id, notification(topic, {
      notificationType: 'Complaint',
      complaint: { complainedRecipients: [{ emailAddress: 'angry@example.com' }] },
      mail: { messageId: 'm2' },
    }));
    expect(complaint.status).toBe(200);

    expect(await check(t.apiKey, 'dead@example.com')).toEqual({ suppressed: true, kinds: ['hard_bounce'] });
    expect(await check(t.apiKey, 'angry@example.com')).toEqual({ suppressed: true, kinds: ['complaint'] });
  });

  it('does not suppress on a transient bounce', async () => {
    const topic = 'arn:aws:sns:eu-west-1:111111111111:bounces-b';
    const t = await tenantWithTopic(topic);
    serveCert();
    await snsPost(t.id, notification(topic, {
      eventType: 'Bounce',
      bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'full@example.com' }] },
    }));
    expect(await check(t.apiKey, 'full@example.com')).toEqual({ suppressed: false, kinds: [] });
  });

  it('refuses and quarantines a bad signature or a topic outside the tenant allowlist', async () => {
    const topic = 'arn:aws:sns:eu-west-1:111111111111:bounces-c';
    const t = await tenantWithTopic(topic);
    serveCert();
    const msg = notification(topic, { eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'x@example.com' }] } });

    expect((await snsPost(t.id, msg, true)).status).toBe(403);
    const otherTopic = notification('arn:aws:sns:eu-west-1:111111111111:someone-else', JSON.parse(msg.Message));
    expect((await snsPost(t.id, otherTopic)).status).toBe(403);

    expect(await check(t.apiKey, 'x@example.com')).toEqual({ suppressed: false, kinds: [] });
    const q = await env.DB.prepare('select * from webhook_quarantine where tenant_id = ?').bind(t.id).all();
    expect(q.results).toHaveLength(2);
    expect(JSON.stringify(q.results)).not.toContain('@'); // no recipient address is kept
  });

  it('confirms a subscription for an allowed topic by visiting its SubscribeURL', async () => {
    const topic = 'arn:aws:sns:eu-west-1:111111111111:bounces-d';
    const t = await tenantWithTopic(topic);
    const fetchSpy = serveCert();
    const subscribeUrl = 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc';

    const res = await snsPost(t.id, {
      Type: 'SubscriptionConfirmation',
      MessageId: crypto.randomUUID(),
      Token: 'abc',
      TopicArn: topic,
      Message: 'confirm',
      SubscribeURL: subscribeUrl,
      Timestamp: new Date().toISOString(),
    });

    expect(res.status).toBe(200);
    const urls = fetchSpy.mock.calls.map(([i]) => (i instanceof Request ? i.url : String(i)));
    expect(urls).toContain(subscribeUrl);
  });
});

describe('hosted unsubscribe', () => {
  async function contactToken(apiKey: string, email: string, unsubscribeToken?: string): Promise<string> {
    await api(apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email, lists: ['beacon'], ...(unsubscribeToken ? { unsubscribeToken } : {}) }) });
    const row = await env.DB.prepare('select unsubscribe_token from contacts where email = ?').bind(email).first<{ unsubscribe_token: string }>();
    return row!.unsubscribe_token;
  }

  it('shows a confirm page on GET without unsubscribing, and unsubscribes on POST', async () => {
    const t = await createTenant();
    const token = await contactToken(t.apiKey, 'reader@example.com');

    const page = await SELF.fetch(`https://openmail.test/u/${t.id}/${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<form method="post"');
    expect(await check(t.apiKey, 'reader@example.com')).toEqual({ suppressed: false, kinds: [] });

    const done = await SELF.fetch(`https://openmail.test/u/${t.id}/${token}`, { method: 'POST' });
    expect(done.status).toBe(200);
    expect(await check(t.apiKey, 'reader@example.com')).toEqual({ suppressed: true, kinds: ['unsubscribe'] });
  });

  it('honours an RFC 8058 one-click POST', async () => {
    const t = await createTenant();
    const token = await contactToken(t.apiKey, 'one@example.com');

    const res = await SELF.fetch(`https://openmail.test/u/${t.id}/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);
    expect(await check(t.apiKey, 'one@example.com')).toEqual({ suppressed: true, kinds: ['unsubscribe'] });
  });

  it('lets an old stack proxy an imported token through its own API key, scoped to its tenant', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const imported = 'legacy-token-0123456789abcdef';
    await contactToken(a.apiKey, 'old@example.com', imported);
    await contactToken(b.apiKey, 'other@example.com', imported); // same token, other tenant: allowed, no collision

    const res = await api(a.apiKey, '/v1/unsubscribe', { method: 'POST', body: JSON.stringify({ token: imported }) });
    expect(await res.json()).toEqual({ unsubscribed: true });
    expect(await check(a.apiKey, 'old@example.com')).toEqual({ suppressed: true, kinds: ['unsubscribe'] });
    expect(await check(b.apiKey, 'other@example.com')).toEqual({ suppressed: false, kinds: [] });
  });

  it("answers 404 for an unknown token, and for a real token under another tenant's id", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const token = await contactToken(a.apiKey, 'mine@example.com');
    expect((await SELF.fetch(`https://openmail.test/u/${a.id}/nope-nope-nope-nope`)).status).toBe(404);
    expect((await SELF.fetch(`https://openmail.test/u/${b.id}/${token}`)).status).toBe(404);
  });
});
