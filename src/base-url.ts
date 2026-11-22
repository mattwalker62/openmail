import type { Env } from './env';

/**
 * The env a request should see. In production PUBLIC_BASE_URL is fixed configuration and a request's
 * Host is never trusted. In a Cloudflare Worker Preview (OPENMAIL_PREVIEW=1, set only in the
 * `previews` block) each branch has its own address, so links, redirects and the OAuth issuer use the
 * address the request came in on.
 */
export function envForRequest(env: Env, request: Request): Env {
  if (env.OPENMAIL_PREVIEW !== '1') return env;
  return { ...env, PUBLIC_BASE_URL: new URL(request.url).origin };
}
