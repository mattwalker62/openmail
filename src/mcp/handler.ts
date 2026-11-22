import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { createDraft, requestCampaign, setCampaignStatus, updateDraft } from '../campaigns/service';
import { db } from '../db/client';
import { campaigns, drafts, lists, tenants } from '../db/schema';
import type { Env } from '../env';

/** What the owner's OAuth grant carries: the agent acts for this user, on this tenant only. */
export interface McpProps {
  userId: string;
  tenantId: string;
}

const INSTRUCTIONS =
  'openmail sends email for one business. Read get_sender_context before drafting and write in that voice. ' +
  'You can draft and request approval; a human owner approves every send you request, on the approval page. ' +
  'Nothing you request goes out until they do.';

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const fail = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

/**
 * The MCP tools. Every query is scoped to props.tenantId. There is deliberately no tool that approves,
 * resumes or sends without approval: an agent can draft, request approval and cancel.
 */
export function buildServer(env: Env, props: McpProps): McpServer {
  const server = new McpServer({ name: 'openmail', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const d = db(env.DB);
  const { tenantId } = props;
  const caller = { tenantId, keyId: `mcp:${props.userId}`, origin: 'mcp' as const };

  server.registerTool('get_sender_context', { description: "The business's voice and context notes. Read before drafting." }, async () => {
    const t = await d.select({ context: tenants.context }).from(tenants).where(eq(tenants.id, tenantId)).get();
    return ok({ context: t?.context ?? '' });
  });

  server.registerTool('list_audiences', { description: 'Lists you can send to, with member counts.' }, async () => {
    const rows = await env.DB.prepare(
      'select l.name, count(lm.contact_id) as members from lists l left join list_members lm on lm.list_id = l.id where l.tenant_id = ? group by l.id order by l.name',
    )
      .bind(tenantId)
      .all<{ name: string; members: number }>();
    return ok(rows.results);
  });

  server.registerTool(
    'get_audience_stats',
    { description: 'Members, unsubscribed and suppressed counts for one list.', inputSchema: z.object({ list: z.string() }) },
    async ({ list }) => {
      const row = await env.DB.prepare(
        `select count(*) as members,
           sum(case when c.unsubscribed_at is not null then 1 else 0 end) as unsubscribed,
           sum(case when exists (select 1 from suppressions s where s.tenant_id = l.tenant_id and s.address_hash = c.address_hash) then 1 else 0 end) as suppressed
         from lists l join list_members lm on lm.list_id = l.id join contacts c on c.id = lm.contact_id
         where l.tenant_id = ? and l.name = ?`,
      )
        .bind(tenantId, list)
        .first<{ members: number; unsubscribed: number | null; suppressed: number | null }>();
      return ok({ list, members: row?.members ?? 0, unsubscribed: row?.unsubscribed ?? 0, suppressed: row?.suppressed ?? 0 });
    },
  );

  server.registerTool(
    'create_draft',
    { description: 'Write a new draft email.', inputSchema: z.object({ subject: z.string().min(1).max(300), html: z.string().min(1), text: z.string().optional() }) },
    async ({ subject, html, text }) => ok(await createDraft(d, tenantId, { subject, html, ...(text ? { text } : {}) }, 'mcp')),
  );

  server.registerTool(
    'update_draft',
    {
      description: 'Edit a draft. This voids any approval of the earlier version.',
      inputSchema: z.object({ draftId: z.string(), subject: z.string().min(1).max(300).optional(), html: z.string().min(1).optional(), text: z.string().optional() }),
    },
    async ({ draftId, ...patch }) => {
      const updated = await updateDraft(d, tenantId, draftId, patch);
      return updated ? ok(updated) : fail('Draft not found.');
    },
  );

  server.registerTool('preview_draft', { description: 'Read a draft back.', inputSchema: z.object({ draftId: z.string() }) }, async ({ draftId }) => {
    const row = await d
      .select({ id: drafts.id, subject: drafts.subject, html: drafts.html, text: drafts.text, version: drafts.version })
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.tenantId, tenantId)))
      .get();
    return row ? ok(row) : fail('Draft not found.');
  });

  server.registerTool(
    'request_approval',
    {
      description: 'Ask the owner to approve sending a draft to a list. Returns the approval page link to show them. Nothing is sent until they approve.',
      inputSchema: z.object({ draftId: z.string(), list: z.string(), scheduledAt: z.number().int().optional() }),
    },
    async ({ draftId, list, scheduledAt }) => {
      const known = await d.select({ id: lists.id }).from(lists).where(and(eq(lists.tenantId, tenantId), eq(lists.name, list))).get();
      if (!known) return fail(`No list called "${list}". Use list_audiences.`);
      try {
        const r = await requestCampaign(d, caller, { draftId, list, ...(scheduledAt ? { scheduledAt } : {}) });
        return ok({ ...r, approvalUrl: `${env.PUBLIC_BASE_URL}/approve/${r.campaignId}` });
      } catch {
        return fail('Draft not found.');
      }
    },
  );

  server.registerTool(
    'get_campaign_status',
    { description: 'Where a requested send stands: awaiting approval, sending, sent, paused or cancelled, with delivery counts.', inputSchema: z.object({ campaignId: z.string() }) },
    async ({ campaignId }) => {
      const c = await d
        .select({ id: campaigns.id, status: campaigns.status, pauseReason: campaigns.pauseReason, recipientCount: campaigns.recipientCount })
        .from(campaigns)
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.tenantId, tenantId)))
        .get();
      if (!c) return fail('Campaign not found.');
      const counts = await env.DB.prepare('select status, count(*) as n from campaign_recipients where campaign_id = ? group by status')
        .bind(campaignId)
        .all<{ status: string; n: number }>();
      return ok({ ...c, deliveries: Object.fromEntries(counts.results.map((r) => [r.status, r.n])) });
    },
  );

  server.registerTool('cancel_campaign', { description: 'Cancel a requested or running send. Agents can cancel but never resume.', inputSchema: z.object({ campaignId: z.string() }) }, async ({ campaignId }) => {
    const r = await setCampaignStatus(d, tenantId, campaignId, 'cancel');
    return r.ok ? ok(r) : fail(`Cannot cancel (status: ${r.status ?? 'not found'}).`);
  });

  return server;
}

/** The MCP endpoint behind OAuthProvider: ctx.props is the verified grant. */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: McpProps }): Promise<Response> {
    const props = ctx.props;
    if (!props?.tenantId || !props.userId) return new Response('Forbidden', { status: 403 });
    const handler = createMcpHandler(() => buildServer(env, props));
    return handler.fetch(request);
  },
};
