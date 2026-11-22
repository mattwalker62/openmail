import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { processPage, type DeliveryDeps } from '../../src/campaigns/consumer';
import { reconcile } from '../../src/campaigns/reconciler';
import { approveCampaign, createDraft, requestCampaign, setCampaignStatus } from '../../src/campaigns/service';
import { db } from '../../src/db/client';
import { addressHash } from '../../src/lib/address';
import type { SendResult } from '../../src/transport/ses';
import { api, createTenant } from '../helpers';

const LEASE_MS = 2 * 60 * 1000;

async function approvedCampaign(count: number) {
  const t = await createTenant();
  // Seed through the API once (creates the list), then in one D1 batch: hundreds of HTTP calls are slow.
  await api(t.apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email: 'r000@x.com', lists: ['beacon'] }) });
  const list = (await env.DB.prepare('select id from lists where tenant_id = ?').bind(t.id).first<{ id: string }>())!.id;
  const rows = [];
  for (let i = 1; i < count; i++) {
    const id = crypto.randomUUID();
    const email = `r${String(i).padStart(3, '0')}@x.com`;
    rows.push(
      env.DB.prepare('insert into contacts (id, tenant_id, email, address_hash, unsubscribe_token) values (?, ?, ?, ?, ?)').bind(id, t.id, email, await addressHash(email), crypto.randomUUID()),
      env.DB.prepare('insert into list_members (list_id, contact_id) values (?, ?)').bind(list, id),
    );
  }
  if (rows.length) await env.DB.batch(rows);
  const keyId = (await env.DB.prepare('select id from api_keys where tenant_id = ?').bind(t.id).first<{ id: string }>())!.id;
  const d = db(env.DB);
  const draft = await createDraft(d, t.id, { subject: 'S', html: '<p>h</p>' }, 'api');
  const req = await requestCampaign(d, { tenantId: t.id, keyId, origin: 'api' }, { draftId: draft.id, list: 'beacon' });
  await approveCampaign(d, req.campaignId, 'owner-1');
  return { t, d, campaignId: req.campaignId, draftId: draft.id };
}

function deps(result: (to: string) => SendResult = () => ({ ok: true, messageId: 'm' })) {
  const sent: string[] = [];
  const acquired: number[] = [];
  const d: DeliveryDeps = {
    send: vi.fn(async (_tenantId, email) => {
      sent.push(email.to);
      return result(email.to);
    }),
    acquire: vi.fn(async (_tenantId, count) => {
      acquired.push(count);
      return 0;
    }),
    sleep: vi.fn(async () => {}),
    publicBaseUrl: 'https://openmail.test',
  };
  return { d, sent, acquired };
}

const statusOf = (campaignId: string) =>
  env.DB.prepare('select email, status from campaign_recipients where campaign_id = ? order by email')
    .bind(campaignId)
    .all<{ email: string; status: string }>()
    .then((r) => Object.fromEntries(r.results.map((x) => [x.email, x.status])));

const ids = (campaignId: string) =>
  env.DB.prepare('select contact_id from campaign_recipients where campaign_id = ? order by contact_id')
    .bind(campaignId)
    .all<{ contact_id: string }>()
    .then((r) => r.results.map((x) => x.contact_id));

describe('reconciler (dispatch outbox)', () => {
  it('publishes the snapshot in pages of at most 100 recipients and marks the campaign sending', async () => {
    const { d, campaignId } = await approvedCampaign(230);
    const published: Array<{ campaignId: string; contactIds: string[] }> = [];

    await reconcile(d, async (msg) => void (msg.campaignId === campaignId && published.push(msg)), Date.now());

    expect(published.map((p) => p.contactIds.length)).toEqual([100, 100, 30]);
    const c = await env.DB.prepare('select status from campaigns where id = ?').bind(campaignId).first<{ status: string }>();
    expect(c?.status).toBe('sending');
  });

  it('resumes from its checkpoint when publishing fails part-way through', async () => {
    const { d, campaignId } = await approvedCampaign(150);
    const first: string[][] = [];
    let calls = 0;
    await reconcile(d, async (msg) => {
      if (msg.campaignId !== campaignId) return;
      calls += 1;
      if (calls === 2) throw new Error('queue unavailable');
      first.push(msg.contactIds);
    }, Date.now()).catch(() => {});

    const rest: string[][] = [];
    await reconcile(d, async (msg) => void (msg.campaignId === campaignId && rest.push(msg.contactIds)), Date.now());

    expect(first.flat()).toHaveLength(100);
    expect(rest.flat()).toHaveLength(50);
    expect(new Set([...first.flat(), ...rest.flat()]).size).toBe(150);
  });

  it('re-publishes recipients still pending after a full pass once the lease has expired, then marks the campaign sent', async () => {
    const { d, campaignId } = await approvedCampaign(3);
    const now = Date.now();
    await reconcile(d, async () => {}, now); // published, but the message was lost

    // reconcile() serves every due campaign; collect only this test's pages.
    const again: string[][] = [];
    const mine = async (m: { campaignId: string; contactIds: string[] }) => {
      if (m.campaignId === campaignId) again.push(m.contactIds);
    };
    await reconcile(d, mine, now + LEASE_MS - 1);
    expect(again).toEqual([]);
    await reconcile(d, mine, now + LEASE_MS + 1);
    expect(again.flat()).toHaveLength(3);

    await env.DB.prepare("update campaign_recipients set status = 'sent' where campaign_id = ?").bind(campaignId).run();
    await reconcile(d, async () => {}, now + 3 * LEASE_MS);
    const c = await env.DB.prepare('select status from campaigns where id = ?').bind(campaignId).first<{ status: string }>();
    expect(c?.status).toBe('sent');
  });
});

describe('processPage (queue consumer)', () => {
  it('sends each pending recipient once with a one-click unsubscribe URL, pacing in chunks of the lane limit', async () => {
    const { d, campaignId, t } = await approvedCampaign(5);
    await env.DB.prepare('update tenants set bulk_per_second = 2 where id = ?').bind(t.id).run();
    const { d: dd, sent, acquired } = deps();

    await processPage(d, dd, { campaignId, contactIds: await ids(campaignId) }, Date.now());

    expect(sent).toHaveLength(5);
    expect(acquired).toEqual([2, 2, 1]);
    const firstCall = (dd.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(firstCall[1].unsubscribeUrl).toBe(`https://openmail.test/u/${t.id}/${(await env.DB.prepare('select unsubscribe_token from contacts where tenant_id = ? and email = ?').bind(t.id, firstCall[1].to).first<{ unsubscribe_token: string }>())!.unsubscribe_token}`);
    expect(Object.values(await statusOf(campaignId))).toEqual(['sent', 'sent', 'sent', 'sent', 'sent']);
  });

  it('lets exactly one of two racing consumers send a recipient', async () => {
    const { d, campaignId } = await approvedCampaign(1);
    const a = deps();
    const b = deps();
    const page = { campaignId, contactIds: await ids(campaignId) };

    await Promise.all([processPage(d, a.d, page, Date.now()), processPage(d, b.d, page, Date.now())]);

    expect(a.sent.length + b.sent.length).toBe(1);
  });

  it('on redelivery leaves a fresh sending row alone, marks an expired one unknown, and never resends either', async () => {
    const { d, campaignId } = await approvedCampaign(2);
    const [fresh, stale] = await ids(campaignId);
    const now = Date.now();
    await env.DB.prepare("update campaign_recipients set status = 'sending', claimed_at = ? where contact_id = ?").bind(now - 1000, fresh).run();
    await env.DB.prepare("update campaign_recipients set status = 'sending', claimed_at = ? where contact_id = ?").bind(now - LEASE_MS - 1, stale).run();
    const { d: dd, sent } = deps();

    await processPage(d, dd, { campaignId, contactIds: [fresh!, stale!] }, now);

    expect(sent).toEqual([]);
    const rows = await env.DB.prepare('select contact_id, status from campaign_recipients where campaign_id = ?').bind(campaignId).all<{ contact_id: string; status: string }>();
    const by = Object.fromEntries(rows.results.map((r) => [r.contact_id, r.status]));
    expect(by[fresh!]).toBe('sending');
    expect(by[stale!]).toBe('unknown');
  });

  it('returns a retryable failure to pending, and suppresses an address SES says will never work', async () => {
    const { d, campaignId, t } = await approvedCampaign(2);
    const { d: dd } = deps((to) =>
      to === 'r000@x.com'
        ? { ok: false, status: 503, error: 'busy', type: 'retryable', shouldRetry: true, shouldSuppress: false }
        : { ok: false, status: 400, error: 'on the suppression list', type: 'non_retryable', shouldRetry: false, shouldSuppress: true },
    );

    await processPage(d, dd, { campaignId, contactIds: await ids(campaignId) }, Date.now());

    expect(await statusOf(campaignId)).toEqual({ 'r000@x.com': 'pending', 'r001@x.com': 'failed_permanent' });
    const check = await api(t.apiKey, '/v1/suppressions/check?email=r001@x.com');
    expect(await check.json()).toEqual({ suppressed: true, kinds: ['hard_bounce'] });
  });

  it('sends nothing for a cancelled campaign, a draft changed since approval, or an address suppressed since the snapshot', async () => {
    const cancelled = await approvedCampaign(1);
    await setCampaignStatus(cancelled.d, cancelled.t.id, cancelled.campaignId, 'cancel');
    const c1 = deps();
    await processPage(cancelled.d, c1.d, { campaignId: cancelled.campaignId, contactIds: await ids(cancelled.campaignId) }, Date.now());
    expect(c1.sent).toEqual([]);

    const changed = await approvedCampaign(1);
    await env.DB.prepare('update drafts set version = version + 1 where id = ?').bind(changed.draftId).run();
    const c2 = deps();
    await processPage(changed.d, c2.d, { campaignId: changed.campaignId, contactIds: await ids(changed.campaignId) }, Date.now());
    expect(c2.sent).toEqual([]);
    const row = await env.DB.prepare('select status, pause_reason from campaigns where id = ?').bind(changed.campaignId).first();
    expect(row).toEqual({ status: 'paused', pause_reason: 'draft_changed' });

    const late = await approvedCampaign(1);
    await api(late.t.apiKey, '/v1/suppressions', { method: 'POST', body: JSON.stringify({ email: 'r000@x.com', kind: 'complaint' }) });
    const c3 = deps();
    await processPage(late.d, c3.d, { campaignId: late.campaignId, contactIds: await ids(late.campaignId) }, Date.now());
    expect(c3.sent).toEqual([]);
    expect(await statusOf(late.campaignId)).toEqual({ 'r000@x.com': 'suppressed' });
  });
});
