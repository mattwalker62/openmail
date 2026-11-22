import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { Owner } from '../auth/better-auth';
import { approveCampaign, createPolicy, resendUnknowns, setCampaignStatus, type StatusAction } from '../campaigns/service';
import { db } from '../db/client';
import { apiKeys, campaigns, drafts, lists, policies, tenants } from '../db/schema';
import type { Env } from '../env';
import { currentOwner } from './owner';

type C = Context<{ Bindings: Env }>;

/**
 * JSON API for the owner dashboard (the React app in client/). Every route needs a signed-in owner of
 * that business; every write also needs this site's Origin, on top of the SameSite=Lax session cookie,
 * so no other page can approve a send on an owner's behalf.
 */
export const dashboardApi = new Hono<{ Bindings: Env }>();

const MAX_CONTEXT = 8000;

async function ownerOf(c: C, tenantId: string | null, write = false): Promise<Owner | Response> {
  const owner = await currentOwner(c);
  if (!owner) return c.json({ error: 'unauthorized' }, 401);
  if (write && c.req.header('origin') !== new URL(c.env.PUBLIC_BASE_URL).origin) return c.json({ error: 'forbidden' }, 403);
  if (tenantId !== null && !owner.tenants.some((t) => t.id === tenantId)) return c.json({ error: 'forbidden' }, 403);
  return owner;
}

dashboardApi.get('/me', async (c) => {
  const owner = await ownerOf(c, null);
  if (owner instanceof Response) return owner;
  return c.json({ email: owner.email, tenants: owner.tenants });
});

dashboardApi.get('/t/:tenantId/overview', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId);
  if (owner instanceof Response) return owner;
  const rows = await c.env.DB.prepare(
    `select c.id, c.status, c.pause_reason, c.origin, c.recipient_count, c.created_at, d.subject, l.name as list,
       (select count(*) from campaign_recipients r where r.campaign_id = c.id and r.status = 'sent') as sent,
       (select count(*) from campaign_recipients r where r.campaign_id = c.id and r.status = 'unknown') as unknown
     from campaigns c join drafts d on d.id = c.draft_id join lists l on l.id = c.list_id
     where c.tenant_id = ? order by c.created_at desc limit 50`,
  )
    .bind(tenantId)
    .all<{
      id: string;
      status: string;
      pause_reason: string | null;
      origin: string;
      recipient_count: number | null;
      created_at: number;
      subject: string;
      list: string;
      sent: number;
      unknown: number;
    }>();
  const campaignsOut = rows.results.map((r) => ({
    id: r.id,
    subject: r.subject,
    list: r.list,
    status: r.status,
    pauseReason: r.pause_reason,
    requestedBy: r.origin === 'mcp' ? 'agent' : 'app',
    recipients: r.recipient_count,
    sent: r.sent,
    unknown: r.unknown,
    createdAt: r.created_at,
  }));
  const waiting = campaignsOut.filter((r) => r.status === 'awaiting_approval' || (r.status === 'paused' && r.pauseReason !== 'owner'));
  return c.json({ waiting, campaigns: campaignsOut });
});

// ── Approval (D12): GET describes the exact intent; only a POST approves ─────

async function campaignFor(c: C, campaignId: string) {
  return db(c.env.DB)
    .select({
      id: campaigns.id,
      tenantId: campaigns.tenantId,
      status: campaigns.status,
      pauseReason: campaigns.pauseReason,
      fromAddress: campaigns.fromAddress,
      scheduledAt: campaigns.scheduledAt,
      draftVersion: campaigns.draftVersion,
      origin: campaigns.origin,
      listId: campaigns.listId,
      listName: lists.name,
      subject: drafts.subject,
      html: drafts.html,
      currentVersion: drafts.version,
    })
    .from(campaigns)
    .innerJoin(drafts, eq(drafts.id, campaigns.draftId))
    .innerJoin(lists, eq(lists.id, campaigns.listId))
    .where(eq(campaigns.id, campaignId))
    .get();
}

dashboardApi.get('/approve/:campaignId', async (c) => {
  const camp = await campaignFor(c, c.req.param('campaignId'));
  if (!camp) return c.json({ error: 'not_found' }, 404);
  const owner = await ownerOf(c, camp.tenantId);
  if (owner instanceof Response) return owner;
  const count = await c.env.DB.prepare(
    `select count(*) as n from list_members lm join contacts ct on ct.id = lm.contact_id where lm.list_id = ?1 and ct.unsubscribed_at is null
     and not exists (select 1 from suppressions s where s.tenant_id = ct.tenant_id and s.address_hash = ct.address_hash)`,
  )
    .bind(camp.listId)
    .first<{ n: number }>();
  const awaiting = camp.status === 'awaiting_approval' || (camp.status === 'paused' && camp.pauseReason !== 'owner');
  const stale = camp.currentVersion !== camp.draftVersion;
  return c.json({
    id: camp.id,
    tenantId: camp.tenantId,
    status: camp.status,
    pauseReason: camp.pauseReason,
    subject: camp.subject,
    html: camp.html,
    draftVersion: camp.draftVersion,
    draftChanged: stale,
    list: camp.listName,
    recipients: count?.n ?? 0,
    fromAddress: camp.fromAddress,
    scheduledAt: camp.scheduledAt.getTime(),
    requestedBy: camp.origin === 'mcp' ? 'agent' : 'app',
    canApprove: awaiting && !stale,
  });
});

dashboardApi.post('/approve/:campaignId', async (c) => {
  const camp = await campaignFor(c, c.req.param('campaignId'));
  if (!camp) return c.json({ error: 'not_found' }, 404);
  const owner = await ownerOf(c, camp.tenantId, true);
  if (owner instanceof Response) return owner;
  const result = await approveCampaign(db(c.env.DB), camp.id, owner.userId);
  return result.ok ? c.json(result) : c.json(result, 409);
});

// ── Campaign controls ────────────────────────────────────────────────────────

for (const action of ['pause', 'resume', 'cancel'] as StatusAction[]) {
  dashboardApi.post(`/t/:tenantId/campaigns/:id/${action}`, async (c) => {
    const tenantId = c.req.param('tenantId');
    const owner = await ownerOf(c, tenantId, true);
    if (owner instanceof Response) return owner;
    const result = await setCampaignStatus(db(c.env.DB), tenantId, c.req.param('id'), action);
    return c.json(result, result.ok ? 200 : 409);
  });
}

dashboardApi.post('/t/:tenantId/campaigns/:id/resend-unknowns', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId, true);
  if (owner instanceof Response) return owner;
  const result = await resendUnknowns(db(c.env.DB), tenantId, c.req.param('id'));
  return c.json(result, result.ok ? 200 : 409);
});

// ── Suppressions, agent setup, context ───────────────────────────────────────

dashboardApi.get('/t/:tenantId/suppressions', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId);
  if (owner instanceof Response) return owner;
  const rows = await c.env.DB.prepare('select kind, count(*) as n from suppressions where tenant_id = ? group by kind order by kind')
    .bind(tenantId)
    .all<{ kind: string; n: number }>();
  return c.json({ counts: rows.results.map((r) => ({ kind: r.kind, count: r.n })) });
});

dashboardApi.get('/t/:tenantId/agent', async (c) => {
  const owner = await ownerOf(c, c.req.param('tenantId'));
  if (owner instanceof Response) return owner;
  return c.json({ mcpUrl: `${c.env.PUBLIC_BASE_URL}/mcp` });
});

dashboardApi.get('/t/:tenantId/context', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId);
  if (owner instanceof Response) return owner;
  const t = await db(c.env.DB).select({ context: tenants.context }).from(tenants).where(eq(tenants.id, tenantId)).get();
  return c.json({ context: t?.context ?? '' });
});

dashboardApi.put('/t/:tenantId/context', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId, true);
  if (owner instanceof Response) return owner;
  const b = (await c.req.json().catch(() => ({}))) as { context?: unknown };
  const context = typeof b.context === 'string' ? b.context : '';
  if (context.length > MAX_CONTEXT) return c.json({ error: `Context is limited to ${MAX_CONTEXT} characters.` }, 400);
  await db(c.env.DB).update(tenants).set({ context }).where(eq(tenants.id, tenantId));
  return c.json({ context });
});

// ── Standing approvals (D15) ─────────────────────────────────────────────────

dashboardApi.get('/t/:tenantId/policies', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId);
  if (owner instanceof Response) return owner;
  const d = db(c.env.DB);
  const [rows, keys] = await Promise.all([
    d
      .select({
        id: policies.id,
        campaignType: policies.campaignType,
        list: lists.name,
        fromAddress: policies.fromAddress,
        maxPerDay: policies.maxPerDay,
        keyName: apiKeys.name,
        revokedAt: policies.revokedAt,
      })
      .from(policies)
      .innerJoin(lists, eq(lists.id, policies.listId))
      .innerJoin(apiKeys, eq(apiKeys.id, policies.apiKeyId))
      .where(eq(policies.tenantId, tenantId))
      .orderBy(desc(policies.createdAt))
      .all(),
    d.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).where(and(eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt))).all(),
  ]);
  return c.json({
    policies: rows.map(({ revokedAt, ...p }) => ({ ...p, revoked: revokedAt !== null })),
    keys,
  });
});

dashboardApi.post('/t/:tenantId/policies', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId, true);
  if (owner instanceof Response) return owner;
  const b = (await c.req.json().catch(() => ({}))) as {
    apiKeyId?: string;
    campaignType?: string;
    list?: string;
    fromAddress?: string;
    maxPerDay?: number;
  };
  const key = b.apiKeyId
    ? await db(c.env.DB).select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.id, b.apiKeyId), eq(apiKeys.tenantId, tenantId))).get()
    : undefined;
  const maxPerDay = Number(b.maxPerDay ?? 1);
  if (!key || !b.campaignType || !b.list || !b.fromAddress || !Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 24) {
    return c.json({ error: 'invalid_policy' }, 400);
  }
  const created = await createPolicy(db(c.env.DB), tenantId, {
    apiKeyId: key.id,
    campaignType: b.campaignType,
    list: b.list,
    fromAddress: b.fromAddress,
    maxPerDay,
  });
  return c.json(created, 201);
});

dashboardApi.post('/t/:tenantId/policies/:id/revoke', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId, true);
  if (owner instanceof Response) return owner;
  await db(c.env.DB)
    .update(policies)
    .set({ revokedAt: new Date() })
    .where(and(eq(policies.id, c.req.param('id')), eq(policies.tenantId, tenantId)));
  return c.json({ ok: true });
});
