/**
 * Worker entry: one Hono app for HTTP, plus the cron and queue handlers.
 *
 *   /healthz        liveness/readiness
 *   /api/*          JSON API (authz middleware → handlers)
 *   /auth/*         POST: magic links, codes, passkeys, sign-out; GET: SPA pages
 *   /f/*            authorised file downloads                  (M3)
 *   /brand/*        theme.css, icon, manifest, OG image, uploaded brand files
 *   /webhooks/*     Resend delivery events                     (M4)
 *   everything else SPA HTML with a per-request CSP nonce, or a static file
 */
import { Hono } from 'hono';
import { me, passkeysApi, portal, sessions } from './api/account';
import { clients, demo } from './api/clients';
import { health } from './api/health';
import { devApi, publicApi } from './api/public';
import { settingsApi } from './api/settings';
import { setup } from './api/setup';
import { system } from './api/system';
import { team } from './api/team';
import { csrf } from './auth/csrf';
import { auth } from './auth/routes';
import { brand } from './brand/routes';
import { loadSession } from './auth/session';
import type { AppBindings, AppEnv } from './env';
import { HttpError } from './lib/http';
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

app.use('*', csrf);
app.use('/api/*', loadSession);
app.use('/auth/*', loadSession);

app.route('/healthz', health);
app.route('/brand', brand);
app.route('/auth', auth);
app.route('/api/public', publicApi);
app.route('/api/dev', devApi);
app.route('/api/setup', setup);
app.route('/api/me', me);
app.route('/api/sessions', sessions);
app.route('/api/passkeys', passkeysApi);
app.route('/api/settings', settingsApi);
app.route('/api/team', team);
app.route('/api/clients', clients);
app.route('/api/demo', demo);
app.route('/api/portal', portal);
app.route('/api/system', system);

const notFound = (c: { json: (body: unknown, status: 404) => Response }) => c.json({ error: 'not_found' }, 404);
for (const prefix of ['/api/*', '/f/*', '/brand/*', '/webhooks/*']) app.all(prefix, notFound);

app.on(['GET', 'HEAD'], '*', (c) => serveAsset(c.req.raw, c.env, c.get('nonce')));
app.all('*', (c) => c.json({ error: 'method_not_allowed' }, 405));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    const headers: Record<string, string> = {};
    if (err.status === 429 && typeof err.extra.retryAfterSec === 'number') headers['Retry-After'] = String(err.extra.retryAfterSec);
    return c.json({ error: err.code, ...err.extra }, err.status, headers);
  }
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
