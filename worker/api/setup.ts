/**
 * First-run wizard, step 1: claim this portal (spec §3.3).
 *
 * Two ways to prove you own the deployment:
 *  1. Email: a setup link + code sent from Resend's shared test sender, which
 *     only delivers to the Resend account owner (DECISIONS D-019).
 *  2. Setup code: printed to the Worker logs, for when email fails.
 * The first claimant to finish wins; everything here 409s once claimed.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { authOf, requireOwner } from '../auth/guards';
import { createLink, SIGNIN_TTL_MS } from '../auth/magic';
import { claimPortal, startSession } from '../auth/signin';
import { emailConfigured, RESEND_TEST_SENDER, sendEmail } from '../email';
import { EmailNotConfiguredError } from '../email/provider';
import { setupEmail } from '../email/templates/auth';
import type { AppBindings, AppEnv } from '../env';
import { audit } from '../lib/audit';
import { randomBytes, sha256Hex, timingSafeEqual, toHex } from '../lib/crypto';
import { clientIp, HttpError, normalizeEmail, parseJson, publicOrigin, emailField } from '../lib/http';
import { DEFAULT_ORG_ID } from '../db/schema';
import { enforce, LIMITS } from '../lib/rate-limit';
import { deleteSetting, getSetting, setSetting } from '../lib/settings';

export const SETUP_CODE_MAX_ATTEMPTS = 10;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const WIZARD_STEPS = ['brand', 'email', 'domain', 'opengrants', 'team', 'client'] as const;

/** 12 Crockford base32 characters (60 bits), shown as XXXX-XXXX-XXXX. */
function newSetupCode(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (const b of bytes) out += CROCKFORD[b & 31];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

const normalizeSetupCode = (v: string) => v.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');

async function isClaimed(env: AppEnv): Promise<boolean> {
  return (await getSetting(env, 'setup')) !== null;
}

/** Mints a setup code and prints it to the Worker logs. `replace` rotates an existing one. */
export async function issueSetupCode(env: AppEnv, replace: boolean): Promise<void> {
  const code = newSetupCode();
  const salt = toHex(randomBytes(16));
  const value = JSON.stringify({ hash: await sha256Hex(normalizeSetupCode(code) + salt), salt, attempts: 0, createdAt: Date.now() });
  const res = await env.DB.prepare(
    `INSERT INTO settings (org_id, key, value_json, updated_at) VALUES (?, 'setup_code', ?, ?)
     ON CONFLICT (org_id, key) DO ${replace ? 'UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at' : 'NOTHING'}`,
  )
    .bind(DEFAULT_ORG_ID, value, Date.now())
    .run();
  if (res.meta.changes) {
    // Deliberately logged: this is the out-of-band channel (Workers → your Worker → Logs).
    console.log(`[setup] Portal setup code: ${code} (single use; claim at /setup)`);
  }
}

/** Counts an attempt atomically, then compares. Too many failures burn the code. */
async function checkSetupCode(env: AppEnv, code: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `UPDATE settings SET value_json = json_set(value_json, '$.attempts', json_extract(value_json, '$.attempts') + 1)
      WHERE org_id = ? AND key = 'setup_code' AND json_extract(value_json, '$.attempts') < ?
      RETURNING value_json`,
  )
    .bind(DEFAULT_ORG_ID, SETUP_CODE_MAX_ATTEMPTS)
    .first<{ value_json: string }>();
  if (!row) return false;
  const stored = JSON.parse(row.value_json) as { hash: string; salt: string; attempts: number };
  const ok = timingSafeEqual(await sha256Hex(normalizeSetupCode(code) + stored.salt), stored.hash);
  if (!ok && stored.attempts >= SETUP_CODE_MAX_ATTEMPTS) await deleteSetting(env, 'setup_code');
  return ok;
}

export const setup = new Hono<AppBindings>()
  /** Public: just enough for the SPA to route to the wizard or sign-in. */
  .get('/status', async (c) => {
    const state = await getSetting(c.env, 'setup');
    if (!state) c.executionCtx.waitUntil(issueSetupCode(c.env, false).catch(() => undefined));
    return c.json(
      { status: state?.status ?? 'unclaimed', emailConfigured: emailConfigured(c.env) },
      200,
      { 'Cache-Control': 'no-store' },
    );
  })

  .post('/claim', async (c) => {
    await enforce(c, LIMITS.setupPerIp, clientIp(c.req.raw));
    if (await isClaimed(c.env)) throw new HttpError(409, 'already_claimed');
    const body = await parseJson(c, z.object({ email: emailField }));
    const to = normalizeEmail(body.email);
    const link = await createLink(c.env, { email: to, purpose: 'setup', ttlMs: SIGNIN_TTL_MS, withCode: true, supersede: true });
    const rendered = setupEmail({
      link: `${publicOrigin(c.req.raw)}/auth/verify?t=${link.token}`,
      code: link.code ?? '',
      minutes: SIGNIN_TTL_MS / 60_000,
    });
    try {
      await sendEmail(c.env, { to, template: 'setup', rendered, from: `Portal setup <${RESEND_TEST_SENDER}>` });
    } catch (err) {
      if (err instanceof EmailNotConfiguredError) throw new HttpError(503, 'email_not_configured');
      throw new HttpError(503, 'email_failed');
    }
    return c.json({ sent: true });
  })

  /** Prints a fresh setup code to the logs (the old one stops working). */
  .post('/setup-code', async (c) => {
    await enforce(c, LIMITS.setupPerIp, clientIp(c.req.raw));
    if (await isClaimed(c.env)) throw new HttpError(409, 'already_claimed');
    await issueSetupCode(c.env, true);
    return c.json({ ok: true });
  })

  .post('/claim-with-code', async (c) => {
    await enforce(c, LIMITS.setupPerIp, clientIp(c.req.raw));
    if (await isClaimed(c.env)) throw new HttpError(409, 'already_claimed');
    const body = await parseJson(
      c,
      z.object({ email: emailField, name: z.string().trim().max(80).optional(), setupCode: z.string().max(32) }),
    );
    if (!(await checkSetupCode(c.env, body.setupCode))) {
      await audit(c, { actor: null, action: 'setup.code_failed' });
      throw new HttpError(400, 'setup_code_invalid');
    }
    const user = await claimPortal(c.env, normalizeEmail(body.email), body.name || null);
    await deleteSetting(c.env, 'setup_code');
    await audit(c, { actor: user.id, action: 'setup.claimed', target: user.id, meta: { method: 'setup_code' } });
    return c.json(await startSession(c, user, 'code'));
  })

  /** Owner: mark a wizard step done or skipped. */
  .put('/steps/:step', requireOwner, async (c) => {
    const step = z.enum(WIZARD_STEPS).safeParse(c.req.param('step'));
    if (!step.success) throw new HttpError(404, 'not_found');
    const body = await parseJson(c, z.object({ state: z.enum(['done', 'skipped']) }));
    const current = await getSetting(c.env, 'setup');
    if (!current) throw new HttpError(409, 'not_claimed');
    await setSetting(c.env, 'setup', { ...current, steps: { ...current.steps, [step.data]: body.state } });
    return c.json({ ok: true });
  })

  .get('/progress', requireOwner, async (c) => {
    const current = await getSetting(c.env, 'setup');
    return c.json({ status: current?.status ?? 'unclaimed', steps: current?.steps ?? {} });
  })

  .post('/complete', requireOwner, async (c) => {
    const current = await getSetting(c.env, 'setup');
    if (!current) throw new HttpError(409, 'not_claimed');
    if (current.status !== 'complete') {
      await setSetting(c.env, 'setup', { ...current, status: 'complete', completedAt: Date.now() });
      await audit(c, { actor: authOf(c).user.id, action: 'setup.completed' });
    }
    return c.json({ ok: true });
  });
