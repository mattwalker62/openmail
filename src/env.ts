import type { SendRateLimiter } from './rate-limit/send-rate-limiter';

export interface Env {
  DB: D1Database;
  SEND_RATE_LIMITER: DurableObjectNamespace<SendRateLimiter>;
}
