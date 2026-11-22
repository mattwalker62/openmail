import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidSigningCertUrl } from '../../src/sns/verify';
import cert from '../fixtures/sns-test-cert.pem?raw';
import key from '../fixtures/sns-test-key.pkcs8.pem?raw';
import { api, createTenant } from '../helpers';

const CERT_URL = 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem';

async function sign(fields: Record<string, string>): Promise<string> {
  const der = Uint8Array.from(atob(key.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  const k = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const order =
    fields.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const toSign = order.filter((f) => fields[f] !== undefined).map((f) => `${f}\n${fields[f]}\n`).join('');
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, new TextEncoder().encode(toSign));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
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
    const q = await env.DB.prepare('select count(*) as n from webhook_quarantine where tenant_id = ?').bind(t.id).first<{ n: number }>();
    expect(q?.n).toBe(2);
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
  async function contactToken(apiKey: string, email: string, unsubscribeToken?: string) {
    await api(apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email, lists: ['beacon'], ...(unsubscribeToken ? { unsubscribeToken } : {}) }) });
    const row = await env.DB.prepare('select unsubscribe_token from contacts where email = ?').bind(email).first<{ unsubscribe_token: string }>();
    return row!.unsubscribe_token;
  }

  it('shows a confirm page on GET without unsubscribing, and unsubscribes on POST', async () => {
    const t = await createTenant();
    const token = await contactToken(t.apiKey, 'reader@example.com');

    const page = await SELF.fetch(`https://openmail.test/u/${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<form method="post"');
    expect(await check(t.apiKey, 'reader@example.com')).toEqual({ suppressed: false, kinds: [] });

    const done = await SELF.fetch(`https://openmail.test/u/${token}`, { method: 'POST' });
    expect(done.status).toBe(200);
    expect(await check(t.apiKey, 'reader@example.com')).toEqual({ suppressed: true, kinds: ['unsubscribe'] });
  });

  it('honours an RFC 8058 one-click POST and a token imported from an old stack', async () => {
    const t = await createTenant();
    const imported = 'legacy-token-0123456789abcdef';
    await contactToken(t.apiKey, 'old@example.com', imported);

    const res = await SELF.fetch(`https://openmail.test/u/${imported}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);
    expect(await check(t.apiKey, 'old@example.com')).toEqual({ suppressed: true, kinds: ['unsubscribe'] });
  });

  it('answers 404 for an unknown token', async () => {
    expect((await SELF.fetch('https://openmail.test/u/nope-nope-nope-nope')).status).toBe(404);
  });
});
