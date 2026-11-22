import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { Owner } from '../auth/better-auth';
import { approveCampaign, createPolicy, resendUnknowns, setCampaignStatus, type StatusAction } from '../campaigns/service';
import { db } from '../db/client';
import { apiKeys, campaigns, drafts, lists, policies, tenants } from '../db/schema';
import type { Env } from '../env';
import { layout } from '../ui/layout';
import { escapeHtml as h } from '../ui/page';
import { currentOwner } from './owner';

type C = Context<{ Bindings: Env }>;
export const dashboard = new Hono<{ Bindings: Env }>();

const MAX_CONTEXT = 8000;

/**
 * Who may act here. Reads need an owner of the tenant. Writes also need the request to come from
 * this site (Origin header), on top of the session cookie's SameSite=Lax, so no other page can post
 * an approval on an owner's behalf.
 */
async function ownerOf(c: C, tenantId: string, write = false): Promise<Owner | Response> {
  const owner = await currentOwner(c);
  if (!owner) {
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(url.pathname)}`, 303);
  }
  if (write && c.req.header('origin') !== new URL(c.env.PUBLIC_BASE_URL).origin) return c.text('Forbidden', 403);
  if (!owner.tenants.some((t) => t.id === tenantId)) return c.text('Forbidden', 403);
  return owner;
}

dashboard.get('/', async (c) => {
  const owner = await currentOwner(c);
  if (!owner) return c.redirect('/login', 303);
  const first = owner.tenants[0];
  return first ? c.redirect(`/t/${first.id}`, 303) : c.html(layout(owner, '', '', 'No business', '<h1>No business yet</h1>'));
});

// ── Overview ─────────────────────────────────────────────────────────────────

dashboard.get('/t/:tenantId', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId);
  if (owner instanceof Response) return owner;
  const rows = await c.env.DB.prepare(
    `select c.id, c.status, c.pause_reason, c.origin, c.recipient_count, c.created_at, d.subject, l.name as list,
       (select count(*) from campaign_recipients r where r.campaign_id = c.id and r.status = 'sent') as sent,
       (select count(*) from campaign_recipients r where r.campaign_id = c.id and r.status = 'unknown') as unknown
     from campaigns c join drafts d on d.id = c.draft_id join lists l on l.id = c.list_id
     where c.tenant_id = ? order by c.created_at desc limit 30`,
  )
    .bind(tenantId)
    .all<{ id: string; status: string; pause_reason: string | null; origin: string; recipient_count: number | null; subject: string; list: string; sent: number; unknown: number }>();

  const waiting = rows.results.filter((r) => r.status === 'awaiting_approval' || (r.status === 'paused' && r.pause_reason !== 'owner'));
  const control = (id: string, action: string, label: string) =>
    `<form class="inline" method="post" action="/t/${h(tenantId)}/campaigns/${h(id)}/${action}"><button class="ghost" type="submit">${label}</button></form>`;
  const waitingHtml = waiting.length
    ? waiting
        .map((r) => `<tr><td>${h(r.subject)}</td><td>${h(r.list)}</td><td>${r.origin === 'mcp' ? 'agent' : 'app'}</td><td><a href="/approve/${h(r.id)}">Review and approve</a></td></tr>`)
        .join('')
    : '<tr><td class="muted">Nothing is waiting for you.</td></tr>';
  const campaignsHtml = rows.results
    .map((r) => {
      const actions = [
        r.status === 'approved' || r.status === 'sending' ? control(r.id, 'pause', 'Pause') : '',
        r.status === 'paused' && r.pause_reason === 'owner' ? control(r.id, 'resume', 'Resume') : '',
        r.unknown > 0 ? control(r.id, 'resend-unknowns', `Resend ${r.unknown} unknown`) : '',
        r.status !== 'sent' && r.status !== 'cancelled' ? control(r.id, 'cancel', 'Cancel') : '',
      ].join(' ');
      const status = r.pause_reason ? `${r.status} (${r.pause_reason.replace('_', ' ')})` : r.status;
      return `<tr><td>${h(r.subject)}</td><td>${h(r.list)}</td><td><span class="pill">${h(status)}</span></td><td>${r.sent}/${r.recipient_count ?? '–'}</td><td>${actions}</td></tr>`;
    })
    .join('');
  return c.html(
    layout(
      owner,
      tenantId,
      '',
      'Overview',
      `<h1>Overview</h1><div class="card"><h2>Waiting for your approval</h2><table>${waitingHtml}</table></div>` +
        `<div class="card"><h2>Campaigns</h2><table><tr><th>Subject</th><th>List</th><th>Status</th><th>Sent</th><th></th></tr>${campaignsHtml}</table></div>`,
    ),
  );
});

// ── The approval page (D12): GET shows the exact intent; only a POST approves ─

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

dashboard.get('/approve/:campaignId', async (c) => {
  const camp = await campaignFor(c, c.req.param('campaignId'));
  if (!camp) return c.text('Not found', 404);
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
  const action = !awaiting
    ? `<p>This send is <span class="pill">${h(camp.status)}</span>; there is nothing to approve.</p>`
    : stale
      ? '<p class="muted">The draft changed after this request. Ask for a new approval.</p>'
      : `<form method="post"><button type="submit">Approve and send</button></form>`;
  return c.html(
    layout(
      owner,
      camp.tenantId,
      '',
      'Approve send',
      `<h1>Approve this send?</h1><div class="card"><table>` +
        `<tr><th>Subject</th><td>${h(camp.subject)} <span class="muted">(draft version ${camp.draftVersion})</span></td></tr>` +
        `<tr><th>To</th><td>${h(camp.listName)}: ${count?.n ?? 0} recipients</td></tr>` +
        `<tr><th>From</th><td>${h(camp.fromAddress)}</td></tr>` +
        `<tr><th>When</th><td>${h(camp.scheduledAt.toISOString())}</td></tr>` +
        `<tr><th>Requested by</th><td>${camp.origin === 'mcp' ? 'an agent' : 'an app'}${camp.pauseReason ? ` (paused: ${h(camp.pauseReason.replace('_', ' '))})` : ''}</td></tr>` +
        `</table></div><div class="card"><iframe sandbox title="Email preview" srcdoc="${h(camp.html)}" style="width:100%;height:24rem;border:0"></iframe></div>${action}`,
    ),
  );
});

dashboard.post('/approve/:campaignId', async (c) => {
  const camp = await campaignFor(c, c.req.param('campaignId'));
  if (!camp) return c.text('Not found', 404);
  const owner = await ownerOf(c, camp.tenantId, true);
  if (owner instanceof Response) return owner;
  const result = await approveCampaign(db(c.env.DB), camp.id, owner.userId);
  if (!result.ok) {
    return c.html(layout(owner, camp.tenantId, '', 'Not approved', `<h1>Could not approve</h1><p>${h(result.reason.replace('_', ' '))}.</p>`), 409);
  }
  return c.redirect(`/t/${camp.tenantId}`, 303);
});

// ── Campaign controls ────────────────────────────────────────────────────────

for (const action of ['pause', 'resume', 'cancel'] as StatusAction[]) {
  dashboard.post(`/t/:tenantId/campaigns/:id/${action}`, async (c) => {
    const tenantId = c.req.param('tenantId');
    const owner = await ownerOf(c, tenantId, true);
    if (owner instanceof Response) return owner;
    await setCampaignStatus(db(c.env.DB), tenantId, c.req.param('id'), action);
    return c.redirect(`/t/${tenantId}`, 303);
  });
}

dashboard.post('/t/:tenantId/campaigns/:id/resend-unknowns', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId, true);
  if (owner instanceof Response) return owner;
  await resendUnknowns(db(c.env.DB), tenantId, c.req.param('id'));
  return c.redirect(`/t/${tenantId}`, 303);
});

// ── Suppressions, agent setup, context ───────────────────────────────────────

dashboard.get('/t/:tenantId/suppressions', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId);
  if (owner instanceof Response) return owner;
  const rows = await c.env.DB.prepare('select kind, count(*) as n from suppressions where tenant_id = ? group by kind order by kind')
    .bind(tenantId)
    .all<{ kind: string; n: number }>();
  const table = rows.results.map((r) => `<tr><td>${h(r.kind)}</td><td>${r.n}</td></tr>`).join('') || '<tr><td class="muted">None yet.</td></tr>';
  return c.html(
    layout(owner, tenantId, '/suppressions', 'Suppressions', `<h1>Suppressions</h1><p class="muted">Addresses are stored only as hashes, so this page shows counts.</p><div class="card"><table>${table}</table></div>`),
  );
});

dashboard.get('/t/:tenantId/agent', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId);
  if (owner instanceof Response) return owner;
  const url = `${c.env.PUBLIC_BASE_URL}/mcp`;
  return c.html(
    layout(
      owner,
      tenantId,
      '/agent',
      'Agent setup',
      `<h1>Agent setup</h1><div class="card"><p>Add openmail to your agent as a remote MCP server. It signs in with your owner account, and you pick this business when it asks.</p>` +
        `<label>MCP server URL</label><pre>${h(url)}</pre>` +
        `<h3>Claude</h3><p>Settings → Connectors → Add custom connector → paste the URL.</p>` +
        `<h3>ChatGPT</h3><p>Settings → Connectors → Create → paste the URL, authentication OAuth.</p>` +
        `<h3>Claude Code</h3><pre>claude mcp add --transport http openmail ${h(url)}</pre>` +
        `<p class="muted">Agents can draft and ask you to approve. Only you can approve a send, here.</p></div>`,
    ),
  );
});

dashboard.get('/t/:tenantId/context', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId);
  if (owner instanceof Response) return owner;
  const t = await db(c.env.DB).select({ context: tenants.context }).from(tenants).where(eq(tenants.id, tenantId)).get();
  return c.html(
    layout(
      owner,
      tenantId,
      '/context',
      'Context',
      `<h1>Context</h1><p class="muted">Agents read this before drafting: your voice, sign-off, things to avoid.</p>` +
        `<form method="post"><textarea name="context" rows="14" maxlength="${MAX_CONTEXT}">${h(t?.context ?? '')}</textarea><button type="submit">Save</button></form>`,
    ),
  );
});

dashboard.post('/t/:tenantId/context', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId, true);
  if (owner instanceof Response) return owner;
  const context = String((await c.req.parseBody()).context ?? '');
  if (context.length > MAX_CONTEXT) return c.text(`Context is limited to ${MAX_CONTEXT} characters.`, 400);
  await db(c.env.DB).update(tenants).set({ context }).where(eq(tenants.id, tenantId));
  return c.redirect(`/t/${tenantId}/context`, 303);
});

// ── Standing approvals (D15) ─────────────────────────────────────────────────

dashboard.get('/t/:tenantId/policies', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId);
  if (owner instanceof Response) return owner;
  const d = db(c.env.DB);
  const [rows, keys] = await Promise.all([
    d
      .select({ id: policies.id, type: policies.campaignType, list: lists.name, from: policies.fromAddress, max: policies.maxPerDay, key: apiKeys.name, revokedAt: policies.revokedAt })
      .from(policies)
      .innerJoin(lists, eq(lists.id, policies.listId))
      .innerJoin(apiKeys, eq(apiKeys.id, policies.apiKeyId))
      .where(eq(policies.tenantId, tenantId))
      .orderBy(desc(policies.createdAt))
      .all(),
    d.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).where(and(eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt))).all(),
  ]);
  const table = rows
    .map(
      (p) =>
        `<tr><td>${h(p.type)}</td><td>${h(p.list)}</td><td>${h(p.from)}</td><td>${p.max}/day</td><td>${h(p.key)}</td><td>${
          p.revokedAt ? '<span class="pill">revoked</span>' : `<form class="inline" method="post" action="/t/${h(tenantId)}/policies/${h(p.id)}/revoke"><button class="ghost" type="submit">Revoke</button></form>`
        }</td></tr>`,
    )
    .join('');
  const keyOptions = keys.map((k) => `<option value="${h(k.id)}">${h(k.name)}</option>`).join('');
  return c.html(
    layout(
      owner,
      tenantId,
      '/policies',
      'Standing approvals',
      `<h1>Standing approvals</h1><p class="muted">Let one app key send one kind of campaign to one list without asking each time. The first send still needs your approval, and a send pauses if the list changed by more than 10% since the last one.</p>` +
        `<div class="card"><table><tr><th>Type</th><th>List</th><th>From</th><th>Cap</th><th>App key</th><th></th></tr>${table}</table></div>` +
        `<div class="card"><h2>New standing approval</h2><form method="post"><label>App key<select name="apiKeyId">${keyOptions}</select></label>` +
        `<label>Campaign type<input name="campaignType" required placeholder="daily"></label><label>List<input name="list" required></label>` +
        `<label>From address<input name="fromAddress" required></label><label>Sends per day<input name="maxPerDay" type="number" min="1" max="24" value="1"></label>` +
        `<button type="submit">Create</button></form></div>`,
    ),
  );
});

dashboard.post('/t/:tenantId/policies', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId, true);
  if (owner instanceof Response) return owner;
  const f = await c.req.parseBody();
  const apiKeyId = String(f.apiKeyId ?? '');
  const key = await db(c.env.DB).select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.tenantId, tenantId))).get();
  const maxPerDay = Number(f.maxPerDay ?? 1);
  if (!key || !f.campaignType || !f.list || !f.fromAddress || !Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 24) {
    return c.text('Invalid standing approval.', 400);
  }
  await createPolicy(db(c.env.DB), tenantId, {
    apiKeyId,
    campaignType: String(f.campaignType),
    list: String(f.list),
    fromAddress: String(f.fromAddress),
    maxPerDay,
  });
  return c.redirect(`/t/${tenantId}/policies`, 303);
});

dashboard.post('/t/:tenantId/policies/:id/revoke', async (c) => {
  const tenantId = c.req.param('tenantId');
  const owner = await ownerOf(c, tenantId, true);
  if (owner instanceof Response) return owner;
  await db(c.env.DB)
    .update(policies)
    .set({ revokedAt: new Date() })
    .where(and(eq(policies.id, c.req.param('id')), eq(policies.tenantId, tenantId)));
  return c.redirect(`/t/${tenantId}/policies`, 303);
});
