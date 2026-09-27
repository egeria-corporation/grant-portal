/**
 * Who hears about what, and when (spec §5.7, §9). Actions call `notify()`,
 * which works out the recipients on the other side, applies each person's
 * preferences, and either queues an email now or saves it for their digest.
 * Sending happens in the queue consumer (API → Queue → Resend, spec §9).
 *
 * Categories:
 * - transactional: document requests. Always sent (spec §9).
 * - activity: new versions, decisions, messages. Instant, daily or weekly.
 * - reminders: document reminders, review nudges, deadline countdowns. On or off.
 * - updates: scheduled client updates. On or off.
 */
import { z } from 'zod';
import type { AppEnv } from '../env';
import { isDev } from '../env';
import { canEmailOthers, sendEmail } from '../email';
import { loadEmailBrand, type EmailBrand } from '../email/templates/brand';
import {
  alertMatchesEmail,
  decisionEmail,
  fundingReportEmail,
  type FundingLine,
  reportResponseEmail,
  digestEmail,
  documentRequestEmail,
  formatDay,
  type Footer,
  newMessageEmail,
  reminderEmail,
  reviewRequestedEmail,
  updateEmail,
  type DigestGroup,
  type UpdateBlock,
} from '../email/templates/notify';
import type { Rendered } from '../email/templates/render';
import { hmacSha256Hex, timingSafeEqual } from '../lib/crypto';
import { newId } from '../lib/ids';
import { portalOrigin } from '../lib/origin';
import { getSecret } from '../lib/secrets';
import { getSetting } from '../lib/settings';

export type Category = 'transactional' | 'activity' | 'reminders' | 'updates';

export const PREFS = z.object({
  activity: z.enum(['instant', 'daily', 'weekly', 'off']).default('instant'),
  reminders: z.boolean().default(true),
  updates: z.boolean().default(true),
});
export type Prefs = z.infer<typeof PREFS>;
export const DEFAULT_PREFS: Prefs = { activity: 'instant', reminders: true, updates: true };

export function parsePrefs(json: string | null): Prefs {
  if (!json) return DEFAULT_PREFS;
  try {
    const p = PREFS.safeParse(JSON.parse(json));
    return p.success ? p.data : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export type NotificationKind =
  | 'request.created'
  | 'request.reminder'
  | 'deliverable.review'
  | 'deliverable.decision'
  | 'deliverable.nudge'
  | 'deadline.countdown'
  | 'message'
  | 'update'
  | 'update.review'
  | 'report'
  | 'report.response'
  | 'report.review'
  | 'alert.matches';

export const CATEGORY: Record<NotificationKind, Category> = {
  'request.created': 'transactional',
  'request.reminder': 'reminders',
  'deliverable.review': 'activity',
  'deliverable.decision': 'activity',
  'deliverable.nudge': 'reminders',
  'deadline.countdown': 'reminders',
  message: 'activity',
  update: 'updates',
  'update.review': 'activity',
  report: 'updates',
  'report.response': 'activity',
  'report.review': 'activity',
  'alert.matches': 'activity',
};

interface Recipient {
  id: string;
  email: string;
  kind: 'staff' | 'client';
  timezone: string | null;
  notif_prefs_json: string | null;
  email_suppressed_at: number | null;
}

/** Client users of a client, or the staff working on it (assigned consultants, else the Owner). */
export async function recipients(env: AppEnv, clientId: string, audience: 'client' | 'staff'): Promise<Recipient[]> {
  if (audience === 'client') {
    const rows = await env.DB.prepare(
      `SELECT u.id, u.email, u.kind, u.timezone, u.notif_prefs_json, u.email_suppressed_at FROM client_members m JOIN users u ON u.id = m.user_id
        WHERE m.client_id = ? AND u.disabled_at IS NULL`,
    )
      .bind(clientId)
      .all<Recipient>();
    return rows.results;
  }
  const assigned = await env.DB.prepare(
    `SELECT u.id, u.email, u.kind, u.timezone, u.notif_prefs_json, u.email_suppressed_at FROM staff_assignments s JOIN users u ON u.id = s.user_id
      WHERE s.client_id = ? AND u.disabled_at IS NULL`,
  )
    .bind(clientId)
    .all<Recipient>();
  if (assigned.results.length) return assigned.results;
  const owners = await env.DB.prepare(
    "SELECT id, email, kind, timezone, notif_prefs_json, email_suppressed_at FROM users WHERE role = 'owner' AND disabled_at IS NULL",
  ).all<Recipient>();
  return owners.results;
}

/** Email is only for real recipients once the sending domain is verified (spec §3.4); local dev uses the outbox. */
export async function canNotify(env: AppEnv): Promise<boolean> {
  return isDev(env) || (await canEmailOthers(env));
}

function deliveryFor(kind: NotificationKind, prefs: Prefs): 'instant' | 'digest' | 'skipped' {
  switch (CATEGORY[kind]) {
    case 'transactional':
      return 'instant';
    case 'reminders':
      return prefs.reminders ? 'instant' : 'skipped';
    case 'updates':
      return prefs.updates ? 'instant' : 'skipped';
    case 'activity':
      return prefs.activity === 'off' ? 'skipped' : prefs.activity === 'instant' ? 'instant' : 'digest';
  }
}

/**
 * Records a notification for everyone on `audience`'s side (except the actor)
 * and queues the instant ones. Returns the IDs queued for sending now.
 */
export async function notify(
  env: AppEnv,
  p: { clientId: string; audience: 'client' | 'staff'; kind: NotificationKind; payload: Record<string, unknown>; actorId?: string | null; only?: string[] },
): Promise<string[]> {
  const people = (await recipients(env, p.clientId, p.audience)).filter((r) => r.id !== p.actorId && (!p.only || p.only.includes(r.id)));
  if (!people.length) return [];
  const allowed = await canNotify(env);
  const now = Date.now();
  const rows = people.map((r) => {
    const delivery = allowed ? deliveryFor(p.kind, parsePrefs(r.notif_prefs_json)) : 'skipped';
    return { id: newId('ntf'), userId: r.id, delivery };
  });
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare('INSERT INTO notifications (id, user_id, client_id, kind, payload_json, delivery, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
        r.id,
        r.userId,
        p.clientId,
        p.kind,
        JSON.stringify(p.payload),
        r.delivery,
        now,
      ),
    ),
  );
  const instant = rows.filter((r) => r.delivery === 'instant').map((r) => r.id);
  if (instant.length) {
    await env.JOBS.sendBatch(instant.map((id) => ({ body: { kind: 'notify.send', key: `notify:${id}`, notificationId: id } })));
  }
  return instant;
}

// ---------------------------------------------------------------------------
// Unsubscribe links (RFC 8058 one-click). Token = user + category + HMAC.
// ---------------------------------------------------------------------------

export async function unsubscribeToken(env: AppEnv, userId: string, category: Category): Promise<string> {
  const mac = (await hmacSha256Hex(await getSecret(env, 'SESSION_SECRET'), `unsub:${userId}:${category}`)).slice(0, 32);
  return `${userId}.${category}.${mac}`;
}

export async function verifyUnsubscribeToken(env: AppEnv, token: string): Promise<{ userId: string; category: Category } | null> {
  const [userId, category, mac] = token.split('.');
  if (!userId || !mac || !['activity', 'reminders', 'updates'].includes(category ?? '')) return null;
  const expected = await unsubscribeToken(env, userId, category as Category);
  return timingSafeEqual(expected, token) ? { userId, category: category as Category } : null;
}

export async function applyUnsubscribe(env: AppEnv, userId: string, category: Category): Promise<void> {
  const row = await env.DB.prepare('SELECT notif_prefs_json FROM users WHERE id = ?').bind(userId).first<{ notif_prefs_json: string | null }>();
  if (!row) return;
  const prefs = parsePrefs(row.notif_prefs_json);
  if (category === 'activity') prefs.activity = 'off';
  if (category === 'reminders') prefs.reminders = false;
  if (category === 'updates') prefs.updates = false;
  await env.DB.prepare('UPDATE users SET notif_prefs_json = ? WHERE id = ?').bind(JSON.stringify(prefs), userId).run();
}

// ---------------------------------------------------------------------------
// Rendering and sending (queue consumer).
// ---------------------------------------------------------------------------

interface NotificationRow {
  id: string;
  user_id: string;
  client_id: string | null;
  kind: NotificationKind;
  payload_json: string | null;
  delivery: string;
  emailed_at: number | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : null);

async function footerFor(env: AppEnv, origin: string | null, user: Recipient, category: Category, reason: string): Promise<{ footer: Footer; headers: Record<string, string> }> {
  const settingsUrl = origin ? `${origin}${user.kind === 'staff' ? '/workspace/security' : '/portal/profile'}#notifications` : null;
  if (category === 'transactional' || !origin) return { footer: { reason, settingsUrl }, headers: {} };
  const unsubscribeUrl = `${origin}/u/${await unsubscribeToken(env, user.id, category)}`;
  return {
    footer: { reason, settingsUrl, unsubscribeUrl },
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

function pathFor(kind: NotificationKind, staff: boolean, clientId: string, payload: Record<string, unknown>): string {
  const base = staff ? `/workspace/clients/${clientId}` : '/portal';
  switch (kind) {
    case 'request.created':
    case 'request.reminder':
      return `${base}/documents`;
    case 'deliverable.review':
    case 'deliverable.decision':
    case 'deliverable.nudge':
      return `${base}/deliverables/${str(payload.deliverableId)}`;
    case 'message':
      return payload.thread ? `${base}/deliverables/${str(payload.thread)}` : `${base}/messages`;
    case 'update':
    case 'update.review':
      return staff ? `${base}/updates` : base;
    case 'deadline.countdown':
      return staff ? base : '/portal';
    case 'report':
    case 'report.response':
    case 'report.review':
      return `${base}/reports/${str(payload.reportId)}`;
    case 'alert.matches':
      return `${base}/funding`;
  }
}

const lines = (v: unknown): FundingLine[] =>
  Array.isArray(v) ? (v as FundingLine[]).filter((l) => typeof l?.title === 'string').slice(0, 5).map((l) => ({ title: l.title, ...(l.detail ? { detail: String(l.detail) } : {}) })) : [];

async function renderNotification(env: AppEnv, brand: EmailBrand, n: NotificationRow, user: Recipient, tz: string): Promise<{ rendered: Rendered; headers: Record<string, string> } | null> {
  const payload = n.payload_json ? (JSON.parse(n.payload_json) as Record<string, unknown>) : {};
  const clientId = n.client_id ?? '';
  const staff = user.kind === 'staff';
  const url = brand.origin ? `${brand.origin}${pathFor(n.kind, staff, clientId, payload)}` : null;
  const clientName = str(payload.clientName);
  const reason = staff ? `You’re receiving this because you work on ${clientName || 'this client'}.` : `You’re receiving this as a member of ${clientName || 'your organization'}.`;
  const { footer, headers } = await footerFor(env, brand.origin, user, CATEGORY[n.kind], reason);

  switch (n.kind) {
    case 'request.created': {
      const rendered = await documentRequestEmail(brand, {
        title: str(payload.title),
        message: str(payload.message) || null,
        items: Array.isArray(payload.items) ? (payload.items as string[]) : [],
        dueAt: num(payload.dueAt),
        tz,
        url,
        footer,
      });
      return { rendered, headers };
    }
    case 'request.reminder': {
      // Only what's still missing at send time.
      const items = await env.DB.prepare(
        `SELECT i.label FROM doc_request_items i JOIN doc_requests r ON r.id = i.doc_request_id
          WHERE r.id = ? AND r.client_id = ? AND r.status = 'open' AND i.fulfilled_at IS NULL ORDER BY i.position`,
      )
        .bind(str(payload.requestId), clientId)
        .all<{ label: string }>();
      if (!items.results.length) return null;
      const dueAt = num(payload.dueAt);
      const rendered = await reminderEmail(brand, {
        kind: 'documents',
        title: str(payload.title),
        lines: items.results.map((i) => ({ title: i.label })),
        dueAt,
        overdue: Boolean(dueAt && dueAt < Date.now()),
        tz,
        url,
        footer,
      });
      return { rendered, headers };
    }
    case 'deliverable.nudge':
    case 'deadline.countdown': {
      const rendered = await reminderEmail(brand, {
        kind: n.kind === 'deliverable.nudge' ? 'approval' : 'deadline',
        title: str(payload.title),
        lines: [],
        dueAt: num(payload.dueAt),
        overdue: false,
        tz,
        url,
        footer,
      });
      return { rendered, headers };
    }
    case 'deliverable.review': {
      const rendered = await reviewRequestedEmail(brand, {
        title: str(payload.title),
        version: num(payload.version) ?? 1,
        note: str(payload.note) || null,
        from: str(payload.from) || brand.firm,
        url,
        footer,
      });
      return { rendered, headers };
    }
    case 'deliverable.decision': {
      const rendered = await decisionEmail(brand, {
        title: str(payload.title),
        version: num(payload.version) ?? 1,
        decision: payload.decision === 'approved' ? 'approved' : 'changes',
        comment: str(payload.comment) || null,
        by: str(payload.by) || 'Your reviewer',
        url,
        footer,
      });
      return { rendered, headers };
    }
    case 'message': {
      const msg = await env.DB.prepare('SELECT body_md, attachments_json FROM messages WHERE id = ? AND client_id = ?')
        .bind(str(payload.messageId), clientId)
        .first<{ body_md: string; attachments_json: string | null }>();
      if (!msg) return null;
      const rendered = await newMessageEmail(brand, {
        from: str(payload.from) || 'Someone',
        about: str(payload.about) || null,
        preview: msg.body_md.length > 600 ? `${msg.body_md.slice(0, 600)}…` : msg.body_md,
        attachments: msg.attachments_json ? (JSON.parse(msg.attachments_json) as string[]).length : 0,
        url,
        footer,
      });
      return { rendered, headers };
    }
    case 'update': {
      const u = await env.DB.prepare("SELECT subject, intro, content_json FROM updates WHERE id = ? AND client_id = ? AND status = 'sent'")
        .bind(str(payload.updateId), clientId)
        .first<{ subject: string; intro: string | null; content_json: string | null }>();
      if (!u) return null;
      const rendered = await updateEmail(brand, {
        subject: u.subject,
        intro: u.intro,
        blocks: u.content_json ? (JSON.parse(u.content_json) as UpdateBlock[]) : [],
        url,
        footer,
      });
      return { rendered, headers };
    }
    case 'update.review': {
      const rendered = await reminderEmail(brand, {
        kind: 'approval',
        title: `Scheduled update for ${clientName}`,
        lines: [{ title: str(payload.subject) }],
        dueAt: null,
        overdue: false,
        tz,
        url,
        footer,
      });
      return { rendered, headers };
    }
    case 'report': {
      const r = await env.DB.prepare("SELECT title, intro_md FROM reports WHERE id = ? AND client_id = ? AND status = 'sent'")
        .bind(str(payload.reportId), clientId)
        .first<{ title: string; intro_md: string | null }>();
      if (!r) return null;
      const items = await env.DB.prepare(
        `SELECT o.title, o.funder_name, o.deadline_at FROM report_items i JOIN opportunities o ON o.id = i.opportunity_id
          WHERE i.report_id = ? AND o.client_id = ? ORDER BY i.position`,
      )
        .bind(str(payload.reportId), clientId)
        .all<{ title: string; funder_name: string | null; deadline_at: number | null }>();
      const rendered = await fundingReportEmail(brand, {
        title: r.title,
        intro: r.intro_md,
        count: items.results.length,
        items: items.results.slice(0, 5).map((o) => ({
          title: o.title,
          detail: [o.funder_name, o.deadline_at ? `due ${formatDay(o.deadline_at, tz)}` : null].filter(Boolean).join(', ') || undefined,
        })),
        url,
        footer,
      });
      return { rendered, headers };
    }
    case 'report.response': {
      const response = payload.response === 'pursue' || payload.response === 'question' ? payload.response : 'not_now';
      const rendered = await reportResponseEmail(brand, {
        client: clientName || 'A client',
        by: str(payload.by) || 'Your client',
        opportunity: str(payload.title),
        response,
        comment: str(payload.comment) || null,
        url,
        footer,
      });
      return { rendered, headers };
    }
    case 'report.review':
    case 'alert.matches': {
      const rendered = await alertMatchesEmail(brand, {
        client: clientName || 'a client',
        alert: str(payload.alertName) || 'Funding alert',
        count: num(payload.count) ?? 0,
        items: lines(payload.items),
        draft: n.kind === 'report.review',
        url,
        footer,
      });
      return { rendered, headers };
    }
  }
}

async function recipient(env: AppEnv, userId: string): Promise<Recipient | null> {
  return env.DB.prepare('SELECT id, email, kind, timezone, notif_prefs_json, email_suppressed_at FROM users WHERE id = ? AND disabled_at IS NULL')
    .bind(userId)
    .first<Recipient>();
}

export async function timezoneOf(env: AppEnv, user: { timezone: string | null }): Promise<string> {
  return user.timezone ?? (await getSetting(env, 'org'))?.timezone ?? 'UTC';
}

/** Queue job: send one instant notification. Claims the row first, so a retry or duplicate never double-sends. */
export async function sendNotification(env: AppEnv, notificationId: string): Promise<void> {
  const n = await env.DB.prepare("SELECT * FROM notifications WHERE id = ? AND delivery = 'instant' AND emailed_at IS NULL").bind(notificationId).first<NotificationRow>();
  if (!n) return;
  const user = await recipient(env, n.user_id);
  if (!user) return;
  const claim = await env.DB.prepare('UPDATE notifications SET emailed_at = ? WHERE id = ? AND emailed_at IS NULL').bind(Date.now(), n.id).run();
  if (!claim.meta.changes) return;
  try {
    const brand = await loadEmailBrand(env);
    const out = await renderNotification(env, brand, n, user, await timezoneOf(env, user));
    if (!out) return;
    const emailId = await sendEmail(env, {
      to: user.email,
      template: n.kind,
      category: CATEGORY[n.kind],
      rendered: out.rendered,
      headers: out.headers,
      userId: user.id,
      clientId: n.client_id,
      suppressed: Boolean(user.email_suppressed_at),
    });
    await env.DB.prepare('UPDATE notifications SET email_id = ? WHERE id = ?').bind(emailId, n.id).run();
  } catch (err) {
    // Release the claim so the queue's retry can try again.
    await env.DB.prepare('UPDATE notifications SET emailed_at = NULL WHERE id = ?').bind(n.id).run();
    throw err;
  }
}

/** One line per pending activity item, for digests. */
async function digestLine(env: AppEnv, n: NotificationRow): Promise<{ title: string; detail?: string } | null> {
  const p = n.payload_json ? (JSON.parse(n.payload_json) as Record<string, unknown>) : {};
  switch (n.kind) {
    case 'deliverable.review':
      return { title: `${str(p.title)} v${num(p.version) ?? 1} is ready for review`, detail: str(p.from) || undefined };
    case 'deliverable.decision':
      return { title: `${str(p.title)} ${p.decision === 'approved' ? 'was approved' : 'needs changes'}`, detail: str(p.by) || undefined };
    case 'message': {
      const m = await env.DB.prepare('SELECT body_md FROM messages WHERE id = ?').bind(str(p.messageId)).first<{ body_md: string }>();
      return m ? { title: `Message from ${str(p.from)}`, detail: m.body_md.length > 140 ? `${m.body_md.slice(0, 140)}…` : m.body_md } : null;
    }
    case 'update.review':
      return { title: `Scheduled update ready for review`, detail: str(p.subject) };
    case 'report.response':
      return {
        title: `${str(p.by) || 'Client'}: ${p.response === 'pursue' ? 'Pursue' : p.response === 'question' ? 'Question' : 'Not now'} on ${str(p.title)}`,
        detail: str(p.comment) || undefined,
      };
    case 'alert.matches':
      return { title: `${num(p.count) ?? 0} new funding matches`, detail: str(p.alertName) || undefined };
    case 'report.review':
      return { title: `Report draft ready for review`, detail: str(p.alertName) || undefined };
    default:
      return null;
  }
}

/** Queue job: one digest for one user, of everything pending. */
export async function sendDigest(env: AppEnv, userId: string, period: 'daily' | 'weekly'): Promise<void> {
  const user = await recipient(env, userId);
  if (!user) return;
  const now = Date.now();
  // Claim what's pending as of now; anything that arrives later waits for the next digest.
  const claimed = await env.DB.prepare(
    `UPDATE notifications SET emailed_at = ? WHERE user_id = ? AND delivery = 'digest' AND emailed_at IS NULL RETURNING *`,
  )
    .bind(now, userId)
    .all<NotificationRow>();
  if (!claimed.results.length) return;
  try {
    const byClient = new Map<string, DigestGroup>();
    const names = await env.DB.prepare(
      `SELECT id, name FROM clients WHERE id IN (${[...new Set(claimed.results.map((n) => n.client_id ?? ''))].map(() => '?').join(',')})`,
    )
      .bind(...new Set(claimed.results.map((n) => n.client_id ?? '')))
      .all<{ id: string; name: string }>();
    const nameOf = new Map(names.results.map((r) => [r.id, r.name]));
    for (const n of claimed.results.sort((a, b) => (a.client_id ?? '').localeCompare(b.client_id ?? ''))) {
      const line = await digestLine(env, n);
      if (!line) continue;
      const key = n.client_id ?? '';
      const g = byClient.get(key) ?? { client: nameOf.get(key) ?? 'Updates', items: [] };
      g.items.push(line);
      byClient.set(key, g);
    }
    if (!byClient.size) return;
    const brand = await loadEmailBrand(env);
    const { footer, headers } = await footerFor(env, brand.origin, user, 'activity', `You chose a ${period} summary.`);
    const rendered = await digestEmail(brand, { period, groups: [...byClient.values()], url: brand.origin ? `${brand.origin}${user.kind === 'staff' ? '/workspace' : '/portal'}` : null, footer });
    await sendEmail(env, { to: user.email, template: `digest_${period}`, category: 'activity', rendered, headers, userId: user.id, suppressed: Boolean(user.email_suppressed_at) });
  } catch (err) {
    await env.DB.prepare(`UPDATE notifications SET emailed_at = NULL WHERE id IN (${claimed.results.map(() => '?').join(',')})`)
      .bind(...claimed.results.map((n) => n.id))
      .run();
    throw err;
  }
}

export async function clientName(env: AppEnv, clientId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT name FROM clients WHERE id = ?').bind(clientId).first<{ name: string }>();
  return row?.name ?? '';
}

export async function originOrNull(env: AppEnv): Promise<string | null> {
  return portalOrigin(env);
}
