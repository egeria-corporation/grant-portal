/**
 * Worker entry: one Hono app for HTTP, plus the cron and queue handlers.
 *
 *   /healthz        liveness/readiness
 *   /api/*          JSON API (authz middleware → handlers)
 *   /auth/*         magic links, sessions, passkeys            (M1)
 *   /f/*            authorised file downloads                  (M3)
 *   /brand/*        theme.css, favicon, manifest, OG image     (M2)
 *   /webhooks/*     Resend delivery events                     (M4)
 *   everything else SPA HTML with a per-request CSP nonce, or a static file
 */
import { Hono } from 'hono';
import { health } from './api/health';
import { system } from './api/system';
import type { AppBindings, AppEnv } from './env';
import { serveAsset } from './html';
import { handleQueue, handleScheduled } from './jobs';
import { GENERATED_SECRET_NAMES, resolveSecret, SecretUnavailableError } from './lib/secrets';
import { applySecurityHeaders, newNonce } from './lib/security-headers';

let secretsEnsured = false;

/** Spec §3.2: generate missing secrets on first boot, off the request path. */
async function ensureSecrets(env: AppEnv): Promise<void> {
  try {
    for (const name of GENERATED_SECRET_NAMES) await resolveSecret(env, name);
  } catch (err) {
    // Most likely migrations have not run yet; try again on a later request.
    secretsEnsured = false;
    if (!String(err).includes('no such table')) console.error('[boot] could not initialise secrets', err);
  }
}

export const app = new Hono<AppBindings>();

app.use('*', async (c, next) => {
  c.set('nonce', newNonce());
  c.set('requestId', crypto.randomUUID());
  if (!secretsEnsured) {
    secretsEnsured = true;
    c.executionCtx.waitUntil(ensureSecrets(c.env));
  }
  await next();
  const res = new Response(c.res.body, c.res);
  applySecurityHeaders(res.headers);
  c.res = res;
});

app.route('/healthz', health);
app.route('/api/system', system);

const notFound = (c: { json: (body: unknown, status: 404) => Response }) => c.json({ error: 'not_found' }, 404);
for (const prefix of ['/api/*', '/auth/*', '/f/*', '/brand/*', '/webhooks/*']) app.all(prefix, notFound);

app.on(['GET', 'HEAD'], '*', (c) => serveAsset(c.req.raw, c.env, c.get('nonce')));
app.all('*', (c) => c.json({ error: 'method_not_allowed' }, 405));

app.onError((err, c) => {
  if (err instanceof SecretUnavailableError) {
    return c.json({ error: 'initialising' }, 503, { 'Retry-After': '5' });
  }
  console.error(`[${c.get('requestId')}]`, err);
  return c.json({ error: 'internal_error', requestId: c.get('requestId') }, 500);
});

export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduled(controller, env));
  },
  async queue(batch, env) {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<AppEnv>;
