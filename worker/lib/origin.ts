/**
 * The portal's public origin for links in email. Requests know their own
 * origin; cron and queue jobs don't, so the origin of the last staff sign-in
 * is remembered, and an active custom domain always wins.
 */
import type { AppEnv } from '../env';
import { getSetting, setSetting } from './settings';

const DAY = 86_400_000;

export async function rememberOrigin(env: AppEnv, requestUrl: string): Promise<void> {
  const url = new URL(requestUrl).origin;
  if (!url.startsWith('https://') && env.APP_ENV === 'production') return;
  const current = await getSetting(env, 'origin');
  if (current?.url === url && Date.now() - current.seenAt < DAY) return;
  await setSetting(env, 'origin', { url, seenAt: Date.now() });
}

export async function portalOrigin(env: AppEnv): Promise<string | null> {
  const [domain, origin] = await Promise.all([getSetting(env, 'domain'), getSetting(env, 'origin')]);
  if (domain?.status === 'active') return `https://${domain.hostname}`;
  return origin?.url ?? null;
}
