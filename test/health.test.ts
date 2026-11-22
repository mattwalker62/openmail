import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('GET /health', () => {
  it('reports the Worker and its D1 database as up', async () => {
    const res = await SELF.fetch('https://openmail.test/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: 'ok' });
  });
});

describe('unknown routes', () => {
  it('answer 404 with a JSON error body', async () => {
    const res = await SELF.fetch('https://openmail.test/nope');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
