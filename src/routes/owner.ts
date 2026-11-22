import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { createAuth, type Owner } from '../auth/better-auth';
import { db } from '../db/client';
import { memberships, tenants } from '../db/schema';
import type { Env } from '../env';
import { escapeHtml, page } from '../ui/page';

export const owner = new Hono<{ Bindings: Env }>();

/** Only same-site paths: never let `next` send someone to another origin. */
const safeNext = (next: string | undefined) => (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/');

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

owner.get('/login', (c) => c.html(loginForm(safeNext(c.req.query('next')))));

owner.post('/login', async (c) => {
  const f = await c.req.parseBody();
  const next = safeNext(String(f.next ?? ''));
  const res = await createAuth(c.env).api.signInEmail({
    body: { email: String(f.email ?? ''), password: String(f.password ?? '') },
    asResponse: true,
  });
  if (!res.ok) return c.html(loginForm(next, 'That email and password do not match.'), 401);
  return redirectWithCookies(res, next);
});

const signupForm = (error = '') =>
  page(
    'Create your account',
    `<h1>Create your owner account</h1>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<form method="post">` +
      `<label>Name<input name="name" required></label><label>Email (the one you were invited with)<input name="email" type="email" required></label>` +
      `<label>Password (12+ characters)<input name="password" type="password" minlength="12" autocomplete="new-password" required></label><button type="submit">Create account</button></form>`,
  );

owner.get('/signup', (c) => c.html(signupForm()));

owner.post('/signup', async (c) => {
  const f = await c.req.parseBody();
  const res = await createAuth(c.env).api.signUpEmail({
    body: { name: String(f.name ?? ''), email: String(f.email ?? ''), password: String(f.password ?? '') },
    asResponse: true,
  });
  if (res.status === 403) return c.html(signupForm('This email has not been invited as an owner.'), 403);
  if (!res.ok) return c.html(signupForm('Could not create the account. Check the password length and try again.'), 400);
  return redirectWithCookies(res, '/');
});

owner.post('/logout', async (c) => {
  const res = await createAuth(c.env).api.signOut({ headers: c.req.raw.headers, asResponse: true });
  return redirectWithCookies(res, '/login');
});
