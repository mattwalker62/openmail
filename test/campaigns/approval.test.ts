import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approveCampaign, createDraft, createPolicy, requestCampaign, updateDraft } from '../../src/campaigns/service';
import { db } from '../../src/db/client';
import { api, createTenant } from '../helpers';

const HOUR = 60 * 60 * 1000;

async function tenantWithList(emails: string[], list = 'beacon') {
  const t = await createTenant();
  for (const email of emails) {
    await api(t.apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email, lists: [list] }) });
  }
  const keyId = (await env.DB.prepare('select id from api_keys where tenant_id = ?').bind(t.id).first<{ id: string }>())!.id;
  return { ...t, keyId, d: db(env.DB) };
}

const recipients = (campaignId: string) =>
  env.DB.prepare('select email, status from campaign_recipients where campaign_id = ? order by email')
    .bind(campaignId)
    .all<{ email: string; status: string }>()
    .then((r) => r.results);

describe('human approval of a send intent', () => {
  it('needs approval, then freezes the recipients (minus suppressed and unsubscribed) and opens a dispatch', async () => {
    const t = await tenantWithList(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
    await api(t.apiKey, '/v1/suppressions', { method: 'POST', body: JSON.stringify({ email: 'b@x.com', kind: 'hard_bounce' }) });
    await env.DB.prepare('update contacts set unsubscribed_at = ? where email = ? and tenant_id = ?').bind(Date.now(), 'c@x.com', t.id).run();
    const draft = await createDraft(t.d, t.id, { subject: 'Issue 1', html: '<p>1</p>' }, 'api');

    const req = await requestCampaign(t.d, { tenantId: t.id, keyId: t.keyId, origin: 'api' }, { draftId: draft.id, list: 'beacon' });
    expect(req.status).toBe('needs_approval');
    expect(await recipients(req.campaignId)).toEqual([]);

    const ok = await approveCampaign(t.d, req.campaignId, 'owner-1');
    expect(ok).toEqual({ ok: true, recipientCount: 2 });
    expect(await recipients(req.campaignId)).toEqual([
      { email: 'a@x.com', status: 'pending' },
      { email: 'd@x.com', status: 'pending' },
    ]);
    const dispatch = await env.DB.prepare('select done from dispatches where campaign_id = ?').bind(req.campaignId).first();
    expect(dispatch).toEqual({ done: 0 });
  });

  it('voids the approval when the draft changes after it', async () => {
    const t = await tenantWithList(['a@x.com']);
    const draft = await createDraft(t.d, t.id, { subject: 's', html: '<p>v1</p>' }, 'api');
    const req = await requestCampaign(t.d, { tenantId: t.id, keyId: t.keyId, origin: 'api' }, { draftId: draft.id, list: 'beacon' });
    await approveCampaign(t.d, req.campaignId, 'owner-1');

    await updateDraft(t.d, t.id, draft.id, { html: '<p>v2</p>' });

    const row = await env.DB.prepare('select status from campaigns where id = ?').bind(req.campaignId).first<{ status: string }>();
    expect(row?.status).toBe('awaiting_approval');
    expect(await recipients(req.campaignId)).toEqual([]);
    const dispatch = await env.DB.prepare('select count(*) as n from dispatches where campaign_id = ?').bind(req.campaignId).first<{ n: number }>();
    expect(dispatch?.n).toBe(0);
  });

  it('refuses an approval more than 24 hours after the request', async () => {
    const t = await tenantWithList(['a@x.com']);
    const draft = await createDraft(t.d, t.id, { subject: 's', html: 'h' }, 'api');
    const req = await requestCampaign(t.d, { tenantId: t.id, keyId: t.keyId, origin: 'api' }, { draftId: draft.id, list: 'beacon' });

    const late = await approveCampaign(t.d, req.campaignId, 'owner-1', Date.now() + 25 * HOUR);
    expect(late).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('standing approval policies', () => {
  async function withPolicy(emails: string[]) {
    const t = await tenantWithList(emails);
    await createPolicy(t.d, t.id, { apiKeyId: t.keyId, campaignType: 'daily', list: 'beacon', fromAddress: 'News <news@x.com>', maxPerDay: 2 });
    const send = async (overrides: { list?: string; origin?: 'api' | 'mcp' } = {}) => {
      const draft = await createDraft(t.d, t.id, { subject: 'Daily', html: '<p>d</p>' }, 'api');
      return requestCampaign(
        t.d,
        { tenantId: t.id, keyId: t.keyId, origin: overrides.origin ?? 'api' },
        { draftId: draft.id, list: overrides.list ?? 'beacon', campaignType: 'daily', fromAddress: 'News <news@x.com>' },
      );
    };
    return { t, send };
  }

  it('needs a human approval for the first send, which becomes the baseline; later sends go out unattended', async () => {
    const { t, send } = await withPolicy(['a@x.com', 'b@x.com']);

    const first = await send();
    expect(first.status).toBe('needs_approval');
    await approveCampaign(t.d, first.campaignId, 'owner-1');

    const second = await send();
    expect(second.status).toBe('approved');
    expect(await recipients(second.campaignId)).toHaveLength(2);
  });

  it('pauses when the same-size list has swapped its members', async () => {
    const emails = Array.from({ length: 10 }, (_, i) => `m${i}@x.com`);
    const { t, send } = await withPolicy(emails);
    await approveCampaign(t.d, (await send()).campaignId, 'owner-1');

    // Swap two of ten members: 20% of addresses changed, count unchanged.
    await api(t.apiKey, '/v1/contacts/erase', { method: 'POST', body: JSON.stringify({ email: 'm0@x.com' }) });
    await api(t.apiKey, '/v1/contacts/erase', { method: 'POST', body: JSON.stringify({ email: 'm1@x.com' }) });
    await api(t.apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email: 'n0@x.com', lists: ['beacon'] }) });
    await api(t.apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email: 'n1@x.com', lists: ['beacon'] }) });

    const next = await send();
    expect(next.status).toBe('paused');
  });

  it('sends unattended when the list grew by under 10% since the last policy send', async () => {
    const emails = Array.from({ length: 20 }, (_, i) => `g${i}@x.com`);
    const { t, send } = await withPolicy(emails);
    await approveCampaign(t.d, (await send()).campaignId, 'owner-1');
    await api(t.apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email: 'new@x.com', lists: ['beacon'] }) });

    expect((await send()).status).toBe('approved');
  });

  it('falls back to human approval for another list, over the daily cap, and for anything an agent drafted', async () => {
    const { t, send } = await withPolicy(['a@x.com']);
    await approveCampaign(t.d, (await send()).campaignId, 'owner-1');

    expect((await send({ list: 'other' })).status).toBe('needs_approval');
    expect((await send({ origin: 'mcp' })).status).toBe('needs_approval');
    expect((await send()).status).toBe('approved'); // second of max 2 today
    expect((await send()).status).toBe('needs_approval'); // over the cap
  });
});
