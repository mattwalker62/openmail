import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client';
import { suppressions, tenants, webhookQuarantine } from '../db/schema';
import type { Env } from '../env';
import { addressHash } from '../lib/address';
import { isValidSnsUrl, verifySnsSignature, type SnsMessage } from '../sns/verify';

export const sesEvents = new Hono<{ Bindings: Env }>();

interface SesEvent {
  eventType?: string;
  notificationType?: string;
  bounce?: { bounceType?: string; bouncedRecipients?: Array<{ emailAddress: string }> };
  complaint?: { complainedRecipients?: Array<{ emailAddress: string }> };
}

/**
 * SES bounce and complaint events for one tenant, delivered by SNS. Fail-closed: the message must be
 * signed by SNS and come from a topic on this tenant's allowlist, or it is refused and quarantined.
 * A permanent bounce suppresses the address as hard_bounce; a complaint as complaint.
 */
sesEvents.post('/:tenantId', async (c) => {
  const tenantId = c.req.param('tenantId');
  const raw = await c.req.text();
  const d = db(c.env.DB);
  const quarantine = async (reason: string) => {
    await d.insert(webhookQuarantine).values({ id: crypto.randomUUID(), tenantId, reason, body: raw.slice(0, 10_000) });
    return c.json({ error: 'forbidden' }, 403);
  };

  let m: SnsMessage;
  try {
    m = JSON.parse(raw) as SnsMessage;
  } catch {
    return quarantine('invalid_json');
  }
  const tenant = await d.select({ topics: tenants.snsTopicArns }).from(tenants).where(eq(tenants.id, tenantId)).get();
  if (!tenant) return c.json({ error: 'not_found' }, 404);
  if (!(JSON.parse(tenant.topics) as string[]).includes(m.TopicArn)) return quarantine('topic_not_allowed');
  if (!(await verifySnsSignature(m))) return quarantine('bad_signature');

  if (m.Type === 'SubscriptionConfirmation') {
    if (!m.SubscribeURL || !isValidSnsUrl(m.SubscribeURL)) return quarantine('bad_subscribe_url');
    await fetch(m.SubscribeURL);
    return c.json({ ok: true });
  }
  if (m.Type !== 'Notification') return c.json({ ok: true });

  const event = JSON.parse(m.Message) as SesEvent;
  const type = event.eventType ?? event.notificationType;
  const toSuppress: Array<{ email: string; kind: 'hard_bounce' | 'complaint' }> = [];
  if (type === 'Bounce' && event.bounce?.bounceType === 'Permanent') {
    for (const r of event.bounce.bouncedRecipients ?? []) toSuppress.push({ email: r.emailAddress, kind: 'hard_bounce' });
  }
  if (type === 'Complaint') {
    for (const r of event.complaint?.complainedRecipients ?? []) toSuppress.push({ email: r.emailAddress, kind: 'complaint' });
  }
  for (const s of toSuppress) {
    await d.insert(suppressions).values({ tenantId, addressHash: await addressHash(s.email), kind: s.kind }).onConflictDoNothing();
  }
  return c.json({ ok: true, suppressed: toSuppress.length });
});
