import { Hono } from 'hono';
import { db } from '../db/client';
import { apiKeys, tenants } from '../db/schema';
import type { Env } from '../env';
import { generateApiKey, hashApiKey } from '../auth/api-keys';
import { AWS_REGION } from '../transport/ses';
import { sha256Hex } from '../lib/address';

export const admin = new Hono<{ Bindings: Env }>();

/** Constant-time comparison of SHA-256 digests, so the admin token can't be guessed by timing. */
async function tokenMatches(given: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

admin.use('*', async (c, next) => {
  const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!(await tokenMatches(given, c.env.ADMIN_API_TOKEN))) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
const SECRET_PREFIX = /^[A-Z][A-Z0-9_]{1,60}$/;

admin.post('/tenants', async (c) => {
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (k: string) => (typeof b?.[k] === 'string' ? (b[k] as string) : '');
  const t = {
    slug: str('slug'),
    name: str('name'),
    fromAddress: str('fromAddress'),
    secretPrefix: str('secretPrefix'),
    txRegion: str('txRegion'),
    txConfigurationSet: str('txConfigurationSet'),
    bulkRegion: str('bulkRegion'),
    bulkConfigurationSet: str('bulkConfigurationSet'),
  };
  if (
    !SLUG.test(t.slug) ||
    !t.name ||
    !t.fromAddress ||
    !SECRET_PREFIX.test(t.secretPrefix) ||
    !AWS_REGION.test(t.txRegion) ||
    !AWS_REGION.test(t.bulkRegion) ||
    !t.txConfigurationSet ||
    !t.bulkConfigurationSet
  ) {
    return c.json({ error: 'invalid_tenant' }, 400);
  }

  const id = crypto.randomUUID();
  const apiKey = generateApiKey();
  await db(c.env.DB).batch([
    db(c.env.DB).insert(tenants).values({ id, ...t }),
    db(c.env.DB)
      .insert(apiKeys)
      .values({ id: crypto.randomUUID(), tenantId: id, name: 'first key', keyHash: await hashApiKey(apiKey) }),
  ]);
  // The only time the key is shown: only its hash is stored.
  return c.json({ id, slug: t.slug, apiKey }, 201);
});
