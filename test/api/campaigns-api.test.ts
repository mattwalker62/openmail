import { describe, expect, it } from 'vitest';
import { api, createTenant } from '../helpers';

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

describe('/v1 drafts and campaigns', () => {
  it('creates and edits a draft, requests a campaign that waits for a human, and lets the app cancel it', async () => {
    const t = await createTenant();
    await api(t.apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email: 'a@x.com', lists: ['beacon'] }) });

    const draft = await json(await api(t.apiKey, '/v1/drafts', { method: 'POST', body: JSON.stringify({ subject: 'S', html: '<p>1</p>' }) }));
    expect(draft).toMatchObject({ version: 1 });
    const edited = await json(await api(t.apiKey, `/v1/drafts/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ html: '<p>2</p>' }) }));
    expect(edited).toMatchObject({ version: 2 });

    const res = await api(t.apiKey, '/v1/campaigns', { method: 'POST', body: JSON.stringify({ draftId: draft.id, list: 'beacon' }) });
    expect(res.status).toBe(202);
    const campaign = await json(res);
    expect(campaign).toMatchObject({ status: 'needs_approval' });

    const got = await json(await api(t.apiKey, `/v1/campaigns/${campaign.campaignId}`));
    expect(got).toMatchObject({ status: 'awaiting_approval', draftVersion: 2 });

    const cancel = await api(t.apiKey, `/v1/campaigns/${campaign.campaignId}/cancel`, { method: 'POST' });
    expect(await json(cancel)).toEqual({ ok: true, status: 'cancelled' });
  });

  it("can't read or touch another tenant's draft or campaign", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const draft = await json(await api(a.apiKey, '/v1/drafts', { method: 'POST', body: JSON.stringify({ subject: 'S', html: 'h' }) }));

    expect((await api(b.apiKey, `/v1/drafts/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ html: 'x' }) })).status).toBe(404);
    expect((await api(b.apiKey, '/v1/campaigns', { method: 'POST', body: JSON.stringify({ draftId: draft.id, list: 'beacon' }) })).status).toBe(404);
  });

  it('rejects a draft without a subject or body', async () => {
    const t = await createTenant();
    expect((await api(t.apiKey, '/v1/drafts', { method: 'POST', body: JSON.stringify({ subject: '' }) })).status).toBe(400);
  });
});
