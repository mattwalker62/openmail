import { Hono } from 'hono';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();

// Liveness plus a real round trip to D1, so a broken binding shows up here first.
app.get('/health', async (c) => {
  await c.env.DB.prepare('select 1').first();
  return c.json({ ok: true, db: 'ok' });
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;
