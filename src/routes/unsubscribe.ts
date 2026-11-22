import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client';
import { contacts, suppressions, tenants } from '../db/schema';
import type { Env } from '../env';
import { addressHash } from '../lib/address';

export const unsubscribe = new Hono<{ Bindings: Env }>();

const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1a1a1a}` +
  `button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;cursor:pointer}</style></head>` +
  `<body>${body}</body></html>`;

async function find(c: { env: Env }, tenantId: string, token: string) {
  return db(c.env.DB)
    .select({ id: contacts.id, tenantId: contacts.tenantId, email: contacts.email, tenantName: tenants.name })
    .from(contacts)
    .innerJoin(tenants, eq(tenants.id, contacts.tenantId))
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.unsubscribeToken, token)))
    .get();
}

/** Unsubscribe a contact from campaigns: login mail still reaches them. */
export async function markUnsubscribed(env: Env, contact: { id: string; tenantId: string; email: string }) {
  const d = db(env.DB);
  await d.batch([
    d.update(contacts).set({ unsubscribedAt: new Date() }).where(eq(contacts.id, contact.id)),
    d.insert(suppressions).values({ tenantId: contact.tenantId, addressHash: await addressHash(contact.email), kind: 'unsubscribe' }).onConflictDoNothing(),
  ]);
}

/** The footer link. Following it changes nothing (mail scanners follow links); the button posts. */
unsubscribe.get('/:tenantId/:token', async (c) => {
  const contact = await find(c, c.req.param('tenantId'), c.req.param('token'));
  if (!contact) return c.html(page('Link not found', '<h1>Link not found</h1><p>This unsubscribe link is not valid.</p>'), 404);
  const name = escapeHtml(contact.tenantName);
  return c.html(
    page(`Unsubscribe from ${contact.tenantName}`, `<h1>Unsubscribe from ${name}?</h1><p>You will stop getting ${name} newsletters. Account emails, like sign-in links, still arrive.</p><form method="post"><button type="submit">Unsubscribe</button></form>`),
  );
});

/** The form button and RFC 8058 one-click (`List-Unsubscribe=One-Click`) both land here. */
unsubscribe.post('/:tenantId/:token', async (c) => {
  const contact = await find(c, c.req.param('tenantId'), c.req.param('token'));
  if (!contact) return c.html(page('Link not found', '<h1>Link not found</h1>'), 404);
  await markUnsubscribed(c.env, contact);
  return c.html(page('Unsubscribed', `<h1>You're unsubscribed</h1><p>You won't get ${escapeHtml(contact.tenantName)} newsletters any more.</p>`));
});
