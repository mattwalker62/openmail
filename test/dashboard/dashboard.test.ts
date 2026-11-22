import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createDraft, requestCampaign } from '../../src/campaigns/service';
import { db } from '../../src/db/client';
import { api, asOwner, createTenant, signInOwner } from '../helpers';

async function pendingCampaign(t: { id: string; apiKey: string }, emails = ['a@x.com', 'b@x.com']) {
  for (const email of emails) {
    await api(t.apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email, lists: ['beacon'] }) });
  }
  const d = db(env.DB);
  const draft = await createDraft(d, t.id, { subject: 'Issue 1 <b>', html: '<p>Hello</p>' }, 'mcp');
  const req = await requestCampaign(d, { tenantId: t.id, keyId: 'mcp:u', origin: 'mcp' }, { draftId: draft.id, list: 'beacon' });
  return req.campaignId;
}

const status = (id: string) => env.DB.prepare('select status from campaigns where id = ?').bind(id).first<{ status: string }>().then((r) => r?.status);
const post = (cookie: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  asOwner(cookie, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as Record<string, any>;

describe('dashboard API access', () => {
  it('answers 401 without a session', async () => {
    expect((await SELF.fetch('https://openmail.test/api/me')).status).toBe(401);
  });

  it('lists the businesses the signed-in owner owns', async () => {
    const t = await createTenant();
    const { cookie, email } = await signInOwner(t.slug);
    expect(await json(await asOwner(cookie, '/api/me'))).toEqual({ email, tenants: [{ id: t.id, name: expect.any(String), slug: t.slug }] });
  });

  it("refuses an owner reading another business's overview", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const { cookie } = await signInOwner(a.slug);
    expect((await asOwner(cookie, `/api/t/${b.id}/overview`)).status).toBe(403);
  });

  it('returns the overview with the campaign waiting for approval', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    const id = await pendingCampaign(t);

    const body = await json(await asOwner(cookie, `/api/t/${t.id}/overview`));
    expect(body.waiting).toEqual([expect.objectContaining({ id, subject: 'Issue 1 <b>', list: 'beacon', requestedBy: 'agent' })]);
  });
});

describe('approval', () => {
  it('describes the exact intent on GET and approves nothing', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    const id = await pendingCampaign(t);

    const body = await json(await asOwner(cookie, `/api/approve/${id}`));
    expect(body).toMatchObject({ id, tenantId: t.id, list: 'beacon', recipients: 2, draftVersion: 1, canApprove: true, requestedBy: 'agent' });
    expect(await status(id)).toBe('awaiting_approval');
  });

  it('approves on POST from an owner session, freezing the snapshot', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    const id = await pendingCampaign(t);

    expect(await json(await post(cookie, `/api/approve/${id}`))).toEqual({ ok: true, recipientCount: 2 });
    expect(await status(id)).toBe('approved');
  });

  it('refuses a POST without a session, from another business, or from another origin', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const id = await pendingCampaign(t);
    const { cookie: otherCookie } = await signInOwner(other.slug);
    const { cookie } = await signInOwner(t.slug);

    expect((await SELF.fetch(`https://openmail.test/api/approve/${id}`, { method: 'POST' })).status).toBe(401);
    expect((await post(otherCookie, `/api/approve/${id}`)).status).toBe(403);
    expect((await post(cookie, `/api/approve/${id}`, {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect(await status(id)).toBe('awaiting_approval');
  });
});

describe('campaign controls', () => {
  it('pauses and cancels, and resends recipients whose delivery is unknown', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    const id = await pendingCampaign(t);
    await post(cookie, `/api/approve/${id}`);

    await post(cookie, `/api/t/${t.id}/campaigns/${id}/pause`);
    expect(await status(id)).toBe('paused');

    await env.DB.prepare("update campaign_recipients set status = 'unknown' where campaign_id = ?").bind(id).run();
    await env.DB.prepare("update campaigns set status = 'sent' where id = ?").bind(id).run();
    expect(await json(await post(cookie, `/api/t/${t.id}/campaigns/${id}/resend-unknowns`))).toEqual({ ok: true, requeued: 2 });
    expect(await status(id)).toBe('sending');

    await post(cookie, `/api/t/${t.id}/campaigns/${id}/cancel`);
    expect(await status(id)).toBe('cancelled');
  });
});

describe('settings', () => {
  it('saves the context notes agents read, capped at 8,000 characters', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);

    await asOwner(cookie, `/api/t/${t.id}/context`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: 'Warm and short.' }) });
    expect(await json(await asOwner(cookie, `/api/t/${t.id}/context`))).toEqual({ context: 'Warm and short.' });
    const tooLong = await asOwner(cookie, `/api/t/${t.id}/context`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: 'x'.repeat(8001) }) });
    expect(tooLong.status).toBe(400);
  });

  it('creates and revokes a standing policy for an app key', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    const { keys } = await json(await asOwner(cookie, `/api/t/${t.id}/policies`));

    await post(cookie, `/api/t/${t.id}/policies`, { apiKeyId: keys[0].id, campaignType: 'daily', list: 'beacon', fromAddress: 'News <n@x.com>', maxPerDay: 1 });
    const { policies } = await json(await asOwner(cookie, `/api/t/${t.id}/policies`));
    expect(policies).toEqual([expect.objectContaining({ campaignType: 'daily', list: 'beacon', revoked: false })]);

    await post(cookie, `/api/t/${t.id}/policies/${policies[0].id}/revoke`);
    const after = await json(await asOwner(cookie, `/api/t/${t.id}/policies`));
    expect(after.policies[0].revoked).toBe(true);
  });

  it('gives the MCP URL and suppression counts by kind, never addresses', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    await api(t.apiKey, '/v1/suppressions', { method: 'POST', body: JSON.stringify({ email: 'b@x.com', kind: 'hard_bounce' }) });

    expect(await json(await asOwner(cookie, `/api/t/${t.id}/agent`))).toEqual({ mcpUrl: 'https://openmail.test/mcp' });
    const sup = await asOwner(cookie, `/api/t/${t.id}/suppressions`);
    const text = await sup.text();
    expect(JSON.parse(text)).toEqual({ counts: [{ kind: 'hard_bounce', count: 1 }] });
    expect(text).not.toContain('b@x.com');
  });
});
