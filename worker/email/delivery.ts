/**
 * Delivery tracking (spec §7.6, §9): a Resend webhook updates each email's
 * status, hard bounces and complaints suppress the address, and client mail
 * shows up on the client's timeline ("Delivered Mon 9:02").
 */
import type { AppEnv } from '../env';
import { eventStmts } from '../lib/events';
import { decryptSecretSetting, encryptSecretSetting, getSetting, setSetting } from '../lib/settings';
import { emailProvider } from './index';
import type { DeliveryEvent } from './webhook';

export const WEBHOOK_EVENTS = ['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.bounced', 'email.complained', 'email.failed', 'email.suppressed'];

/** Creates the webhook once (idempotent). Returns false when email isn't configured. */
export async function ensureWebhook(env: AppEnv, origin: string): Promise<boolean> {
  if (await getSetting(env, 'email_webhook')) return true;
  const hook = await emailProvider(env).createWebhook(`${origin}/webhooks/resend`, WEBHOOK_EVENTS);
  await setSetting(env, 'email_webhook', { id: hook.id, secretEnc: await encryptSecretSetting(env, 'email_webhook', hook.signingSecret), createdAt: Date.now() });
  return true;
}

export async function webhookSecret(env: AppEnv): Promise<string | null> {
  const s = await getSetting(env, 'email_webhook');
  return s ? decryptSecretSetting(env, 'email_webhook', s.secretEnc) : null;
}

const STATUS: Record<string, 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed' | null> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': null,
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
};

/** Status only moves forward, so a late "sent" can't overwrite "delivered". */
const RANK: Record<string, number> = { queued: 0, sent: 1, failed: 2, delivered: 3, suppressed: 4, bounced: 4, complained: 5 };

export async function applyDeliveryEvent(env: AppEnv, e: DeliveryEvent): Promise<void> {
  const status = STATUS[e.type];
  const email = await env.DB.prepare('SELECT id, status, client_id, to_user_id, template FROM emails WHERE resend_id = ?')
    .bind(e.emailId)
    .first<{ id: string; status: string; client_id: string | null; to_user_id: string | null; template: string }>();

  // Hard bounces and complaints stop future non-essential mail to the address (even if we can't find the email row).
  const hard = (e.type === 'email.bounced' && e.bounceType !== 'Temporary' && e.bounceType !== 'Transient') || e.type === 'email.complained' || e.type === 'email.suppressed';
  if (hard && e.to.length) {
    await env.DB.prepare(`UPDATE users SET email_suppressed_at = ? WHERE email IN (${e.to.map(() => '?').join(',')}) AND email_suppressed_at IS NULL`)
      .bind(e.at, ...e.to.map((t) => t.toLowerCase()))
      .run();
  }
  if (!email || !status || (RANK[status] ?? 0) <= (RANK[email.status] ?? 0)) return;

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('UPDATE emails SET status = ?, delivered_at = CASE WHEN ? = \'delivered\' THEN ? ELSE delivered_at END WHERE id = ?').bind(status, status, e.at, email.id),
  ];
  if (email.client_id && (status === 'delivered' || status === 'bounced' || status === 'complained')) {
    stmts.push(
      ...eventStmts(env, {
        clientId: email.client_id,
        actor: null,
        type: status === 'delivered' ? 'email.delivered' : 'email.bounced',
        payload: { template: email.template, userId: email.to_user_id },
        at: e.at,
      }),
    );
  }
  await env.DB.batch(stmts);
}
