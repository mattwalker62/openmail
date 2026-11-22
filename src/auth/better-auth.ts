import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts, ownerInvites, sessions, users, verifications } from '../db/schema';
import type { Env } from '../env';
import { normalizeEmail } from '../lib/address';

/**
 * Owner accounts (Better Auth, email and password, as in OpenSEO and Dollop). Sign-up is closed:
 * Better Auth's own sign-up endpoint is disabled over HTTP, and the /signup route creates an account
 * only with a valid single-use invite token for that email (it then grants the membership). The hook
 * below is a second guard for any other path.
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
    disabledPaths: ['/sign-up/email'],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const email = normalizeEmail(user.email);
            const invited = await d.select().from(ownerInvites).where(eq(ownerInvites.email, email)).get();
            if (!invited) throw new APIError('FORBIDDEN', { message: 'not_invited' });
            return { data: { ...user, email } };
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
