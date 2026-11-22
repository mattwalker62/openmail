import { Hono } from 'hono';
import type { Env } from './env';
import { admin } from './routes/admin';
import { v1 } from './routes/v1';
import { sesEvents } from './routes/ses-events';
import { unsubscribe } from './routes/unsubscribe';
import { authorize } from './routes/authorize';
import { owner } from './routes/owner';
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { mcpApiHandler } from './mcp/handler';
import { processPage } from './campaigns/consumer';
import { reconcile, type PageMessage } from './campaigns/reconciler';
import { deliveryDeps } from './campaigns/runtime';
import { db } from './db/client';
import { createAuth } from './auth/better-auth';

const app = new Hono<{ Bindings: Env }>();

// Liveness plus a real round trip to D1, so a broken binding shows up here first.
app.get('/health', async (c) => {
  await c.env.DB.prepare('select 1').first();
  return c.json({ ok: true, db: 'ok' });
});

app.route('/admin', admin);
app.route('/v1', v1);
app.route('/ses', sesEvents);
app.route('/u', unsubscribe);
app.route('/authorize', authorize);
app.route('/', owner);
app.on(['GET', 'POST'], '/api/auth/*', (c) => createAuth(c.env).handler(c.req.raw));

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export { SendRateLimiter } from './rate-limit/send-rate-limiter';

/**
 * OAuth 2.1 for MCP clients (workers-oauth-provider, one Worker): /mcp needs a token and reaches the
 * MCP tools with the owner's grant; everything else is the app, which owns /authorize.
 */
let oauth: OAuthProvider<Env> | undefined;
function oauthProvider(env: Env): OAuthProvider<Env> {
  oauth ??= new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: mcpApiHandler as never,
    defaultHandler: { fetch: (request: Request, e: Env, ctx: ExecutionContext) => app.fetch(request, e, ctx) } as never,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: ['mcp'],
    requiredScopes: ['mcp'],
    resourceMetadata: { resource: `${env.PUBLIC_BASE_URL}/mcp`, authorization_servers: [env.PUBLIC_BASE_URL] },
  });
  return oauth;
}

export default {
  fetch: (request, env, ctx) => oauthProvider(env).fetch(request, env, ctx),

  /** Every minute: publish due campaign pages from the dispatch outbox (eng review D10). */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(reconcile(db(env.DB), async (msg) => void (await env.SEND_QUEUE.send(msg)), Date.now()));
  },

  async queue(batch, env) {
    if (batch.queue.endsWith('-dlq')) {
      // Pages that failed every retry. Their recipients are still pending, so the reconciler
      // re-publishes them after its lease; log so the owner can see a lane that keeps failing.
      for (const m of batch.messages) console.error('dead-lettered page', JSON.stringify(m.body));
      batch.ackAll();
      return;
    }
    const deps = deliveryDeps(env);
    for (const m of batch.messages) {
      await processPage(db(env.DB), deps, m.body, Date.now());
      m.ack();
    }
  },
} satisfies ExportedHandler<Env, PageMessage>;
