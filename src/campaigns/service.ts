import { and, eq, gte, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { campaignRecipients, campaigns, dispatches, drafts, lists, policies, tenants } from '../db/schema';

export type Origin = 'api' | 'mcp';

export interface Caller {
  tenantId: string;
  keyId: string;
  origin: Origin;
}

const HOUR = 60 * 60 * 1000;
const APPROVAL_WINDOW_MS = 24 * HOUR;
/** A standing policy pauses when more than this share of addresses changed since its last send. */
const MAX_AUDIENCE_CHANGE = 0.1;

export async function createDraft(
  d: Db,
  tenantId: string,
  body: { subject: string; html: string; text?: string },
  origin: Origin,
): Promise<{ id: string; version: number }> {
  const id = crypto.randomUUID();
  await d.insert(drafts).values({ id, tenantId, subject: body.subject, html: body.html, text: body.text ?? null, origin });
  return { id, version: 1 };
}

/**
 * Edit a draft. The new version voids every approval of an older one: approved campaigns go back to
 * awaiting approval and lose their recipient snapshot and dispatch. (A campaign already sending is
 * paused by the consumer when it sees the version change.)
 */
export async function updateDraft(
  d: Db,
  tenantId: string,
  draftId: string,
  patch: { subject?: string; html?: string; text?: string | null },
): Promise<{ id: string; version: number } | null> {
  const current = await d.select().from(drafts).where(and(eq(drafts.id, draftId), eq(drafts.tenantId, tenantId))).get();
  if (!current) return null;
  const version = current.version + 1;
  const voided = d
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.draftId, draftId), eq(campaigns.status, 'approved')));

  await d.batch([
    d
      .update(drafts)
      .set({
        subject: patch.subject ?? current.subject,
        html: patch.html ?? current.html,
        text: patch.text === undefined ? current.text : patch.text,
        version,
      })
      .where(eq(drafts.id, draftId)),
    d.delete(campaignRecipients).where(inArray(campaignRecipients.campaignId, voided)),
    d.delete(dispatches).where(inArray(dispatches.campaignId, voided)),
    d
      .update(campaigns)
      .set({ status: 'awaiting_approval', approvedAt: null, approvedBy: null, recipientCount: null })
      .where(and(eq(campaigns.draftId, draftId), eq(campaigns.status, 'approved'))),
  ]);
  return { id: draftId, version };
}

async function listId(d: Db, tenantId: string, name: string): Promise<string> {
  await d.insert(lists).values({ id: crypto.randomUUID(), tenantId, name }).onConflictDoNothing();
  const row = await d
    .select({ id: lists.id })
    .from(lists)
    .where(and(eq(lists.tenantId, tenantId), eq(lists.name, name)))
    .get();
  return row!.id;
}

/** The contacts a campaign to this list would reach right now: members not unsubscribed or suppressed. */
async function currentAudience(d: Db, tenantId: string, list: string): Promise<Set<string>> {
  const rows = await d.$client
    .prepare(
      `select c.id from list_members lm join contacts c on c.id = lm.contact_id
       where lm.list_id = ?1 and c.tenant_id = ?2 and c.unsubscribed_at is null
       and not exists (select 1 from suppressions s where s.tenant_id = ?2 and s.address_hash = c.address_hash)`,
    )
    .bind(list, tenantId)
    .all<{ id: string }>();
  return new Set(rows.results.map((r) => r.id));
}

export async function createPolicy(
  d: Db,
  tenantId: string,
  p: { apiKeyId: string; campaignType: string; list: string; fromAddress: string; maxPerDay: number },
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await d.insert(policies).values({
    id,
    tenantId,
    apiKeyId: p.apiKeyId,
    campaignType: p.campaignType,
    listId: await listId(d, tenantId, p.list),
    fromAddress: p.fromAddress,
    maxPerDay: p.maxPerDay,
  });
  return { id };
}

export type CampaignRequestStatus = 'needs_approval' | 'approved' | 'paused';

/**
 * Record a send intent. It needs a human approval unless an app API key holds a standing policy for
 * this campaign type, list and sender, under its daily cap, with a human-approved baseline, and the
 * audience changed by at most 10% since the last policy send. Anything drafted over MCP always needs
 * a human.
 */
export async function requestCampaign(
  d: Db,
  caller: Caller,
  req: { draftId: string; list: string; scheduledAt?: number; campaignType?: string; fromAddress?: string },
  now: number = Date.now(),
): Promise<{ campaignId: string; status: CampaignRequestStatus }> {
  const draft = await d
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, req.draftId), eq(drafts.tenantId, caller.tenantId)))
    .get();
  if (!draft) throw new Error('unknown_draft');
  const tenant = (await d.select().from(tenants).where(eq(tenants.id, caller.tenantId)).get())!;
  const list = await listId(d, caller.tenantId, req.list);
  const fromAddress = req.fromAddress ?? tenant.fromAddress;

  const policy =
    caller.origin === 'api' && req.campaignType
      ? await d
          .select()
          .from(policies)
          .where(
            and(
              eq(policies.tenantId, caller.tenantId),
              eq(policies.apiKeyId, caller.keyId),
              eq(policies.campaignType, req.campaignType),
              isNull(policies.revokedAt),
            ),
          )
          .get()
      : undefined;
  const policyFits = policy && policy.listId === list && policy.fromAddress === fromAddress;

  const campaignId = crypto.randomUUID();
  await d.insert(campaigns).values({
    id: campaignId,
    tenantId: caller.tenantId,
    draftId: draft.id,
    draftVersion: draft.version,
    listId: list,
    fromAddress,
    scheduledAt: new Date(req.scheduledAt ?? now),
    campaignType: req.campaignType ?? null,
    policyId: policyFits ? policy.id : null,
    status: 'awaiting_approval',
    origin: caller.origin,
    createdAt: new Date(now),
  });

  if (!policyFits || !policy.baselineCampaignId) return { campaignId, status: 'needs_approval' };

  const sentToday = await d
    .select({ id: campaigns.id })
    .from(campaigns)
    // Every approval under the policy counts, whatever happened to it since: cancelling a send
    // must not free up another unattended one.
    .where(and(eq(campaigns.policyId, policy.id), gte(campaigns.approvedAt, new Date(now - 24 * HOUR))))
    .all();
  if (sentToday.length >= policy.maxPerDay) return { campaignId, status: 'needs_approval' };

  const previous = new Set(
    (
      await d
        .select({ id: campaignRecipients.contactId })
        .from(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, policy.baselineCampaignId))
        .all()
    ).map((r) => r.id),
  );
  const audience = await currentAudience(d, caller.tenantId, list);
  let changed = 0;
  for (const id of audience) if (!previous.has(id)) changed += 1;
  for (const id of previous) if (!audience.has(id)) changed += 1;
  if (changed / Math.max(previous.size, 1) > MAX_AUDIENCE_CHANGE) {
    await d.update(campaigns).set({ status: 'paused', pauseReason: 'audience_changed' }).where(eq(campaigns.id, campaignId));
    return { campaignId, status: 'paused' };
  }

  const approval = await approveCampaign(d, campaignId, `policy:${policy.id}`, now);
  return { campaignId, status: approval.ok ? 'approved' : 'needs_approval' };
}

export type ApprovalResult =
  | { ok: true; recipientCount: number }
  | { ok: false; reason: 'not_found' | 'not_awaiting' | 'expired' | 'draft_changed' };

/**
 * Approve a send intent: freeze the recipient snapshot (list members not unsubscribed or suppressed)
 * and open its dispatch, in one atomic batch. Allowed within 24 hours of the request, or before its
 * scheduled time if that is sooner, and only while the draft is still the approved version. Under a
 * standing policy this send becomes the baseline the next one is compared to.
 */
export async function approveCampaign(
  d: Db,
  campaignId: string,
  approvedBy: string,
  now: number = Date.now(),
): Promise<ApprovalResult> {
  const c = await d.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
  if (!c) return { ok: false, reason: 'not_found' };
  if (c.status !== 'awaiting_approval' && c.status !== 'paused') return { ok: false, reason: 'not_awaiting' };
  const requested = c.createdAt.getTime();
  const scheduled = c.scheduledAt.getTime();
  const deadline = Math.min(requested + APPROVAL_WINDOW_MS, scheduled > requested ? scheduled : Infinity);
  if (now > deadline) return { ok: false, reason: 'expired' };
  const draft = await d.select({ version: drafts.version }).from(drafts).where(eq(drafts.id, c.draftId)).get();
  if (draft?.version !== c.draftVersion) return { ok: false, reason: 'draft_changed' };

  const snapshot = d.$client
    .prepare(
      `insert into campaign_recipients (campaign_id, contact_id, email, unsubscribe_token)
       select ?1, c.id, c.email, c.unsubscribe_token from list_members lm join contacts c on c.id = lm.contact_id
       where lm.list_id = ?2 and c.tenant_id = ?3 and c.unsubscribed_at is null
       and not exists (select 1 from suppressions s where s.tenant_id = ?3 and s.address_hash = c.address_hash)`,
    )
    .bind(campaignId, c.listId, c.tenantId);
  await d.$client.batch([
    d.$client.prepare('delete from campaign_recipients where campaign_id = ?').bind(campaignId),
    snapshot,
    d.$client
      .prepare(
        `update campaigns set status = 'approved', pause_reason = null, approved_at = ?2, approved_by = ?3,
         recipient_count = (select count(*) from campaign_recipients where campaign_id = ?1) where id = ?1`,
      )
      .bind(campaignId, now, approvedBy),
    d.$client
      .prepare(
        `insert into dispatches (campaign_id, cursor, lease_until, done) values (?1, '', null, 0)
         on conflict (campaign_id) do update set cursor = '', lease_until = null, done = 0`,
      )
      .bind(campaignId),
    ...(c.policyId
      ? [d.$client.prepare('update policies set baseline_campaign_id = ?1 where id = ?2').bind(campaignId, c.policyId)]
      : []),
  ]);
  const row = await d.select({ n: campaigns.recipientCount }).from(campaigns).where(eq(campaigns.id, campaignId)).get();
  return { ok: true, recipientCount: row?.n ?? 0 };
}

export type StatusAction = 'pause' | 'resume' | 'cancel';

/**
 * Owner and app controls. Pausing stops the next batch (the consumer re-checks status before each);
 * resume continues a paused, already-approved send; cancel is final. Callers decide who may do what:
 * an agent over MCP may cancel but never resume.
 */
export async function setCampaignStatus(
  d: Db,
  tenantId: string,
  campaignId: string,
  action: StatusAction,
): Promise<{ ok: boolean; status?: string }> {
  const c = await d
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.tenantId, tenantId)))
    .get();
  if (!c) return { ok: false };
  if (action === 'cancel') {
    if (c.status === 'sent' || c.status === 'cancelled') return { ok: false, status: c.status };
    await d.batch([
      d.update(campaigns).set({ status: 'cancelled' }).where(eq(campaigns.id, campaignId)),
      d.update(dispatches).set({ done: true }).where(eq(dispatches.campaignId, campaignId)),
    ]);
    return { ok: true, status: 'cancelled' };
  }
  if (action === 'pause') {
    if (c.status !== 'approved' && c.status !== 'sending') return { ok: false, status: c.status };
    await d.update(campaigns).set({ status: 'paused', pauseReason: 'owner' }).where(eq(campaigns.id, campaignId));
    return { ok: true, status: 'paused' };
  }
  // resume: only a send that was approved and then paused by its owner; other pauses need a new approval.
  if (c.status !== 'paused' || c.pauseReason !== 'owner' || !c.approvedAt) return { ok: false, status: c.status };
  await d.update(campaigns).set({ status: 'sending', pauseReason: null }).where(eq(campaigns.id, campaignId));
  return { ok: true, status: 'sending' };
}

/**
 * Owner action (eng review D9): send again to recipients whose delivery is unknown (a crash after
 * the SES call). The owner accepts that some of them may get it twice. Re-opens the dispatch so the
 * reconciler publishes them.
 */
export async function resendUnknowns(d: Db, tenantId: string, campaignId: string): Promise<{ ok: boolean; requeued: number }> {
  const c = await d
    .select({ id: campaigns.id, status: campaigns.status })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.tenantId, tenantId)))
    .get();
  if (!c || c.status === 'cancelled') return { ok: false, requeued: 0 };
  const res = await d.$client
    .prepare(`update campaign_recipients set status = 'pending', claimed_at = null, claim_batch = null where campaign_id = ?1 and status = 'unknown'`)
    .bind(campaignId)
    .run();
  if (res.meta.changes > 0) {
    await d.$client.batch([
      d.$client.prepare(`update campaigns set status = 'sending' where id = ?1 and status in ('sent', 'approved', 'sending')`).bind(campaignId),
      d.$client
        .prepare(`insert into dispatches (campaign_id, cursor, lease_until, done) values (?1, '', null, 0) on conflict (campaign_id) do update set cursor = '', lease_until = null, done = 0`)
        .bind(campaignId),
    ]);
  }
  return { ok: true, requeued: res.meta.changes };
}
