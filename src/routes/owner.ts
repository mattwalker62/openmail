import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { createAuth, type Owner } from '../auth/better-auth';
import { db } from '../db/client';
import { memberships, ownerInvites, tenants, users } from '../db/schema';
import { normalizeEmail, sha256Hex } from '../lib/address';
import type { Env } from '../env';

export const owner = new Hono<{ Bindings: Env }>();

/**
 * Only same-site paths: resolve `next` against our own origin the way a browser would (which strips
 * tabs and newlines) and keep just the path, so nothing can send someone to another site.
 */
function safeNext(next: string | undefined, base: string): string {
  try {
    const url = new URL(next || '/', base);
    if (url.origin !== new URL(base).origin) return '/';
    if (url.pathname.startsWith('//') || /%0[ad]|%09/i.test(url.pathname)) return '/';
    return url.pathname + url.search;
  } catch {
    return '/';
  }
}

/** Cloudflare's rate-limit binding: false when this key is over its limit. */
async function allowed(c: Context<{ Bindings: Env }>, ...keys: string[]): Promise<boolean> {
  for (const key of keys) {
    const { success } = await c.env.AUTH_LIMITER.limit({ key });
    if (!success) return false;
  }
  return true;
}
const clientIp = (c: Context<{ Bindings: Env }>) => c.req.header('cf-connecting-ip') ?? 'unknown';

/** The signed-in owner and their tenants, or null. */
export async function currentOwner(c: Context<{ Bindings: Env }>): Promise<Owner | null> {
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const rows = await db(c.env.DB)
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.userId, session.user.id))
    .all();
  return { userId: session.user.id, email: session.user.email, tenants: rows };
}

/** Copy Better Auth's session cookies onto our response. */
function withCookies(from: Response, to: Response): Response {
  for (const cookie of from.headers.getSetCookie()) to.headers.append('set-cookie', cookie);
  return to;
}

/** The React app serves the sign-in and sign-up pages; these routes only answer their posts. */
const servePage = (c: Context<{ Bindings: Env }>) => c.env.ASSETS.fetch(new Request(new URL('/', c.req.url)));
owner.get('/login', servePage);
owner.get('/signup', servePage);

/** Sign-in and sign-up accept JSON (the React pages) or a plain form post. */
async function fields(c: Context<{ Bindings: Env }>): Promise<Record<string, string>> {
  const raw = (c.req.header('content-type') ?? '').includes('application/json')
    ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
    : await c.req.parseBody();
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
}

/**
 * Success sends JSON callers the target and form posts a 303 there, with the session cookies either
 * way; failures are JSON with a message.
 */
function done(c: Context<{ Bindings: Env }>, auth: Response, redirect: string): Response {
  const wantsJson = (c.req.header('content-type') ?? '').includes('application/json');
  const res = wantsJson ? c.json({ ok: true, redirect }) : new Response(null, { status: 303, headers: { location: redirect } });
  return withCookies(auth, res);
}

owner.post('/login', async (c) => {
  const f = await fields(c);
  const next = safeNext(f.next, c.env.PUBLIC_BASE_URL);
  const email = normalizeEmail(f.email ?? '');
  if (!(await allowed(c, `ip:${clientIp(c)}`, `login:${email}`))) return c.json({ error: 'Too many attempts. Wait a minute and try again.' }, 429);
  const res = await createAuth(c.env).api.signInEmail({ body: { email: f.email ?? '', password: f.password ?? '' }, asResponse: true });
  if (!res.ok) return c.json({ error: 'That email and password do not match.' }, 401);
  return done(c, res, next);
});

/**
 * Create an owner account. Needs the single-use invite token issued for exactly this email; the
 * account becomes owner of that invite's tenant and the invite is consumed.
 */
owner.post('/signup', async (c) => {
  const f = await fields(c);
  const invite = f.invite ?? '';
  const email = normalizeEmail(f.email ?? '');
  if (!(await allowed(c, `ip:${clientIp(c)}`, `signup:${email}`))) return c.json({ error: 'Too many attempts. Wait a minute and try again.' }, 429);
  const d = db(c.env.DB);
  const row = invite
    ? await d
        .select()
        .from(ownerInvites)
        .where(eq(ownerInvites.tokenHash, await sha256Hex(invite)))
        .get()
    : undefined;
  if (!row || row.email !== email) return c.json({ error: 'This invite link is not valid for that email.' }, 403);

  const res = await createAuth(c.env).api.signUpEmail({ body: { name: f.name ?? '', email, password: f.password ?? '' }, asResponse: true });
  if (!res.ok) return c.json({ error: 'Could not create the account. Check the password length and try again.' }, 400);
  const user = await d.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  await d.batch([
    d.insert(memberships).values({ tenantId: row.tenantId, userId: user!.id, role: 'owner' }).onConflictDoNothing(),
    d.delete(ownerInvites).where(and(eq(ownerInvites.tenantId, row.tenantId), eq(ownerInvites.email, row.email))),
  ]);
  return done(c, res, '/');
});

owner.post('/logout', async (c) => {
  const res = await createAuth(c.env).api.signOut({ headers: c.req.raw.headers, asResponse: true });
  return withCookies(res, new Response(null, { status: 303, headers: { location: '/login' } }));
});
