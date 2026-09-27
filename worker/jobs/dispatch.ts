/**
 * The 15-minute dispatcher (spec §12). It finds due schedules, due reminders
 * and due digests, and queues one job for each. Every job has a key, claimed
 * in `job_runs` with INSERT OR IGNORE before it is queued, so a slow or
 * repeated cron run can never queue the same work twice.
 */
import { localDate, localParts, nextOccurrence, parseRRule } from '@shared/rrule';
import type { AppEnv } from '../env';
import { canNotify, clientName, notify, parsePrefs } from '../notify';
import { getSetting } from '../lib/settings';
import type { Job } from './types';

const DAY = 86_400_000;
/** Reminders more than this late are dropped rather than sent days after the fact. */
const STALE = DAY;
const COUNTDOWN_DAYS = [30, 14, 7, 2];
const NUDGE_DAYS = [3, 7];
const DIGEST_HOUR = 8;

/** Claims a job key. True the first time only. */
export async function claim(env: AppEnv, key: string, kind: string, payload: unknown): Promise<boolean> {
  const now = Date.now();
  const res = await env.DB.prepare("INSERT OR IGNORE INTO job_runs (key, kind, status, attempts, payload_json, created_at, updated_at) VALUES (?, ?, 'running', 0, ?, ?, ?)")
    .bind(key, kind, JSON.stringify(payload), now, now)
    .run();
  return res.meta.changes > 0;
}

async function enqueue(env: AppEnv, job: Job): Promise<void> {
  if (await claim(env, job.key, job.kind, job)) await env.JOBS.send(job);
}

export interface ReminderSettings {
  documents: boolean;
  approvals: boolean;
  deadlines: boolean;
}

export function reminderSettings(json: string | null): ReminderSettings {
  const d = { documents: true, approvals: true, deadlines: true };
  if (!json) return d;
  try {
    return { ...d, ...(JSON.parse(json) as Partial<ReminderSettings>) };
  } catch {
    return d;
  }
}

export async function dispatch(env: AppEnv, now: number): Promise<void> {
  await dueSchedules(env, now);
  if (await canNotify(env)) {
    await documentReminders(env, now);
    await approvalNudges(env, now);
    await deadlineCountdowns(env, now);
    await dueDigests(env, now);
  }
}

/** Queues each due schedule once and moves it to its next run. */
export async function dueSchedules(env: AppEnv, now: number): Promise<void> {
  const due = await env.DB.prepare('SELECT id, rrule, timezone, next_run_at, created_at FROM schedules WHERE enabled = 1 AND next_run_at <= ? LIMIT 100')
    .bind(now)
    .all<{ id: string; rrule: string; timezone: string | null; next_run_at: number; created_at: number }>();
  for (const s of due.results) {
    await enqueue(env, { kind: 'schedule.run', key: `${s.id}:${s.next_run_at}`, scheduleId: s.id, runAt: s.next_run_at });
    let next: number | null = null;
    if (s.rrule) {
      try {
        next = nextOccurrence(parseRRule(s.rrule), s.timezone ?? 'UTC', now, s.created_at);
      } catch {
        next = null;
      }
    }
    // One-off schedules (no rule) finish after their run; conditional on next_run_at so a concurrent dispatcher can't skip a run.
    await env.DB.prepare('UPDATE schedules SET next_run_at = ?, enabled = ? WHERE id = ? AND next_run_at = ?')
      .bind(next, next ? 1 : 0, s.id, s.next_run_at)
      .run();
  }
}

/** Document request reminders at the request's own cadence (D-051). */
async function documentReminders(env: AppEnv, now: number): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.client_id, r.title, r.due_at, r.reminder_policy_json, c.reminders_json FROM doc_requests r JOIN clients c ON c.id = r.client_id
      WHERE r.status = 'open' AND r.due_at IS NOT NULL AND r.due_at BETWEEN ? AND ? AND c.archived_at IS NULL AND c.is_demo = 0`,
  )
    .bind(now - 62 * DAY, now + 62 * DAY)
    .all<{ id: string; client_id: string; title: string; due_at: number; reminder_policy_json: string | null; reminders_json: string | null }>();
  for (const r of rows.results) {
    if (!reminderSettings(r.reminders_json).documents || !r.reminder_policy_json) continue;
    const policy = JSON.parse(r.reminder_policy_json) as { beforeDays: number[]; onDue: boolean; afterDays: number[] };
    const offsets = [...policy.beforeDays.map((d) => -d), ...(policy.onDue ? [0] : []), ...policy.afterDays];
    for (const offset of offsets) {
      const at = r.due_at + offset * DAY;
      if (at > now || at < now - STALE) continue;
      if (!(await claim(env, `reminder:${r.id}:${offset}`, 'reminder', { requestId: r.id, offset }))) continue;
      await notify(env, {
        clientId: r.client_id,
        audience: 'client',
        kind: 'request.reminder',
        payload: { requestId: r.id, title: r.title, dueAt: r.due_at, clientName: await clientName(env, r.client_id) },
      });
    }
  }
}

/** A draft waiting on the client gets a nudge after 3 and 7 days. */
async function approvalNudges(env: AppEnv, now: number): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT d.id, d.client_id, d.title, v.id AS version_id, v.version, v.created_at, c.reminders_json
       FROM deliverables d JOIN clients c ON c.id = d.client_id
       JOIN deliverable_versions v ON v.deliverable_id = d.id AND v.version = (SELECT MAX(version) FROM deliverable_versions WHERE deliverable_id = d.id)
      WHERE d.status = 'in_review' AND d.side = 'consultant' AND c.archived_at IS NULL AND c.is_demo = 0
        AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.deliverable_version_id = v.id) AND v.created_at > ?`,
  )
    .bind(now - 30 * DAY)
    .all<{ id: string; client_id: string; title: string; version_id: string; version: number; created_at: number; reminders_json: string | null }>();
  for (const d of rows.results) {
    if (!reminderSettings(d.reminders_json).approvals) continue;
    for (const days of NUDGE_DAYS) {
      const at = d.created_at + days * DAY;
      if (at > now || at < now - STALE) continue;
      if (!(await claim(env, `nudge:${d.version_id}:${days}`, 'reminder', { deliverableId: d.id, days }))) continue;
      await notify(env, {
        clientId: d.client_id,
        audience: 'client',
        kind: 'deliverable.nudge',
        payload: { deliverableId: d.id, title: d.title, version: d.version, clientName: await clientName(env, d.client_id) },
      });
    }
  }
}

/** Grant deadline countdowns: 30, 14, 7 and 2 days out, to both sides (spec §5.7). */
async function deadlineCountdowns(env: AppEnv, now: number): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT o.id, o.client_id, o.title, o.deadline_at, c.reminders_json FROM opportunities o JOIN clients c ON c.id = o.client_id
      WHERE o.stage IN ('researching', 'preparing') AND o.deadline_at BETWEEN ? AND ? AND c.archived_at IS NULL AND c.is_demo = 0`,
  )
    .bind(now, now + 31 * DAY)
    .all<{ id: string; client_id: string; title: string; deadline_at: number; reminders_json: string | null }>();
  for (const o of rows.results) {
    if (!reminderSettings(o.reminders_json).deadlines) continue;
    for (const days of COUNTDOWN_DAYS) {
      const at = o.deadline_at - days * DAY;
      if (at > now || at < now - STALE) continue;
      if (!(await claim(env, `countdown:${o.id}:${days}`, 'reminder', { opportunityId: o.id, days }))) continue;
      const payload = { opportunityId: o.id, title: o.title, dueAt: o.deadline_at, clientName: await clientName(env, o.client_id) };
      await notify(env, { clientId: o.client_id, audience: 'staff', kind: 'deadline.countdown', payload });
      await notify(env, { clientId: o.client_id, audience: 'client', kind: 'deadline.countdown', payload });
    }
  }
}

/**
 * Digests go out at 8:00 in each person's time zone: daily ones every day,
 * weekly ones on Mondays. The key includes the local date, so each is sent once.
 */
async function dueDigests(env: AppEnv, now: number): Promise<void> {
  const users = await env.DB.prepare(
    `SELECT DISTINCT u.id, u.timezone, u.notif_prefs_json FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.delivery = 'digest' AND n.emailed_at IS NULL AND u.disabled_at IS NULL LIMIT 500`,
  ).all<{ id: string; timezone: string | null; notif_prefs_json: string | null }>();
  if (!users.results.length) return;
  const orgTz = (await getSetting(env, 'org'))?.timezone ?? 'UTC';
  for (const u of users.results) {
    const prefs = parsePrefs(u.notif_prefs_json);
    if (prefs.activity !== 'daily' && prefs.activity !== 'weekly') continue;
    const tz = u.timezone ?? orgTz;
    const local = localParts(now, tz);
    if (local.hh < DIGEST_HOUR) continue;
    if (prefs.activity === 'weekly' && local.weekday !== 1) continue;
    await enqueue(env, { kind: 'digest.send', key: `digest:${u.id}:${localDate(now, tz)}`, userId: u.id, period: prefs.activity });
  }
}
