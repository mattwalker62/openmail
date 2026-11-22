import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// One limiter per tenant bulk lane: tenants bring their own SES accounts, so lanes never share a limit.
const limiterFor = (lane: string) => env.SEND_RATE_LIMITER.get(env.SEND_RATE_LIMITER.idFromName(lane));

describe('SendRateLimiter', () => {
  it('grants a full second of sends at once, then makes the next batch wait about a second', async () => {
    const limiter = limiterFor('tenant-a:bulk');

    expect(await limiter.acquire(14, 14)).toBe(0);
    const wait = await limiter.acquire(14, 14);
    expect(wait).toBeGreaterThan(900);
    expect(wait).toBeLessThanOrEqual(1000);
  });

  it('keeps each lane separate', async () => {
    expect(await limiterFor('tenant-b:bulk').acquire(14, 14)).toBe(0);
    expect(await limiterFor('tenant-c:bulk').acquire(14, 14)).toBe(0);
  });

  it('reserves an oversized batch in full, so the next caller waits for it', async () => {
    const wait = await limiterFor('tenant-d:bulk').acquire(28, 14);
    expect(wait).toBeGreaterThan(900);
    expect(wait).toBeLessThanOrEqual(1000);
  });
});
