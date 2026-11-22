import { SELF } from 'cloudflare:test';

let n = 0;

/** Create a tenant through the admin endpoint and return its slug and first API key. */
export async function createTenant(opts: { secretPrefix?: string } = {}): Promise<{ id: string; slug: string; apiKey: string }> {
  n += 1;
  const slug = `t${n}-${crypto.randomUUID().slice(0, 8)}`;
  const res = await SELF.fetch('https://openmail.test/admin/tenants', {
    method: 'POST',
    headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      slug,
      name: `Tenant ${n}`,
      fromAddress: `News <news@${slug}.example>`,
      secretPrefix: opts.secretPrefix ?? `SES_${slug.toUpperCase().replace(/-/g, '_')}`,
      txRegion: 'eu-central-1',
      txConfigurationSet: `${slug}-tx`,
      bulkRegion: 'eu-west-1',
      bulkConfigurationSet: `${slug}-bulk`,
    }),
  });
  if (res.status !== 201) throw new Error(`createTenant failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; slug: string; apiKey: string };
}

export function api(apiKey: string, path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://openmail.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...init.headers },
  });
}

let owners = 0;

/** Invite, sign up and return a session cookie for an owner of `slug`. */
export async function signInOwner(slug: string): Promise<{ cookie: string; email: string }> {
  owners += 1;
  const email = `owner${owners}-${crypto.randomUUID().slice(0, 6)}@example.com`;
  const inv = await SELF.fetch(`https://openmail.test/admin/tenants/${slug}/owners`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const { inviteUrl } = (await inv.json()) as { inviteUrl: string };
  const invite = new URL(inviteUrl).searchParams.get('invite')!;
  const res = await SELF.fetch('https://openmail.test/signup', {
    method: 'POST',
    // A distinct client per owner, so the per-IP sign-up limit doesn't trip across tests.
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': `10.0.0.${owners}` },
    body: new URLSearchParams({ name: 'Owner', email, password: 'correct horse battery staple', invite }).toString(),
    redirect: 'manual',
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`sign-up failed: ${res.status}`);
  return { cookie, email };
}

export function asOwner(cookie: string, path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://openmail.test${path}`, {
    redirect: 'manual',
    ...init,
    headers: { cookie, origin: 'https://openmail.test', ...init.headers },
  });
}

export const formBody = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});
