/** Messages on the JOBS queue. Each job kind is added by the milestone that needs it. */
export type Job = { kind: 'noop'; key: string };

export function isJob(value: unknown): value is Job {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string';
}
