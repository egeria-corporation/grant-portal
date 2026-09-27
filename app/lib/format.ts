/** Small display helpers shared by workspace and portal screens. */
const DAY = 86_400_000;

export function formatDate(ms: number | null | undefined, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, opts);
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "just now", "5 min ago", "3 h ago", "yesterday", then a date. */
export function timeAgo(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 60_000) return 'just now';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < DAY) return `${Math.floor(d / 3600_000)} h ago`;
  if (d < 2 * DAY) return 'yesterday';
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} days ago`;
  return formatDate(ms);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** `<input type="date">` value ↔ epoch ms at local noon (avoids off-by-one across time zones). */
export function toDateInput(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fromDateInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime();
}

export const STATUS_LABEL: Record<string, string> = {
  onboarding: 'Onboarding',
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
  not_started: 'Not started',
  in_progress: 'In progress',
  in_review: 'In review',
  approved: 'Approved',
  done: 'Done',
  open: 'Open',
  complete: 'Complete',
  cancelled: 'Cancelled',
};
