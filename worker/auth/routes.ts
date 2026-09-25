/**
 * /auth/* — sign-in endpoints. GET requests under /auth fall through to the
 * SPA (e.g. /auth/verify renders the interstitial); only POSTs land here, so a
 * link scanner that GETs the email link can never consume it (spec §7.1).
 */
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { Hono } from 'hono';
import { z } from 'zod';
import { sendEmail } from '../email';
import { signInEmail } from '../email/templates/auth';
import type { AppBindings, AppEnv } from '../env';
import { audit } from '../lib/audit';
import { clientIp, HttpError, keyedHash, normalizeEmail, parseJson, publicOrigin, emailField } from '../lib/http';
import { enforce, LIMITS } from '../lib/rate-limit';
import { turnstileConfig, verifyTurnstile } from '../lib/turnstile';
import { authOf, requireAuth, requireStaffAccount } from './guards';
import { consumeCode, consumeLink, createLink, peekLink, SIGNIN_TTL_MS } from './magic';
import {
  authenticationOptions,
  registrationOptions,
  relyingParty,
  verifyAuthentication,
  verifyRegistration,
} from './passkeys';
import { revokeAllForUser, revokeCurrent, rotateSession } from './session';
import { completeLink, firmName, homeFor, startSession, userByEmail, userById } from './signin';


const token = z.string().max(64);

/** Runs after the response is sent, so timing never depends on whether the email exists. */
async function sendSignInLink(env: AppEnv, to: string, origin: string, ipHash: string, uaHash: string) {
  const user = await userByEmail(env, to);
  if (!user || user.disabled_at) return;
  const link = await createLink(env, {
    email: to,
    purpose: 'signin',
    ttlMs: SIGNIN_TTL_MS,
    withCode: true,
    ipHash,
    uaHash,
    supersede: true,
  });
  const rendered = signInEmail({
    firm: await firmName(env),
    link: `${origin}/auth/verify?t=${link.token}`,
    code: link.code ?? '',
    minutes: SIGNIN_TTL_MS / 60_000,
  });
  await sendEmail(env, { to, template: 'magic_link', rendered, userId: user.id });
}

export const auth = new Hono<AppBindings>()
  .post('/magic/request', async (c) => {
    const body = await parseJson(c, z.object({ email: emailField, turnstileToken: z.string().max(2048).optional() }));
    const to = normalizeEmail(body.email);
    const ip = clientIp(c.req.raw);

    const ts = await turnstileConfig(c.env);
    if (ts && !(await verifyTurnstile(ts, body.turnstileToken, ip))) throw new HttpError(403, 'turnstile_failed');
    await enforce(c, LIMITS.magicPerIp, ip);
    await enforce(c, LIMITS.magicPerEmail, to);

    const ipHash = await keyedHash(c, 'ip', ip);
    const uaHash = await keyedHash(c, 'ua', c.req.header('User-Agent') ?? '');
    const origin = publicOrigin(c.req.raw);
    const env = c.env;
    c.executionCtx.waitUntil(sendSignInLink(env, to, origin, ipHash, uaHash).catch(() => undefined));
    // Identical for known and unknown addresses (spec §6.1: no enumeration).
    return c.json({ ok: true }, 202);
  })

  .post('/link/peek', async (c) => {
    await enforce(c, LIMITS.consumePerIp, clientIp(c.req.raw));
    const body = await parseJson(c, z.object({ token }));
    const link = await peekLink(c.env, body.token);
    if (!link) throw new HttpError(410, 'link_invalid');
    return c.json({ purpose: link.purpose, email: link.email, firm: await firmName(c.env), expiresAt: link.expires_at });
  })

  .post('/link/consume', async (c) => {
    await enforce(c, LIMITS.consumePerIp, clientIp(c.req.raw));
    const body = await parseJson(c, z.object({ token }));
    const link = await consumeLink(c.env, body.token);
    if (!link) throw new HttpError(410, 'link_invalid');
    if (c.get('auth')) await revokeCurrent(c);
    return c.json(await completeLink(c, link));
  })

  .post('/code/verify', async (c) => {
    await enforce(c, LIMITS.codePerIp, clientIp(c.req.raw));
    const body = await parseJson(
      c,
      z.object({ email: emailField, code: z.string().max(12), purpose: z.enum(['signin', 'setup']).default('signin') }),
    );
    const result = await consumeCode(c.env, normalizeEmail(body.email), body.purpose, body.code.replace(/\s/g, ''));
    if (!result.ok) {
      await audit(c, { actor: null, action: result.reason === 'locked' ? 'auth.code_locked' : 'auth.code_failed' });
      throw new HttpError(result.reason === 'locked' ? 410 : 400, result.reason === 'locked' ? 'code_locked' : 'code_invalid');
    }
    if (c.get('auth')) await revokeCurrent(c);
    return c.json(await completeLink(c, result.link));
  })

  .post('/passkey/options', async (c) => {
    await enforce(c, LIMITS.passkeyPerIp, clientIp(c.req.raw));
    return c.json(await authenticationOptions(c.env, relyingParty(c.req.raw, await firmName(c.env))));
  })

  .post('/passkey/verify', async (c) => {
    await enforce(c, LIMITS.passkeyPerIp, clientIp(c.req.raw));
    const body = await parseJson(
      c,
      z.object({ challengeId: z.string().max(64), response: z.looseObject({ id: z.string().max(1024) }) }),
    );
    const rp = relyingParty(c.req.raw, await firmName(c.env));
    const userId = await verifyAuthentication(
      c.env,
      rp,
      body.challengeId,
      body.response as unknown as AuthenticationResponseJSON,
    );
    const row = await userById(c.env, userId);
    if (!row || row.disabled_at || row.kind !== 'staff') throw new HttpError(400, 'passkey_invalid');

    const current = c.get('auth');
    if (current?.user.id === userId) {
      // Step-up on the existing session: rotate the ID and stamp the time.
      await rotateSession(c, { stepUp: true });
      await audit(c, { action: 'passkey.step_up', target: userId });
      return c.json({ redirect: await homeFor(c.env, row), stepUp: true });
    }
    if (current) await revokeCurrent(c);
    const user = { id: row.id, email: row.email, name: row.name, kind: row.kind, role: row.role, allClients: Boolean(row.all_clients) };
    return c.json(await startSession(c, user, 'passkey'));
  })

  .post('/passkey/register/options', requireStaffAccount, async (c) => {
    const user = authOf(c).user;
    return c.json(await registrationOptions(c.env, relyingParty(c.req.raw, await firmName(c.env)), user));
  })

  .post('/passkey/register/verify', requireStaffAccount, async (c) => {
    const user = authOf(c).user;
    const body = await parseJson(
      c,
      z.object({
        challengeId: z.string().max(64),
        label: z.string().trim().max(60).optional(),
        response: z.looseObject({ id: z.string().max(1024) }),
      }),
    );
    const rp = relyingParty(c.req.raw, await firmName(c.env));
    const out = await verifyRegistration(
      c.env,
      rp,
      user,
      body.challengeId,
      body.response as unknown as RegistrationResponseJSON,
      body.label || null,
    );
    // Adding a credential is a privilege change: rotate the session ID.
    await rotateSession(c, { stepUp: true });
    await audit(c, { action: 'passkey.registered', target: out.id });
    return c.json(out, 201);
  })

  .post('/signout', async (c) => {
    const current = c.get('auth');
    await revokeCurrent(c);
    if (current) await audit(c, { actor: current.user.id, action: 'auth.signout', target: current.session.publicId });
    return c.json({ ok: true });
  })

  .post('/signout-all', requireAuth, async (c) => {
    const current = authOf(c);
    const count = await revokeAllForUser(c.env, current.user.id);
    await revokeCurrent(c);
    await audit(c, { actor: current.user.id, action: 'auth.signout_all', target: current.user.id, meta: { count } });
    return c.json({ ok: true, revoked: count });
  });
