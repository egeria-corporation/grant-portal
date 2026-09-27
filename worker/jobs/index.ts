import type { AppEnv } from '../env';
import { finalizeFile, purgeStaleUploads } from '../files/store';
import { sendDigest, sendNotification } from '../notify';
import { runUpdateSchedule } from '../updates';
import { dispatch } from './dispatch';
import { isJob, type Job } from './types';

export const CRON_DISPATCH = '*/15 * * * *';
export const CRON_DAILY = '0 13 * * *';

/** Attempts before a job is dead-lettered to the Owner's System page (matches `max_retries` in wrangler.jsonc). */
export const MAX_ATTEMPTS = 5;

/** Cron entry point (spec §12). */
export async function handleScheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
  switch (controller.cron) {
    case CRON_DISPATCH:
      await dispatch(env, controller.scheduledTime);
      return;
    case CRON_DAILY:
      await cleanupExpired(env, controller.scheduledTime);
      return;
    default:
      console.warn(`[cron] unknown schedule ${controller.cron}`);
  }
}

/** Expired magic links and sessions are useless and only widen the blast radius of a leak. */
export async function cleanupExpired(env: AppEnv, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM magic_links WHERE expires_at < ?').bind(now - 24 * 3600_000),
    env.DB.prepare('DELETE FROM sessions WHERE abs_expires_at < ? OR idle_expires_at < ?').bind(now, now),
    env.DB.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').bind(now - 3600_000),
    // Sent notifications are only needed for a while (digest assembly, debugging).
    env.DB.prepare('DELETE FROM notifications WHERE emailed_at IS NOT NULL AND emailed_at < ?').bind(now - 30 * 86_400_000),
    env.DB.prepare("DELETE FROM job_runs WHERE status = 'done' AND updated_at < ?").bind(now - 30 * 86_400_000),
  ]);
  await purgeStaleUploads(env, now);
}

async function mark(env: AppEnv, job: Job, status: 'done' | 'failed' | 'dead', attempts: number, error: string | null): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO job_runs (key, kind, status, attempts, error, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, error = excluded.error, updated_at = excluded.updated_at`,
  )
    .bind(job.key, job.kind, status, attempts, error, JSON.stringify(job), now, now)
    .run();
}

/**
 * Queue consumer (spec §12): idempotent jobs, retried with backoff; after
 * MAX_ATTEMPTS a job is marked dead and shown on the Owner's System page.
 */
export async function handleQueue(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
  for (const msg of batch.messages) {
    if (!isJob(msg.body)) {
      console.error('[queue] dropping malformed message', msg.id);
      msg.ack();
      continue;
    }
    const job = msg.body;
    try {
      await runJob(job, env);
      if (job.kind === 'schedule.run' || job.kind === 'digest.send') await mark(env, job, 'done', msg.attempts, null);
      msg.ack();
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
      console.error('[queue] job failed', job.kind, job.key, error);
      if (msg.attempts >= MAX_ATTEMPTS) {
        await mark(env, job, 'dead', msg.attempts, error).catch(() => undefined);
        msg.ack();
      } else {
        await mark(env, job, 'failed', msg.attempts, error).catch(() => undefined);
        msg.retry({ delaySeconds: Math.min(600, 30 * 2 ** msg.attempts) });
      }
    }
  }
}

export async function runJob(job: Job, env: AppEnv): Promise<void> {
  switch (job.kind) {
    case 'noop':
      return;
    case 'file.finalize':
      await finalizeFile(env, job.fileId);
      return;
    case 'notify.send':
      await sendNotification(env, job.notificationId);
      return;
    case 'digest.send':
      await sendDigest(env, job.userId, job.period);
      return;
    case 'schedule.run': {
      const s = await env.DB.prepare('SELECT id, kind, client_id, config_json, requires_review, created_by FROM schedules WHERE id = ?')
        .bind(job.scheduleId)
        .first<{ id: string; kind: string; client_id: string | null; config_json: string | null; requires_review: number; created_by: string | null }>();
      if (!s) return;
      // Reports and alerts (M5) plug in here.
      if (s.kind === 'update') await runUpdateSchedule(env, s, job.runAt);
      return;
    }
  }
}
