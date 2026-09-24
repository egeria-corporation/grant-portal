import type { AppEnv } from '../env';
import { isJob, type Job } from './types';

export const CRON_DISPATCH = '*/15 * * * *';
export const CRON_DAILY = '0 13 * * *';

/** Cron entry point (spec §12). Dispatch and daily work land in M4. */
export async function handleScheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
  switch (controller.cron) {
    case CRON_DISPATCH:
      // M4: enqueue due schedules + reminders.
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
  ]);
}

export async function handleQueue(batch: MessageBatch<unknown>, _env: AppEnv): Promise<void> {
  for (const msg of batch.messages) {
    if (!isJob(msg.body)) {
      console.error('[queue] dropping malformed message', msg.id);
      msg.ack();
      continue;
    }
    await runJob(msg.body);
    msg.ack();
  }
}

async function runJob(job: Job): Promise<void> {
  switch (job.kind) {
    case 'noop':
      return;
  }
}
