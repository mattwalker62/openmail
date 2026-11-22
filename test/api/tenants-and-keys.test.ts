import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, createTenant } from '../helpers';

describe('POST /admin/tenants', () => {
  it('refuses a request without the admin token', async () => {
    const res = await SELF.fetch('https://openmail.test/admin/tenants', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('creates a tenant and returns its first API key once, storing only a hash', async () => {
    const t = await createTenant();

    expect(t.apiKey).toMatch(/^om_[A-Za-z0-9_-]{40,}$/);
    const { env } = await import('cloudflare:test');
    const row = await env.DB.prepare('select key_hash from api_keys where tenant_id = ?').bind(t.id).first<{ key_hash: string }>();
    expect(row?.key_hash).toBeTruthy();
    expect(row?.key_hash).not.toContain(t.apiKey);
  });

  it('refuses a region that is not an AWS region name', async () => {
    const res = await SELF.fetch('https://openmail.test/admin/tenants', {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'bad-region', name: 'x', fromAddress: 'x@x.example', secretPrefix: 'SES_X',
        txRegion: 'evil.example.com', txConfigurationSet: 'a', bulkRegion: 'eu-west-1', bulkConfigurationSet: 'b',
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('API key authentication', () => {
  it('answers 401 without a key, with an unknown key, and with a revoked key', async () => {
    const t = await createTenant();
    expect((await SELF.fetch('https://openmail.test/v1/contacts', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await api('om_unknownkeyunknownkeyunknownkeyunknownkey12', '/v1/contacts', { method: 'POST', body: '{}' })).status).toBe(401);

    const { env } = await import('cloudflare:test');
    await env.DB.prepare('update api_keys set revoked_at = ? where tenant_id = ?').bind(Date.now(), t.id).run();
    const res = await api(t.apiKey, '/v1/contacts', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com' }),
    });
    expect(res.status).toBe(401);
  });
});
