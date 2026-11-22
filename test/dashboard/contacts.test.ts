import { describe, expect, it } from 'vitest';
import { api, asOwner, createTenant, signInOwner } from '../helpers';

const list = async (cookie: string, path: string) => (await (await asOwner(cookie, path)).json()) as Record<string, any>;

describe('GET /api/t/:id/contacts', () => {
  it('lists contacts newest first with their lists and status, searchable and paged', async () => {
    const t = await createTenant();
    const { cookie } = await signInOwner(t.slug);
    for (const e of ['ana', 'ben', 'chloe']) {
      await api(t.apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email: `${e}@x.com`, lists: ['beacon'] }) });
    }
    await api(t.apiKey, '/v1/suppressions', { method: 'POST', body: JSON.stringify({ email: 'ben@x.com', kind: 'hard_bounce' }) });

    const all = await list(cookie, `/api/t/${t.id}/contacts`);
    expect(all.total).toBe(3);
    expect(all.contacts.map((c: { email: string }) => c.email).sort()).toEqual(['ana@x.com', 'ben@x.com', 'chloe@x.com']);
    expect(all.contacts.find((c: { email: string }) => c.email === 'ben@x.com')).toMatchObject({ lists: ['beacon'], status: 'bounced' });
    expect(all.contacts.find((c: { email: string }) => c.email === 'ana@x.com')).toMatchObject({ status: 'subscribed' });

    expect((await list(cookie, `/api/t/${t.id}/contacts?q=chl`)).contacts.map((c: { email: string }) => c.email)).toEqual(['chloe@x.com']);

    const page1 = await list(cookie, `/api/t/${t.id}/contacts?limit=2`);
    expect(page1.contacts).toHaveLength(2);
    const page2 = await list(cookie, `/api/t/${t.id}/contacts?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`);
    expect(page2.contacts).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
  });

  it("refuses another business's contacts and treats % and _ in search as plain text", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const { cookie } = await signInOwner(a.slug);
    await api(a.apiKey, '/v1/contacts', { method: 'POST', body: JSON.stringify({ email: 'x@y.com' }) });
    expect((await asOwner(cookie, `/api/t/${b.id}/contacts`)).status).toBe(403);
    expect((await list(cookie, `/api/t/${a.id}/contacts?q=%25`)).contacts).toEqual([]);
  });
});
