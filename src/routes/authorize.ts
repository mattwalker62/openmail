import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import type { Env } from '../env';
import { escapeHtml, page } from '../ui/page';
import { currentOwner } from './owner';

export const authorize = new Hono<{ Bindings: Env }>();

const encode = (v: unknown) => btoa(JSON.stringify(v));
const decode = <T>(v: string): T => JSON.parse(atob(v)) as T;

/**
 * OAuth consent for MCP clients (Claude, ChatGPT and others). The owner signs in, picks which of
 * their tenants the agent may draft for, and approves. The grant's props carry { userId, tenantId };
 * the MCP tools only ever act on that tenant, and none of them can approve or resume a send.
 */
authorize.get('/', async (c) => {
  const owner = await currentOwner(c);
  const url = new URL(c.req.url);
  if (!owner) return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  if (owner.tenants.length === 0) return c.html(page('No business', '<h1>No business to connect</h1><p>Your account does not own a business yet.</p>'), 403);

  let request: AuthRequest;
  try {
    request = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch {
    return c.html(page('Invalid request', '<h1>This sign-in link is not valid</h1>'), 400);
  }
  const client = await c.env.OAUTH_PROVIDER.lookupClient(request.clientId);
  const clientName = escapeHtml(client?.clientName ?? request.clientId);
  const options = owner.tenants.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
  return c.html(
    page(
      'Connect an agent',
      `<h1>Connect ${clientName}?</h1><p>${clientName} will be able to read your audiences, write drafts and ask you to approve a send. It can never approve or send anything itself.</p>` +
        `<form method="post"><input type="hidden" name="oauth" value="${escapeHtml(encode(request))}"><label>Business<select name="tenantId">${options}</select></label>` +
        `<button type="submit">Allow</button></form><p class="muted">Signed in as ${escapeHtml(owner.email)}.</p>`,
    ),
  );
});

authorize.post('/', async (c) => {
  const owner = await currentOwner(c);
  if (!owner) return c.redirect('/login', 302);
  const f = await c.req.parseBody();
  const tenantId = String(f.tenantId ?? '');
  if (!owner.tenants.some((t) => t.id === tenantId)) return c.html(page('Not allowed', '<h1>You do not own that business</h1>'), 403);

  let request: AuthRequest;
  try {
    request = decode<AuthRequest>(String(f.oauth ?? ''));
  } catch {
    return c.html(page('Invalid request', '<h1>This sign-in link is not valid</h1>'), 400);
  }
  // The form round-trips the request, so check it against the registered client before granting.
  const client = await c.env.OAUTH_PROVIDER.lookupClient(request.clientId);
  if (!client || !client.redirectUris.includes(request.redirectUri)) {
    return c.html(page('Invalid request', '<h1>This sign-in link is not valid</h1>'), 400);
  }
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request,
    userId: owner.userId,
    metadata: { tenantId },
    scope: request.scope,
    props: { userId: owner.userId, tenantId },
  });
  return c.redirect(redirectTo, 302);
});
