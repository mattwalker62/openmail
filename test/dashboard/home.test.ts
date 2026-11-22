import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approveCampaign, createDraft, requestCampaign } from '../../src/campaigns/service';
import { db } from '../../src/db/client';
import { api, asOwner, createTenant, signInOwner } from '../helpers';

const DAY = 24 * 60 * 60 * 1000;
const home = async (cookie: string, tenantId: string, days = 7) =>
  (await (await asOwner(cookie, `/api/t/${tenantId}/home?days=${days}`)).json()) as Record<string, any>;

describe('GET /api/t/:id/home', () => {
  it('counts this period: new subscribers, sends, approvals waiting, scheduled and new bounces/complaints', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    for (const e of ['a', 'b', 'c', 'd']) {
      await api(t.apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email: `${e}@x.com`, lists: ['beacon'] }) });
    }
    // One contact signed up 20 days ago: not new this week.
    await env.DB.prepare("update contacts set created_at = ? where tenant_id = ? and email = 'd@x.com'").bind(Date.now() - 20 * DAY, t.id).run();
    const d = db(env.DB);
    const keyId = (await env.DB.prepare('select id from api_keys where tenant_id = ?').bind(t.id).first<{ id: string }>())!.id;
    const draft = await createDraft(d, t.id, { subject: 'Sent one', html: 'h' }, 'api');
    const sent = await requestCampaign(d, { tenantId: t.id, keyId, origin: 'api' }, { draftId: draft.id, list: 'beacon' });
    await approveCampaign(d, sent.campaignId, 'owner');
    await env.DB.prepare("update campaign_recipients set status = 'sent', claimed_at = ? where campaign_id = ?").bind(Date.now() - DAY, sent.campaignId).run();
    await env.DB.prepare("update campaigns set status = 'sent' where id = ?").bind(sent.campaignId).run();
    const waiting = await createDraft(d, t.id, { subject: 'Waiting one', html: 'h' }, 'mcp');
    await requestCampaign(d, { tenantId: t.id, keyId: 'mcp:u', origin: 'mcp' }, { draftId: waiting.id, list: 'beacon' });
    const later = await createDraft(d, t.id, { subject: 'Later one', html: 'h' }, 'api');
    const sched = await requestCampaign(d, { tenantId: t.id, keyId, origin: 'api' }, { draftId: later.id, list: 'beacon', scheduledAt: Date.now() + 3 * DAY });
    await approveCampaign(d, sched.campaignId, 'owner');
    await api(t.apiKey, '/v1/suppressions', { method: 'POST', body: JSON.stringify({ email: 'a@x.com', kind: 'hard_bounce' }) });
    await api(t.apiKey, '/v1/suppressions', { method: 'POST', body: JSON.stringify({ email: 'b@x.com', kind: 'unsubscribe' }) });

    const h = await home(cookie, t.id);
    expect(h.period).toEqual({ newSubscribers: 3, emailsSent: 4, awaitingApproval: 1, scheduled: 1, bouncesAndComplaints: 1 });
    expect(h.totals).toEqual({ contacts: 4, contactsAtStart: 1 });
    expect(h.scorecard).toEqual({ sent: 4, bounceRate: 0.25, complaintRate: 0, unsubscribeRate: 0.25 });
    expect(h.recent.lastSend).toMatchObject({ subject: 'Sent one', delivered: 4 });
    expect(h.recent.lastSignup).toMatchObject({ email: expect.stringMatching(/@x\.com$/) });
    expect(h.contactsOverTime).toHaveLength(7);
    expect(h.contactsOverTime.at(-1).total).toBe(4);
  });

  it('gives no rates when nothing was sent in the period, instead of fake zeros', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    const h = await home(cookie, t.id);
    expect(h.scorecard).toEqual({ sent: 0, bounceRate: null, complaintRate: null, unsubscribeRate: null });
    expect(h.recent).toEqual({ lastSend: null, lastSignup: null });
  });

  it('recommends approving what waits, finishing unsent drafts and adding voice notes', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    await api(t.apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email: 'a@x.com', lists: ['beacon'] }) });
    const d = db(env.DB);
    await createDraft(d, t.id, { subject: 'Half written', html: 'h' }, 'mcp');
    const w = await createDraft(d, t.id, { subject: 'Waiting', html: 'h' }, 'mcp');
    await requestCampaign(d, { tenantId: t.id, keyId: 'mcp:u', origin: 'mcp' }, { draftId: w.id, list: 'beacon' });

    const kinds = (await home(cookie, t.id)).recommendations.map((r: { kind: string }) => r.kind);
    expect(kinds).toEqual(['approve', 'finish_draft', 'write_to_readers', 'add_context']);
  });

  it("refuses another business's dashboard and clamps the range to 7, 30 or 90 days", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const { cookie } = await signInOwner(a.slug);
    expect((await asOwner(cookie, `/api/t/${b.id}/home`)).status).toBe(403);
    expect((await home(cookie, a.id, 9999)).days).toBe(90);
    expect((await home(cookie, a.id, 30)).contactsOverTime).toHaveLength(30);
  });
});
