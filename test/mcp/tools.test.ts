import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { mcpApiHandler } from '../../src/mcp/handler';
import { api, createTenant } from '../helpers';

type Props = { userId: string; tenantId: string };

async function call(props: Props, name: string, args: Record<string, unknown> = {}) {
  const req = new Request('https://openmail.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await mcpApiHandler.fetch(req, env, { props } as never);
  const text = await res.text();
  const json = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
  const body = json.result?.content?.[0]?.text;
  const isError = !!json.result?.isError;
  return { isError, data: body && !isError ? JSON.parse(body) : (body ?? json) };
}

async function listTools(props: Props): Promise<string[]> {
  const req = new Request('https://openmail.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const res = await mcpApiHandler.fetch(req, env, { props } as never);
  const text = await res.text();
  const json = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
  return json.result.tools.map((t: { name: string }) => t.name).sort();
}

describe('MCP tools (scoped to the tenant the owner connected)', () => {
  it('offers drafting and approval requests, but no tool that approves, resumes or sends unapproved', async () => {
    const t = await createTenant();
    const tools = await listTools({ userId: 'u1', tenantId: t.id });
    expect(tools).toEqual([
      'cancel_campaign',
      'create_draft',
      'get_audience_stats',
      'get_campaign_status',
      'get_sender_context',
      'list_audiences',
      'preview_draft',
      'request_approval',
      'update_draft',
    ]);
  });

  it('drafts, then requests approval, which always waits for a human', async () => {
    const t = await createTenant();
    await api(t.apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email: 'a@x.com', lists: ['beacon'] }) });
    const props = { userId: 'u1', tenantId: t.id };

    const draft = await call(props, 'create_draft', { subject: 'Issue 1', html: '<p>Hi</p>' });
    expect(draft.data).toMatchObject({ version: 1 });
    const audiences = await call(props, 'list_audiences');
    expect(audiences.data).toEqual([{ name: 'beacon', members: 1 }]);

    const req = await call(props, 'request_approval', { draftId: draft.data.id, list: 'beacon' });
    expect(req.data.status).toBe('needs_approval');
    expect(req.data.approvalUrl).toBe(`https://openmail.test/approve/${req.data.campaignId}`);
    const row = await env.DB.prepare('select origin, status from campaigns where id = ?').bind(req.data.campaignId).first();
    expect(row).toEqual({ origin: 'mcp', status: 'awaiting_approval' });

    const cancel = await call(props, 'cancel_campaign', { campaignId: req.data.campaignId });
    expect(cancel.data).toEqual({ ok: true, status: 'cancelled' });
  });

  it('reads the tenant context notes agents draft from', async () => {
    const t = await createTenant();
    await env.DB.prepare("update tenants set context = 'Warm, short, no exclamation marks.' where id = ?").bind(t.id).run();
    expect((await call({ userId: 'u1', tenantId: t.id }, 'get_sender_context')).data).toEqual({ context: 'Warm, short, no exclamation marks.' });
  });

  it("can't see or touch another tenant's draft", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const draft = await call({ userId: 'u1', tenantId: a.id }, 'create_draft', { subject: 'S', html: 'h' });

    const other = await call({ userId: 'u2', tenantId: b.id }, 'preview_draft', { draftId: draft.data.id });
    expect(other.isError).toBe(true);
    const edit = await call({ userId: 'u2', tenantId: b.id }, 'update_draft', { draftId: draft.data.id, html: 'x' });
    expect(edit.isError).toBe(true);
  });
});
