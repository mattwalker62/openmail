import { SELF } from 'cloudflare:test';

let n = 0;

/** Create a tenant through the admin endpoint and return its slug and first API key. */
export async function createTenant(): Promise<{ id: string; slug: string; apiKey: string }> {
  n += 1;
  const slug = `t${n}-${crypto.randomUUID().slice(0, 8)}`;
  const res = await SELF.fetch('https://openmail.test/admin/tenants', {
    method: 'POST',
    headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      slug,
      name: `Tenant ${n}`,
      fromAddress: `News <news@${slug}.example>`,
      secretPrefix: `SES_${slug.toUpperCase().replace(/-/g, '_')}`,
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
