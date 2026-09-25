/**
 * Turnstile (spec §4.1, §7.1) on the magic-link request form.
 *
 * Keys come from a Worker secret/var if set, otherwise from Settings (stored
 * encrypted). With no keys configured, requests are not challenged and the
 * Owner sees an "Add Turnstile" notice; the KV rate limits still apply.
 * Cloudflare's documented test secrets are answered locally so dev and tests
 * never call out. See docs/DECISIONS.md D-002, D-021.
 */
import type { AppEnv } from '../env';
import { decryptSecretSetting, getSetting } from './settings';

export const TEST_KEYS = {
  alwaysPass: { siteKey: '1x00000000000000000000AA', secret: '1x0000000000000000000000000000000AA' },
  alwaysFail: { siteKey: '2x00000000000000000000AB', secret: '2x0000000000000000000000000000000AA' },
} as const;

export interface TurnstileConfig {
  siteKey: string;
  secret: string;
  source: 'env' | 'settings';
}

export async function turnstileConfig(env: AppEnv): Promise<TurnstileConfig | null> {
  if (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) {
    return { siteKey: env.TURNSTILE_SITE_KEY, secret: env.TURNSTILE_SECRET_KEY, source: 'env' };
  }
  const stored = await getSetting(env, 'turnstile');
  if (!stored) return null;
  const secret = await decryptSecretSetting(env, 'turnstile', stored.secretEnc);
  return secret ? { siteKey: stored.siteKey, secret, source: 'settings' } : null;
}

export async function verifyTurnstile(
  config: TurnstileConfig,
  token: string | undefined,
  ip: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  if (config.secret === TEST_KEYS.alwaysPass.secret) return true;
  if (config.secret === TEST_KEYS.alwaysFail.secret) return false;
  try {
    const body = new FormData();
    body.set('secret', config.secret);
    body.set('response', token);
    body.set('remoteip', ip);
    body.set('idempotency_key', crypto.randomUUID());
    const res = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    if (!res.ok) return false;
    const out = (await res.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    // Fail closed: an unreachable verifier must not open the email endpoint.
    return false;
  }
}
