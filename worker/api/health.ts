import { Hono } from 'hono';
import type { AppBindings } from '../env';

declare const __APP_VERSION__: string;

/**
 * Liveness + readiness. Public, so it reports only coarse states — no counts,
 * config, or secret status.
 */
export const health = new Hono<AppBindings>().get('/', async (c) => {
  let db: 'ok' | 'migrations_pending' | 'error' = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1 FROM orgs LIMIT 1').first();
  } catch (err) {
    db = String(err).includes('no such table') ? 'migrations_pending' : 'error';
  }
  const ok = db === 'ok';
  return c.json(
    { status: ok ? 'ok' : 'degraded', version: __APP_VERSION__, checks: { db } },
    ok ? 200 : 503,
    { 'Cache-Control': 'no-store' },
  );
});
