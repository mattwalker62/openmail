import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { SendRateLimiter } from './rate-limit/send-rate-limiter';

export interface Env {
  DB: D1Database;
  SEND_RATE_LIMITER: DurableObjectNamespace<SendRateLimiter>;
  /** Bootstrap token for /admin (creating tenants); a Worker secret from Infisical. */
  ADMIN_API_TOKEN: string;
  /** This Worker's public origin, used in unsubscribe links (Infisical config, e.g. https://mail.example.com). */
  PUBLIC_BASE_URL: string;
  SEND_QUEUE: Queue<import('./campaigns/reconciler').PageMessage>;
  /** Signs owner sessions (Better Auth); a Worker secret from Infisical. */
  BETTER_AUTH_SECRET: string;
  /** OAuth grants and tokens for MCP clients (stored hashed by workers-oauth-provider). */
  OAUTH_KV: KVNamespace;
  /** Cloudflare rate limiter for /login and /signup, per IP and per email. */
  AUTH_LIMITER: RateLimit;
  /** The built React app (dist/client): the dashboard, sign-in and sign-up pages. */
  ASSETS: Fetcher;
  /** "1" only in Cloudflare Worker Previews (set in wrangler's `previews` block). */
  OPENMAIL_PREVIEW?: string;
  /** Injected by OAuthProvider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
}
