/**
 * Public, unauthenticated reads: the brand basics the sign-in screen needs,
 * and (dev only) the local email outbox. Nothing here is secret.
 */
import { Hono } from 'hono';
import { readDevOutbox } from '../email/outbox';
import type { AppBindings } from '../env';
import { DEFAULT_ACCENT, getSetting } from '../lib/settings';
import { turnstileConfig } from '../lib/turnstile';

export const publicApi = new Hono<AppBindings>().get('/config', async (c) => {
  const [brand, setup, ts] = await Promise.all([getSetting(c.env, 'brand'), getSetting(c.env, 'setup'), turnstileConfig(c.env)]);
  return c.json(
    {
      firmName: brand?.firmName ?? null,
      shortName: brand?.shortName ?? null,
      accent: brand?.accent ?? DEFAULT_ACCENT,
      welcome: brand?.welcome ?? null,
      setupStatus: setup?.status ?? 'unclaimed',
      turnstileSiteKey: ts?.siteKey ?? null,
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
});

/**
 * Local development and E2E only: read what the outbox provider "sent".
 * Gated on an explicit APP_ENV (not Vite's DEV flag), so no production
 * build can expose it.
 */
export const devApi = new Hono<AppBindings>().get('/outbox', async (c) => {
  if (c.env.APP_ENV !== 'development' && c.env.APP_ENV !== 'test') return c.json({ error: 'not_found' }, 404);
  return c.json({ messages: await readDevOutbox(c.env.KV) });
});
