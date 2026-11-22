import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { createAuth, type Owner } from '../auth/better-auth';
import { db } from '../db/client';
import { memberships, ownerInvites, tenants, users } from '../db/schema';
import { normalizeEmail, sha256Hex } from '../lib/address';
import type { Env } from '../env';
import { escapeHtml, page } from '../ui/page';

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

/** Pass Better Auth's response cookies through on a redirect. */
function redirectWithCookies(from: Response, location: string): Response {
  const headers = new Headers({ location });
  for (const cookie of from.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

const loginForm = (next: string, error = '') =>
  page(
    'Sign in',
    `<h1>Sign in</h1>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<form method="post">` +
      `<input type="hidden" name="next" value="${escapeHtml(next)}"><label>Email<input name="email" type="email" autocomplete="email" required></label>` +
      `<label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form>` +
      `<p class="muted">Invited as an owner? <a href="/signup">Create your account</a>.</p>`,
  );

owner.get('/login', (c) => c.html(loginForm(safeNext(c.req.query('next'), c.env.PUBLIC_BASE_URL))));

owner.post('/login', async (c) => {
  const f = await c.req.parseBody();
  const next = safeNext(String(f.next ?? ''), c.env.PUBLIC_BASE_URL);
  const email = normalizeEmail(String(f.email ?? ''));
  if (!(await allowed(c, `ip:${clientIp(c)}`, `login:${email}`))) return c.html(loginForm(next, 'Too many attempts. Wait a minute and try again.'), 429);
  const res = await createAuth(c.env).api.signInEmail({
    body: { email: String(f.email ?? ''), password: String(f.password ?? '') },
    asResponse: true,
  });
  if (!res.ok) return c.html(loginForm(next, 'That email and password do not match.'), 401);
  return redirectWithCookies(res, next);
});

const signupForm = (invite: string, error = '') =>
  page(
    'Create your account',
    `<h1>Create your owner account</h1>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<form method="post">` +
      `<input type="hidden" name="invite" value="${escapeHtml(invite)}">` +
      `<label>Name<input name="name" required></label><label>Email (the one you were invited with)<input name="email" type="email" required></label>` +
      `<label>Password (12+ characters)<input name="password" type="password" minlength="12" autocomplete="new-password" required></label><button type="submit">Create account</button></form>`,
  );

owner.get('/signup', (c) => c.html(signupForm(c.req.query('invite') ?? '')));

/**
 * Create an owner account. Needs the single-use invite token issued for exactly this email; the
 * account becomes owner of that invite's tenant and the invite is consumed.
 */
owner.post('/signup', async (c) => {
  const f = await c.req.parseBody();
  const invite = String(f.invite ?? '');
  const email = normalizeEmail(String(f.email ?? ''));
  if (!(await allowed(c, `ip:${clientIp(c)}`, `signup:${email}`))) return c.html(signupForm(invite, 'Too many attempts. Wait a minute and try again.'), 429);
  const d = db(c.env.DB);
  const row = invite
    ? await d
        .select()
        .from(ownerInvites)
        .where(eq(ownerInvites.tokenHash, await sha256Hex(invite)))
        .get()
    : undefined;
  if (!row || row.email !== email) return c.html(signupForm(invite, 'This invite link is not valid for that email.'), 403);

  const res = await createAuth(c.env).api.signUpEmail({
    body: { name: String(f.name ?? ''), email, password: String(f.password ?? '') },
    asResponse: true,
  });
  if (!res.ok) return c.html(signupForm(invite, 'Could not create the account. Check the password length and try again.'), 400);
  const user = await d.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  await d.batch([
    d.insert(memberships).values({ tenantId: row.tenantId, userId: user!.id, role: 'owner' }).onConflictDoNothing(),
    d.delete(ownerInvites).where(and(eq(ownerInvites.tenantId, row.tenantId), eq(ownerInvites.email, row.email))),
  ]);
  return redirectWithCookies(res, '/');
});

owner.post('/logout', async (c) => {
  const res = await createAuth(c.env).api.signOut({ headers: c.req.raw.headers, asResponse: true });
  return redirectWithCookies(res, '/login');
});
