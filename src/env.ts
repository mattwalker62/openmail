import type { SendRateLimiter } from './rate-limit/send-rate-limiter';

export interface Env {
  DB: D1Database;
  SEND_RATE_LIMITER: DurableObjectNamespace<SendRateLimiter>;
  /** Bootstrap token for /admin (creating tenants); a Worker secret from Infisical. */
  ADMIN_API_TOKEN: string;
  /** This Worker's public origin, used in unsubscribe links (Infisical config, e.g. https://mail.example.com). */
  PUBLIC_BASE_URL: string;
  SEND_QUEUE: Queue<import('./campaigns/reconciler').PageMessage>;
}
