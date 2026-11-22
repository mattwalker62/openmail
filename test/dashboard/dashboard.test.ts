import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createDraft, requestCampaign } from '../../src/campaigns/service';
import { db } from '../../src/db/client';
import { api, asOwner, createTenant, formBody, signInOwner } from '../helpers';

async function pendingCampaign(slugTenant: { id: string; apiKey: string }, emails = ['a@x.com', 'b@x.com']) {
  for (const email of emails) {
    await api(slugTenant.apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email, lists: ['beacon'] }) });
  }
  const d = db(env.DB);
  const draft = await createDraft(d, slugTenant.id, { subject: 'Issue 1 <b>', html: '<p>Hello</p>' }, 'mcp');
  const req = await requestCampaign(d, { tenantId: slugTenant.id, keyId: 'mcp:u', origin: 'mcp' }, { draftId: draft.id, list: 'beacon' });
  return req.campaignId;
}

const status = (id: string) => env.DB.prepare('select status from campaigns where id = ?').bind(id).first<{ status: string }>().then((r) => r?.status);

describe('dashboard access', () => {
  it('sends a visitor without a session to sign in', async () => {
    const res = await SELF.fetch('https://openmail.test/', { redirect: 'manual' });
    expect(res.headers.get('location')).toMatch(/^\/login/);
  });

  it("refuses an owner looking at another tenant's dashboard", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const { cookie } = await signInOwner(a.slug);
    expect((await asOwner(cookie, `/t/${b.id}`)).status).toBe(403);
  });

  it('shows the overview with the campaign waiting for approval, escaped', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    const id = await pendingCampaign(t);

    const html = await (await asOwner(cookie, `/t/${t.id}`)).text();
    expect(html).toContain(`/approve/${id}`);
    expect(html).toContain('Issue 1 &lt;b&gt;');
    expect(html).not.toContain('Issue 1 <b>');
  });
});

describe('the approval page', () => {
  it('shows the exact intent on GET and approves nothing', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    const id = await pendingCampaign(t);

    const html = await (await asOwner(cookie, `/approve/${id}`)).text();
    expect(html).toContain('beacon');
    expect(html).toContain('2 recipients');
    expect(html).toContain('version 1');
    expect(await status(id)).toBe('awaiting_approval');
  });

  it('approves on POST from an owner session, freezing the snapshot', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    const id = await pendingCampaign(t);

    const res = await asOwner(cookie, `/approve/${id}`, formBody({}));
    expect(res.status).toBe(303);
    expect(await status(id)).toBe('approved');
    const n = await env.DB.prepare('select count(*) as n from campaign_recipients where campaign_id = ?').bind(id).first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it('refuses a POST without a session, from another tenant, or from another origin', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const id = await pendingCampaign(t);
    const { cookie: otherCookie } = await signInOwner(other.slug);
    const { cookie } = await signInOwner(t.slug);

    expect((await SELF.fetch(`https://openmail.test/approve/${id}`, { ...formBody({}), redirect: 'manual' })).status).toBe(303);
    expect((await asOwner(otherCookie, `/approve/${id}`, formBody({}))).status).toBe(403);
    expect((await asOwner(cookie, `/approve/${id}`, { ...formBody({}), headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect(await status(id)).toBe('awaiting_approval');
  });
});

describe('campaign controls', () => {
  it('pauses and cancels, and resends recipients whose delivery is unknown', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    const id = await pendingCampaign(t);
    await asOwner(cookie, `/approve/${id}`, formBody({}));

    await asOwner(cookie, `/t/${t.id}/campaigns/${id}/pause`, formBody({}));
    expect(await status(id)).toBe('paused');

    await env.DB.prepare("update campaign_recipients set status = 'unknown' where campaign_id = ?").bind(id).run();
    await env.DB.prepare("update campaigns set status = 'sent' where id = ?").bind(id).run();
    await asOwner(cookie, `/t/${t.id}/campaigns/${id}/resend-unknowns`, formBody({}));
    const left = await env.DB.prepare("select count(*) as n from campaign_recipients where campaign_id = ? and status = 'pending'").bind(id).first<{ n: number }>();
    expect(left?.n).toBe(2);
    expect(await status(id)).toBe('sending');

    await asOwner(cookie, `/t/${t.id}/campaigns/${id}/cancel`, formBody({}));
    expect(await status(id)).toBe('cancelled');
  });
});

describe('settings pages', () => {
  it('saves the context notes agents read, capped at 8,000 characters', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);

    await asOwner(cookie, `/t/${t.id}/context`, formBody({ context: 'Warm and short.' }));
    const row = await env.DB.prepare('select context from tenants where id = ?').bind(t.id).first<{ context: string }>();
    expect(row?.context).toBe('Warm and short.');
    expect((await asOwner(cookie, `/t/${t.id}/context`, formBody({ context: 'x'.repeat(8001) }))).status).toBe(400);
  });

  it('creates and revokes a standing policy for an app key', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    const keyId = (await env.DB.prepare('select id from api_keys where tenant_id = ?').bind(t.id).first<{ id: string }>())!.id;

    await asOwner(cookie, `/t/${t.id}/policies`, formBody({ apiKeyId: keyId, campaignType: 'daily', list: 'beacon', fromAddress: 'News <n@x.com>', maxPerDay: '1' }));
    const p = await env.DB.prepare('select id, revoked_at from policies where tenant_id = ?').bind(t.id).first<{ id: string; revoked_at: number | null }>();
    expect(p?.revoked_at).toBeNull();

    await asOwner(cookie, `/t/${t.id}/policies/${p!.id}/revoke`, formBody({}));
    const after = await env.DB.prepare('select revoked_at from policies where id = ?').bind(p!.id).first<{ revoked_at: number | null }>();
    expect(after?.revoked_at).not.toBeNull();
  });

  it('shows the MCP URL on the agent setup page and suppression counts by kind', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    await api(t.apiKey, '/v1/suppressions', { method: 'POST', body: JSON.stringify({ email: 'b@x.com', kind: 'hard_bounce' }) });

    expect(await (await asOwner(cookie, `/t/${t.id}/agent`)).text()).toContain('https://openmail.test/mcp');
    const sup = await (await asOwner(cookie, `/t/${t.id}/suppressions`)).text();
    expect(sup).toMatch(/hard_bounce[^0-9]*1/);
    expect(sup).not.toContain('b@x.com');
  });
});
