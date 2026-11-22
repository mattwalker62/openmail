import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createTenant, signInOwner } from '../helpers';

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
  redirect: 'manual' as const,
});

async function invite(slug: string, email: string): Promise<string> {
  const res = await SELF.fetch(`https://openmail.test/admin/tenants/${slug}/owners`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(201);
  const { inviteUrl } = (await res.json()) as { inviteUrl: string };
  return new URL(inviteUrl).searchParams.get('invite')!;
}

describe('owner accounts', () => {
  it('refuses sign-up for an email nobody invited', async () => {
    const res = await SELF.fetch('https://openmail.test/signup', form({ name: 'X', email: 'stranger@example.com', password: 'correct horse battery 1' }));
    expect(res.status).toBe(403);
    const n = await env.DB.prepare("select count(*) as n from user where email = 'stranger@example.com'").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("refuses sign-up for an invited email without that invite's token, so knowing the email is not enough", async () => {
    const t = await createTenant();
    await invite(t.slug, 'target@example.com');

    const noToken = await SELF.fetch('https://openmail.test/signup', form({ name: 'X', email: 'target@example.com', password: 'correct horse battery 3' }));
    expect(noToken.status).toBe(403);
    const wrong = await SELF.fetch('https://openmail.test/signup', form({ name: 'X', email: 'target@example.com', password: 'correct horse battery 3', invite: 'not-the-token-0123456789' }));
    expect(wrong.status).toBe(403);
    const direct = await SELF.fetch('https://openmail.test/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://openmail.test' },
      body: JSON.stringify({ name: 'X', email: 'target@example.com', password: 'correct horse battery 3' }),
    });
    expect(direct.status).toBeGreaterThanOrEqual(400);
    const n = await env.DB.prepare("select count(*) as n from user where email = 'target@example.com'").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('lets an invited owner sign up with the invite token, makes them owner of the tenant, and signs them in', async () => {
    const t = await createTenant();
    const token = await invite(t.slug, 'Owner@Example.com');

    const res = await SELF.fetch('https://openmail.test/signup', form({ name: 'Owner', email: 'owner@example.com', password: 'correct horse battery 2', invite: token }));
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toMatch(/session_token=/);

    const m = await env.DB.prepare(
      "select m.role from memberships m join user u on u.id = m.user_id where u.email = 'owner@example.com' and m.tenant_id = ?",
    ).bind(t.id).first<{ role: string }>();
    expect(m?.role).toBe('owner');
  });
});

describe('sign-in redirects', () => {
  it.each(['//evil.example/x', '/\\evil.example', '/\t/evil.example', 'https://evil.example/', '/%0d%0a//evil.example'])(
    'never sends someone off-site after sign-in (next=%s)',
    async (next) => {
      const t = await createTenant();
      const { email } = await signInOwner(t.slug);
      const res = await SELF.fetch('https://openmail.test/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': `10.9.${Math.floor(Math.random() * 250)}.1` },
        body: JSON.stringify({ email, password: 'correct horse battery staple', next }),
      });
      expect(res.status).toBe(200);
      const { redirect } = (await res.json()) as { redirect: string };
      expect(redirect.startsWith('/') && !redirect.startsWith('//') && !redirect.includes('evil.example')).toBe(true);
      expect(res.headers.get('set-cookie')).toMatch(/session_token=/);
    },
  );

  it('answers a wrong password with 401 and a message, not a session', async () => {
    const res = await SELF.fetch('https://openmail.test/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.8.0.1' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong password here' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'That email and password do not match.' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('brute-force protection', () => {
  it('rate-limits repeated sign-in attempts for one email', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await SELF.fetch('https://openmail.test/login', form({ email: 'victim@example.com', password: `guess-${i}-xxxxxxxx` }));
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
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
