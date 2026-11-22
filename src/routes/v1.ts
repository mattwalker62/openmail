import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { createKeyAuthenticator } from '../auth/api-keys';
import { db } from '../db/client';
import { apiKeys, contacts, listMembers, lists, suppressions } from '../db/schema';
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
