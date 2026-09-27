/** Messages on the JOBS queue. Each job kind is added by the milestone that needs it. */
export type Job =
  | { kind: 'noop'; key: string }
  /** Hash a completed multipart upload and run the scanner hook (worker/files/store.ts). */
  | { kind: 'file.finalize'; key: string; fileId: string }
  /** Send one instant notification email (worker/notify). */
  | { kind: 'notify.send'; key: string; notificationId: string }
  /** Send one person's digest (worker/notify). */
  | { kind: 'digest.send'; key: string; userId: string; period: 'daily' | 'weekly' }
  /** Run one due schedule (worker/jobs/dispatch.ts). */
  | { kind: 'schedule.run'; key: string; scheduleId: string; runAt: number };

export function isJob(value: unknown): value is Job {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string' && typeof (value as { key?: unknown }).key === 'string';
}
