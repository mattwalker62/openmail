import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createTenant } from '../helpers';

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
  redirect: 'manual' as const,
});

async function invite(slug: string, email: string) {
  const res = await SELF.fetch(`https://openmail.test/admin/tenants/${slug}/owners`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(201);
}

describe('owner accounts', () => {
  it('refuses sign-up for an email nobody invited', async () => {
    const res = await SELF.fetch('https://openmail.test/signup', form({ name: 'X', email: 'stranger@example.com', password: 'correct horse battery 1' }));
    expect(res.status).toBe(403);
    const n = await env.DB.prepare("select count(*) as n from user where email = 'stranger@example.com'").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('lets an invited owner sign up, makes them owner of the tenant, and signs them in', async () => {
    const t = await createTenant();
    await invite(t.slug, 'Owner@Example.com');

    const res = await SELF.fetch('https://openmail.test/signup', form({ name: 'Owner', email: 'owner@example.com', password: 'correct horse battery 2' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toMatch(/session_token=/);

    const m = await env.DB.prepare(
      "select m.role from memberships m join user u on u.id = m.user_id where u.email = 'owner@example.com' and m.tenant_id = ?",
    ).bind(t.id).first<{ role: string }>();
    expect(m?.role).toBe('owner');
  });
});

describe('/authorize (OAuth consent for MCP clients)', () => {
  it('sends a visitor without a session to sign in first', async () => {
    const res = await SELF.fetch(
      'https://openmail.test/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fclient.test%2Fcb&state=s&code_challenge=abc&code_challenge_method=S256',
      { redirect: 'manual' },
    );
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get('location')).toMatch(/^\/login\?next=/);
  });
});

describe('/mcp', () => {
  it('answers 401 with a WWW-Authenticate challenge when no token is sent', async () => {
    const res = await SELF.fetch('https://openmail.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
  });
});
