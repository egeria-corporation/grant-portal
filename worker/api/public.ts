/**
 * Public, unauthenticated reads: the brand basics the sign-in screen needs,
 * and (dev only) the local email outbox. Nothing here is secret.
 */
import { demoMode } from '../demo/mode';
import { Hono } from 'hono';
import { readDevOutbox } from '../email/outbox';
import { assetUrl, getBrandState } from '../brand/state';
import type { AppBindings } from '../env';
import { getSetting } from '../lib/settings';
import { turnstileConfig } from '../lib/turnstile';

export const publicApi = new Hono<AppBindings>().get('/config', async (c) => {
  const [brand, setup, ts] = await Promise.all([getBrandState(c.env), getSetting(c.env, 'setup'), turnstileConfig(c.env)]);
  return c.json(
    {
      firmName: brand.firmName,
      shortName: brand.shortName,
      accent: brand.theme.accent,
      welcome: brand.welcome,
      theme: brand.theme,
      brandVersion: brand.version,
      logoLight: assetUrl(brand, 'logo-light'),
      logoDark: assetUrl(brand, 'logo-dark'),
      mark: assetUrl(brand, 'mark'),
      poweredBy: brand.poweredBy,
      /** Dev-only pages (the kitchen sink) render only when this is true. */
      devTools: c.env.APP_ENV === 'development' || c.env.APP_ENV === 'test' || import.meta.env.DEV,
      setupStatus: setup?.status ?? 'unclaimed',
      turnstileSiteKey: ts?.siteKey ?? null,
      /** Public demo deployment (worker/demo/mode.ts): the sign-in page offers demo entry. */
      demo: demoMode(c.env),
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
});

/** Hosts no deployment can be reached on: loopback and the reserved `.localhost` and `.test` names. */
function localHost(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost') || host.endsWith('.test');
}

/**
 * Local development and E2E only: read what the outbox provider "sent".
 * Gated on an explicit APP_ENV (not Vite's DEV flag), so no production
 * build can expose it. A development build that reaches a real deployment by
 * mistake still refuses: it also needs a local host and no Resend key.
 */
export const devApi = new Hono<AppBindings>().get('/outbox', async (c) => {
  const devEnv = c.env.APP_ENV === 'development' || c.env.APP_ENV === 'test';
  if (!devEnv || c.env.RESEND_API_KEY || !localHost(c.req.url)) return c.json({ error: 'not_found' }, 404);
  return c.json({ messages: await readDevOutbox(c.env.KV) });
});
