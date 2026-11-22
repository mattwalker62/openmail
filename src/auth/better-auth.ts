import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts, memberships, ownerInvites, sessions, users, verifications } from '../db/schema';
import type { Env } from '../env';
import { normalizeEmail } from '../lib/address';

/**
 * Owner accounts (Better Auth, email and password, as in OpenSEO and Dollop). Sign-up is closed: an
 * account can only be created for an email an admin invited to a tenant, and creating it turns every
 * invite for that email into an owner membership.
 */
export function createAuth(env: Env) {
  const d = db(env.DB);
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.PUBLIC_BASE_URL,
    database: drizzleAdapter(d, {
      provider: 'sqlite',
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const email = normalizeEmail(user.email);
            const invited = await d.select().from(ownerInvites).where(eq(ownerInvites.email, email)).get();
            if (!invited) throw new APIError('FORBIDDEN', { message: 'not_invited' });
            return { data: { ...user, email } };
          },
          after: async (user) => {
            const invites = await d.select().from(ownerInvites).where(eq(ownerInvites.email, user.email)).all();
            for (const inv of invites) {
              await d.batch([
                d.insert(memberships).values({ tenantId: inv.tenantId, userId: user.id, role: 'owner' }).onConflictDoNothing(),
                d.delete(ownerInvites).where(and(eq(ownerInvites.tenantId, inv.tenantId), eq(ownerInvites.email, inv.email))),
              ]);
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export interface Owner {
  userId: string;
  email: string;
  tenants: Array<{ id: string; name: string; slug: string }>;
}
