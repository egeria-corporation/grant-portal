/**
 * Picks the email provider and sender address, and records each send in the
 * `emails` table (spec §9). Magic-link content is never stored.
 */
import type { AppEnv } from '../env';
import { isDev } from '../env';
import { newId } from '../lib/ids';
import { getSetting } from '../lib/settings';
import { OutboxProvider } from './outbox';
import type { EmailProvider } from './provider';
import { EmailNotConfiguredError } from './provider';
import { ResendProvider } from './resend';
import type { Rendered } from './templates/render';

/**
 * Resend's shared test sender. It only delivers to the address that owns the
 * Resend account (spec Appendix A), which is exactly what the claim step needs:
 * only the person holding the API key's account can claim the portal.
 */
export const RESEND_TEST_SENDER = 'onboarding@resend.dev';

export function emailProvider(env: AppEnv): EmailProvider {
  if (env.APP_ENV === 'test') return new OutboxProvider();
  if (env.RESEND_API_KEY) return new ResendProvider(env.RESEND_API_KEY);
  if (isDev(env)) return new OutboxProvider(env.KV);
  throw new EmailNotConfiguredError();
}

export function emailConfigured(env: AppEnv): boolean {
  return env.APP_ENV === 'test' || Boolean(env.RESEND_API_KEY) || isDev(env);
}

/** Strips characters that could break out of a display name in a From header. */
export function displayName(name: string): string {
  return name.replace(/[\r\n"<>\\,;:@]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export interface Sender {
  from: string;
  /** True when mail goes out from the consultant's own verified domain. */
  verified: boolean;
}

/** Sender for everyday mail: the verified domain if there is one, else the shared test sender. */
export async function sender(env: AppEnv): Promise<Sender> {
  const [email, brand] = await Promise.all([getSetting(env, 'email'), getSetting(env, 'brand')]);
  const name = displayName(email?.fromName || brand?.firmName || '');
  if (email?.status === 'verified' && email.domain && email.fromLocal) {
    const address = `${email.fromLocal}@${email.domain}`;
    return { from: name ? `${name} <${address}>` : address, verified: true };
  }
  return { from: name ? `${name} <${RESEND_TEST_SENDER}>` : RESEND_TEST_SENDER, verified: false };
}

/** Client and team email is blocked until the sending domain is verified (spec §3.4). */
export async function canEmailOthers(env: AppEnv): Promise<boolean> {
  return (await sender(env)).verified;
}

/**
 * Sends one email and records it in `emails` (spec §9). Transactional and
 * sign-in mail always goes out; everything else is skipped (and recorded as
 * `suppressed`) for addresses that hard-bounced or complained (spec §7.6).
 * Returns the `emails` row ID.
 */
export async function sendEmail(
  env: AppEnv,
  p: {
    to: string;
    template: string;
    rendered: Rendered;
    from?: string;
    userId?: string | null;
    clientId?: string | null;
    category?: 'auth' | 'transactional' | 'activity' | 'reminders' | 'updates';
    headers?: Record<string, string>;
    suppressed?: boolean;
  },
): Promise<string> {
  const id = newId('eml');
  const category = p.category ?? 'auth';
  const skip = Boolean(p.suppressed) && category !== 'auth' && category !== 'transactional';
  await env.DB.prepare(
    `INSERT INTO emails (id, to_user_id, to_email, client_id, template, category, subject, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, p.userId ?? null, p.to, p.clientId ?? null, p.template, category, p.rendered.subject, skip ? 'suppressed' : 'queued', Date.now())
    .run();
  if (skip) return id;
  const from = p.from ?? (await sender(env)).from;
  try {
    const out = await emailProvider(env).send({
      from,
      to: p.to,
      subject: p.rendered.subject,
      text: p.rendered.text,
      html: p.rendered.html,
      headers: p.headers && Object.keys(p.headers).length ? p.headers : undefined,
    });
    await env.DB.prepare("UPDATE emails SET status = 'sent', resend_id = ? WHERE id = ?").bind(out.id, id).run();
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : 'send failed';
    await env.DB.prepare("UPDATE emails SET status = 'failed', error = ? WHERE id = ?").bind(message, id).run();
    console.error(`[email] ${p.template} send failed: ${message}`);
    throw err;
  }
  return id;
}
