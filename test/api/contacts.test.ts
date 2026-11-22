import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, createTenant } from '../helpers';

const addContact = (key: string, body: object) =>
  api(key, '/v1/contacts', { method: 'POST', body: JSON.stringify(body) });

describe('POST /v1/contacts', () => {
  it('creates a contact with a lowercased address, adds it to named lists, and is idempotent', async () => {
    const t = await createTenant();

    const first = await addContact(t.apiKey, { email: 'Reader@Example.com', name: 'Reader', externalId: 'u1', lists: ['beacon'] });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string; email: string };
    expect(created.email).toBe('reader@example.com');

    const again = await addContact(t.apiKey, { email: 'reader@example.com', lists: ['beacon'] });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(created.id);

    const members = await env.DB.prepare(
      'select count(*) as n from list_members lm join lists l on l.id = lm.list_id where l.tenant_id = ? and l.name = ?',
    ).bind(t.id, 'beacon').first<{ n: number }>();
    expect(members?.n).toBe(1);
  });

  it('rejects an invalid address', async () => {
    const t = await createTenant();
    expect((await addContact(t.apiKey, { email: 'not-an-address' })).status).toBe(400);
  });

  it("never touches another tenant's contacts", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const ca = (await (await addContact(a.apiKey, { email: 'same@example.com' })).json()) as { id: string };
    const cb = (await (await addContact(b.apiKey, { email: 'same@example.com' })).json()) as { id: string };

    expect(ca.id).not.toBe(cb.id);
    const check = await api(b.apiKey, '/v1/suppressions/check?email=same@example.com');
    expect(await check.json()).toEqual({ suppressed: false, kinds: [] });
  });
});

describe('suppressions', () => {
  it('records a suppression and reports which kinds apply to an address', async () => {
    const t = await createTenant();
    const add = await api(t.apiKey, '/v1/suppressions', {
      method: 'POST',
      body: JSON.stringify({ email: 'Bounced@Example.com', kind: 'hard_bounce' }),
    });
    expect(add.status).toBe(201);

    const check = await api(t.apiKey, '/v1/suppressions/check?email=bounced@example.com');
    expect(await check.json()).toEqual({ suppressed: true, kinds: ['hard_bounce'] });
  });

  it("does not leak one tenant's suppressions to another", async () => {
    const a = await createTenant();
    const b = await createTenant();
    await api(a.apiKey, '/v1/suppressions', { method: 'POST', body: JSON.stringify({ email: 'x@example.com', kind: 'complaint' }) });

    const check = await api(b.apiKey, '/v1/suppressions/check?email=x@example.com');
    expect(await check.json()).toEqual({ suppressed: false, kinds: [] });
  });
});

describe('POST /v1/contacts/erase', () => {
  it('suppresses the address first, then deletes the contact and its list memberships, idempotently', async () => {
    const t = await createTenant();
    await addContact(t.apiKey, { email: 'gone@example.com', lists: ['beacon'] });

    const erase = () => api(t.apiKey, '/v1/contacts/erase', { method: 'POST', body: JSON.stringify({ email: 'Gone@Example.com' }) });
    const res = await erase();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ erased: true });

    const left = await env.DB.prepare('select count(*) as n from contacts where tenant_id = ? and email = ?')
      .bind(t.id, 'gone@example.com').first<{ n: number }>();
    expect(left?.n).toBe(0);
    const members = await env.DB.prepare(
      'select count(*) as n from list_members lm join lists l on l.id = lm.list_id where l.tenant_id = ?',
    ).bind(t.id).first<{ n: number }>();
    expect(members?.n).toBe(0);
    const plain = await env.DB.prepare("select count(*) as n from suppressions where address_hash like '%@%'").first<{ n: number }>();
    expect(plain?.n).toBe(0);

    const check = await api(t.apiKey, '/v1/suppressions/check?email=gone@example.com');
    expect(await check.json()).toEqual({ suppressed: true, kinds: ['erased'] });
    expect((await erase()).status).toBe(200);
  });
});

describe('erasure reaches transactional send records', () => {
  it('deletes transactional_messages rows for the erased address', async () => {
    const t = await createTenant();
    const { addressHash } = await import('../../src/lib/address');
    await env.DB.prepare("insert into transactional_messages (id, tenant_id, template, address_hash, status) values (?, ?, 'login', ?, 'sent')")
      .bind(crypto.randomUUID(), t.id, await addressHash('gone@example.com')).run();

    await api(t.apiKey, '/v1/contacts/erase', { method: 'POST', body: JSON.stringify({ email: 'gone@example.com' }) });

    const n = await env.DB.prepare('select count(*) as n from transactional_messages where tenant_id = ?').bind(t.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
