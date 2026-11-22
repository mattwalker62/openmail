import { Hono } from 'hono';
import { db } from '../db/client';
import { apiKeys, memberships, ownerInvites, templates, tenants, users } from '../db/schema';
import { normalizeEmail, isValidEmail } from '../lib/address';
import { eq } from 'drizzle-orm';
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

/** Create or replace a transactional template. Owner-managed; agents can never reach this. */
admin.put('/tenants/:slug/templates/:name', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { subject?: string; html?: string; text?: string; linkOrigins?: string[] } | null;
  if (!b?.subject || !b.html) return c.json({ error: 'subject_and_html_required' }, 400);
  const linkOrigins = b.linkOrigins ?? [];
  if (!linkOrigins.every((o) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o))) return c.json({ error: 'invalid_link_origins' }, 400);
  const d = db(c.env.DB);
  const tenant = await d.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, c.req.param('slug'))).get();
  if (!tenant) return c.json({ error: 'not_found' }, 404);
  const values = { subject: b.subject, html: b.html, text: b.text ?? null, linkOrigins: JSON.stringify(linkOrigins) };
  await d
    .insert(templates)
    .values({ tenantId: tenant.id, name: c.req.param('name'), ...values })
    .onConflictDoUpdate({ target: [templates.tenantId, templates.name], set: values });
  return c.json({ ok: true });
});

/** Set the SNS topics this tenant's SES events may arrive from (fail-closed allowlist). */
admin.put('/tenants/:slug/sns-topics', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { topicArns?: string[] } | null;
  const arns = b?.topicArns ?? [];
  if (!arns.every((a) => /^arn:aws(-[a-z]+)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/.test(a))) {
    return c.json({ error: 'invalid_topic_arn' }, 400);
  }
  const d = db(c.env.DB);
  const updated = await d.update(tenants).set({ snsTopicArns: JSON.stringify(arns) }).where(eq(tenants.slug, c.req.param('slug'))).returning({ id: tenants.id });
  return updated.length ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
});

/** Invite an owner. If they already have an account they become an owner now; otherwise on sign-up. */
admin.post('/tenants/:slug/owners', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { email?: string } | null;
  const email = normalizeEmail(b?.email ?? '');
  if (!isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400);
  const d = db(c.env.DB);
  const tenant = await d.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, c.req.param('slug'))).get();
  if (!tenant) return c.json({ error: 'not_found' }, 404);
  const user = await d.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  if (user) {
    await d.insert(memberships).values({ tenantId: tenant.id, userId: user.id, role: 'owner' }).onConflictDoNothing();
  } else {
    await d.insert(ownerInvites).values({ tenantId: tenant.id, email }).onConflictDoNothing();
  }
  return c.json({ ok: true, invited: !user }, 201);
});
