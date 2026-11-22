import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { createKeyAuthenticator } from '../auth/api-keys';
import { createDraft, requestCampaign, setCampaignStatus, updateDraft } from '../campaigns/service';
import { db } from '../db/client';
import { apiKeys, campaigns, contacts, listMembers, lists, suppressions } from '../db/schema';
import type { Env } from '../env';
import { addressHash, isValidEmail, normalizeEmail, randomToken } from '../lib/address';

type Vars = { tenantId: string; keyId: string };
export const v1 = new Hono<{ Bindings: Env; Variables: Vars }>();

// One authenticator per isolate, so its stale-if-error memory survives across requests.
let authenticate: ReturnType<typeof createKeyAuthenticator> | undefined;

v1.use('*', async (c, next) => {
  authenticate ??= createKeyAuthenticator(async (keyHash) => {
    const row = await db(c.env.DB)
      .select({ keyId: apiKeys.id, tenantId: apiKeys.tenantId })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
      .get();
    return row ?? null;
  });
  const key = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const result = key ? await authenticate(key) : ({ ok: false, status: 401 } as const);
  if (!result.ok) return c.json({ error: result.status === 401 ? 'unauthorized' : 'unavailable' }, result.status);
  c.set('tenantId', result.tenantId);
  c.set('keyId', result.keyId);
  await next();
});

const SUPPRESSION_KINDS = ['hard_bounce', 'complaint', 'erased', 'unsubscribe'] as const;
type SuppressionKind = (typeof SUPPRESSION_KINDS)[number];

v1.post('/contacts', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    name?: string;
    externalId?: string;
    source?: string;
    lists?: string[];
  };
  const email = normalizeEmail(b.email ?? '');
  if (!isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400);
  const tenantId = c.get('tenantId');
  const d = db(c.env.DB);

  const existing = await d
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.email, email)))
    .get();
  const id = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await d.insert(contacts).values({
      id,
      tenantId,
      email,
      addressHash: await addressHash(email),
      name: b.name ?? null,
      externalId: b.externalId ?? null,
      source: b.source ?? null,
      unsubscribeToken: randomToken(24),
    });
  }

  for (const name of b.lists ?? []) {
    await d.insert(lists).values({ id: crypto.randomUUID(), tenantId, name }).onConflictDoNothing();
    const list = await d
      .select({ id: lists.id })
      .from(lists)
      .where(and(eq(lists.tenantId, tenantId), eq(lists.name, name)))
      .get();
    if (list) await d.insert(listMembers).values({ listId: list.id, contactId: id }).onConflictDoNothing();
  }

  return c.json({ id, email }, existing ? 200 : 201);
});

/**
 * Erase a contact for this tenant. The hashed suppression goes in first, in the same atomic batch,
 * so the address can never be mailed again even though no plain copy is kept. Idempotent.
 */
v1.post('/contacts/erase', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { email?: string };
  const email = normalizeEmail(b.email ?? '');
  if (!isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400);
  const tenantId = c.get('tenantId');
  const d = db(c.env.DB);
  const hash = await addressHash(email);
  const ids = d
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.email, email)));

  await d.batch([
    d.insert(suppressions).values({ tenantId, addressHash: hash, kind: 'erased' }).onConflictDoNothing(),
    d.delete(listMembers).where(inArray(listMembers.contactId, ids)),
    d.delete(contacts).where(and(eq(contacts.tenantId, tenantId), eq(contacts.email, email))),
  ]);
  return c.json({ erased: true });
});

v1.post('/suppressions', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { email?: string; kind?: string };
  const email = normalizeEmail(b.email ?? '');
  if (!isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400);
  if (!SUPPRESSION_KINDS.includes(b.kind as SuppressionKind)) return c.json({ error: 'invalid_kind' }, 400);
  await db(c.env.DB)
    .insert(suppressions)
    .values({ tenantId: c.get('tenantId'), addressHash: await addressHash(email), kind: b.kind as SuppressionKind })
    .onConflictDoNothing();
  return c.json({ suppressed: true }, 201);
});

v1.get('/suppressions/check', async (c) => {
  const email = normalizeEmail(c.req.query('email') ?? '');
  if (!isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400);
  const rows = await db(c.env.DB)
    .select({ kind: suppressions.kind })
    .from(suppressions)
    .where(and(eq(suppressions.tenantId, c.get('tenantId')), eq(suppressions.addressHash, await addressHash(email))))
    .all();
  const kinds = rows.map((r) => r.kind).sort();
  return c.json({ suppressed: kinds.length > 0, kinds });
});

// ── Drafts and campaigns ─────────────────────────────────────────────────────

v1.post('/drafts', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { subject?: string; html?: string; text?: string };
  if (!b.subject || !b.html) return c.json({ error: 'subject_and_html_required' }, 400);
  const draft = await createDraft(db(c.env.DB), c.get('tenantId'), { subject: b.subject, html: b.html, ...(b.text ? { text: b.text } : {}) }, 'api');
  return c.json(draft, 201);
});

v1.patch('/drafts/:id', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { subject?: string; html?: string; text?: string | null };
  const updated = await updateDraft(db(c.env.DB), c.get('tenantId'), c.req.param('id'), b);
  return updated ? c.json(updated) : c.json({ error: 'not_found' }, 404);
});

v1.post('/campaigns', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as {
    draftId?: string;
    list?: string;
    scheduledAt?: number;
    campaignType?: string;
    fromAddress?: string;
  };
  if (!b.draftId || !b.list) return c.json({ error: 'draftId_and_list_required' }, 400);
  try {
    const result = await requestCampaign(
      db(c.env.DB),
      { tenantId: c.get('tenantId'), keyId: c.get('keyId'), origin: 'api' },
      { draftId: b.draftId, list: b.list, ...(b.scheduledAt ? { scheduledAt: b.scheduledAt } : {}), ...(b.campaignType ? { campaignType: b.campaignType } : {}), ...(b.fromAddress ? { fromAddress: b.fromAddress } : {}) },
    );
    // 202 when a human still has to approve or the send was paused; 201 when it is approved to go.
    return c.json(result, result.status === 'approved' ? 201 : 202);
  } catch (err) {
    if (err instanceof Error && err.message === 'unknown_draft') return c.json({ error: 'not_found' }, 404);
    throw err;
  }
});

v1.get('/campaigns/:id', async (c) => {
  const row = await db(c.env.DB)
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, c.req.param('id')), eq(campaigns.tenantId, c.get('tenantId'))))
    .get();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const counts = await c.env.DB.prepare('select status, count(*) as n from campaign_recipients where campaign_id = ? group by status')
    .bind(row.id)
    .all<{ status: string; n: number }>();
  return c.json({
    id: row.id,
    status: row.status,
    pauseReason: row.pauseReason,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    recipientCount: row.recipientCount,
    deliveries: Object.fromEntries(counts.results.map((r) => [r.status, r.n])),
  });
});

for (const action of ['pause', 'resume', 'cancel'] as const) {
  v1.post(`/campaigns/:id/${action}`, async (c) => {
    const result = await setCampaignStatus(db(c.env.DB), c.get('tenantId'), c.req.param('id'), action);
    return c.json(result, result.ok ? 200 : 409);
  });
}
