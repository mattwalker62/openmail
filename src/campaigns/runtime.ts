import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { tenants } from '../db/schema';
import type { Env } from '../env';
import { resolveLane } from '../transport/lanes';
import { sendViaSes } from '../transport/ses';
import type { DeliveryDeps } from './consumer';

/** Production wiring for the consumer: real SES on the tenant's bulk lane, paced by its Durable Object. */
export function deliveryDeps(env: Env): DeliveryDeps {
  return {
    async send(tenantId, email) {
      const tenant = await db(env.DB).select().from(tenants).where(eq(tenants.id, tenantId)).get();
      const lane = tenant && resolveLane(env, tenant, 'bulk');
      if (!lane) {
        return { ok: false, status: 0, error: 'bulk lane credentials missing', type: 'fatal', shouldRetry: false, shouldSuppress: false };
      }
      return sendViaSes(lane, email);
    },
    acquire: (tenantId, count, perSecond) =>
      env.SEND_RATE_LIMITER.get(env.SEND_RATE_LIMITER.idFromName(`${tenantId}:bulk`)).acquire(count, perSecond),
    sleep: (ms) => scheduler.wait(ms),
    publicBaseUrl: env.PUBLIC_BASE_URL,
  };
}
