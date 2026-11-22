import { DurableObject } from 'cloudflare:workers';

/**
 * Token bucket for one tenant's bulk SES lane (one instance per lane, named "<tenantId>:bulk").
 * Each tenant brings its own SES account, so a lane's limit is never shared with another tenant.
 *
 * acquire() reserves `count` sends and returns how many milliseconds the caller must wait before
 * sending them. Tokens may go negative: that is the reservation the caller is waiting out.
 * Contract: callers send at most `perSecond` emails per acquire (the queue consumer splits its
 * batches), because a larger chunk would wait and then go out in one burst.
 * State is in memory; if the object is evicted the bucket restarts full, which can let one extra
 * second's burst through. SES answers that with a throttle, which the transport classifies as
 * retryable.
 *
 * The transactional lane never uses this: login mail must not queue behind campaigns.
 */
export class SendRateLimiter extends DurableObject {
  private tokens: number | null = null;
  private updatedAt = 0;

  async acquire(count: number, perSecond: number): Promise<number> {
    const now = Date.now();
    if (this.tokens === null) {
      this.tokens = perSecond;
    } else {
      const refill = ((now - this.updatedAt) / 1000) * perSecond;
      this.tokens = Math.min(perSecond, this.tokens + refill);
    }
    this.updatedAt = now;
    this.tokens -= count;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / perSecond) * 1000);
  }
}
