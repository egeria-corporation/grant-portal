/**
 * Status and identity pieces from boards 04 and 06: pills, the deadline
 * countdown chip, avatars and org marks, progress bars, fit score, toasts,
 * skeletons, empty states.
 */
import { Check, CircleAlert } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { useState } from 'react';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');
type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

export type PillTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'acc';

export function Pill({ tone = 'neutral', icon: I, children, size = 'md' }: { tone?: PillTone; icon?: Icon; children: ReactNode; size?: 'md' | 'lg' }) {
  return (
    <span className={cx('pill', `pill-${tone}`, size === 'lg' && 'pill-lg')}>
      {I ? <I aria-hidden className="i" /> : null}
      {children}
    </span>
  );
}

export function Tag({ children, recommended }: { children: ReactNode; recommended?: boolean }) {
  return <span className={cx('tag', recommended && 'tag-rec')}>{children}</span>;
}

// ---------------------------------------------------------------------------
// Deadline countdown chip (board 04 §12): time left, a ring for the share of
// the window remaining, urgency in steps. Overdue is a soft fill.
// ---------------------------------------------------------------------------
const DAY = 86_400_000;

export type DeadlineState = 'normal' | 'soon' | 'urgent' | 'over' | 'done';

export function deadlineState(dueAt: number, now = Date.now(), done = false): DeadlineState {
  if (done) return 'done';
  const left = dueAt - now;
  if (left < 0) return 'over';
  if (left <= 2 * DAY) return 'urgent';
  if (left <= 7 * DAY) return 'soon';
  return 'normal';
}

export function deadlineLabel(dueAt: number, now = Date.now()): string {
  const left = dueAt - now;
  if (left < 0) {
    const days = Math.max(1, Math.round(-left / DAY));
    return `${days} day${days === 1 ? '' : 's'} overdue`;
  }
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDiff = Math.floor((dueAt - startOfToday.getTime()) / DAY);
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Tomorrow';
  return `${dayDiff} days`;
}

function Ring({ fraction }: { fraction: number }) {
  const r = 5;
  const c = 2 * Math.PI * r;
  return (
    <svg className="cd-ring" viewBox="0 0 14 14" aria-hidden>
      <circle className="trk" cx="7" cy="7" r={r} />
      <circle className="arc" cx="7" cy="7" r={r} strokeDasharray={`${Math.max(0, Math.min(1, fraction)) * c} ${c}`} />
    </svg>
  );
}

export function DeadlineChip({
  dueAt,
  now: nowProp,
  windowDays = 30,
  done,
  doneLabel = 'Done',
  sub,
  size = 'md',
}: {
  dueAt: number;
  now?: number;
  /** Length of the countdown the ring represents. */
  windowDays?: number;
  done?: boolean;
  doneLabel?: string;
  /** Secondary text, e.g. the date. */
  sub?: string;
  size?: 'md' | 'lg';
}) {
  // Read the clock once per mount; screens that tick pass `now` explicitly.
  const [mountedAt] = useState(() => Date.now());
  const now = nowProp ?? mountedAt;
  const state = deadlineState(dueAt, now, done);
  const label = state === 'done' ? doneLabel : deadlineLabel(dueAt, now);
  const cls = cx('cd', state !== 'normal' && `cd-${state}`, size === 'lg' && 'cd-lg');
  return (
    <span className={cls}>
      {state === 'done' ? <Check aria-hidden className="i" /> : state === 'over' ? <CircleAlert aria-hidden className="i" /> : <Ring fraction={(dueAt - now) / (windowDays * DAY)} />}
      <span>{label}</span>
      {sub && state !== 'over' ? <span className="sub">· {sub}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Avatars and org marks
// ---------------------------------------------------------------------------
export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter((w) => /[A-Za-z0-9]/.test(w))
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || '•'
  );
}

type AvSize = 'sm' | 'md' | 'lg' | 'xl';

/** Consultants get a brand-tinted avatar; client people a neutral one. */
export function Avatar({ name, size = 'md', tone = 'client', ring }: { name: string; size?: AvSize; tone?: 'consultant' | 'client'; ring?: boolean }) {
  return (
    <span className={cx('av', tone === 'consultant' ? 'av-photo' : 'av-n', size !== 'md' && `av-${size}`, ring && 'av-ring')} title={name} aria-label={name} role="img">
      {initialsOf(name)}
    </span>
  );
}

export function AvatarStack({ names, max = 3 }: { names: string[]; max?: number }) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="stack">
      {shown.map((n) => (
        <Avatar key={n} name={n} ring size="sm" />
      ))}
      {extra > 0 ? <span className="av av-n av-sm av-ring">+{extra}</span> : null}
    </span>
  );
}

export function OrgMark({ name, size = 'md' }: { name: string; size?: AvSize }) {
  return (
    <span className={cx('org', size !== 'md' && `org-${size}`)} aria-hidden>
      {initialsOf(name)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------
export function ProgressBar({ value, label, tone, indeterminate, className }: { value?: number; label: string; tone?: 'ok'; indeterminate?: boolean; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100);
  return (
    <span
      className={cx('bar', tone === 'ok' && 'bar-ok', indeterminate && 'bar-indet', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : pct}
    >
      <i style={indeterminate ? undefined : { width: `${pct}%` }} />
    </span>
  );
}

export function SegBar({ done, total, complete, width = 56 }: { done: number; total: number; complete?: boolean; width?: number }) {
  return (
    <span className="segbar" style={{ width }} role="img" aria-label={`${done} of ${total} done`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < done ? (complete ? 'okk' : 'on') : ''} />
      ))}
    </span>
  );
}

/** Pipeline mix: researching / preparing / submitted / awarded. */
export function PipelineMini({ counts }: { counts: [number, number, number, number] }) {
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const labels = ['researching', 'preparing', 'submitted', 'awarded'];
  return (
    <span className="mini" role="img" aria-label={counts.map((n, i) => `${n} ${labels[i]}`).join(', ')}>
      {counts.map((n, i) => (n ? <i key={i} className={`p${i + 1}`} style={{ width: `${(n / total) * 100}%` }} /> : null))}
    </span>
  );
}

export function FitScore({ score, label }: { score: number; label?: string }) {
  const on = Math.round((Math.max(0, Math.min(100, score)) / 100) * 5);
  const heights = [5, 7, 9, 11, 14];
  return (
    <span className="fit">
      <span className="bars" aria-hidden>
        {heights.map((h, i) => (
          <i key={h} className={i < on ? 'on' : ''} style={{ height: h }} />
        ))}
      </span>
      <span className="num">{score}</span>
      {label ? <span className="font-normal text-text2">{label}</span> : null}
    </span>
  );
}

export function IconTile({ icon: I, tone = 'acc', size = 40 }: { icon: Icon; tone?: 'acc' | 'ok' | 'warn' | 'danger' | 'info'; size?: number }) {
  return (
    <span className={cx('ico-tile', `ico-${tone}`)} style={{ width: size, height: size }} aria-hidden>
      <I className="i" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------
export function Toast({ icon: I, children, action, tone = 'default' }: { icon?: Icon; children: ReactNode; action?: { label: string; onClick: () => void }; tone?: 'default' | 'danger' }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('toast', tone === 'danger' && 'bg-danger-bg! text-danger-text! shadow-[inset_0_0_0_1px_var(--danger-bd)]!')}>
      {I ? <I aria-hidden className="i" /> : null}
      <span className="min-w-0 flex-1">{children}</span>
      {action ? (
        <button type="button" className={cx('tb', tone === 'danger' && 'text-danger-text! opacity-100!')} onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx('sk block', className)} />;
}

export function EmptyState({ icon, title, children, action }: { icon: Icon; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-3 px-7 py-10 text-center">
      <IconTile icon={icon} size={44} />
      <span className="hd t-h3">{title}</span>
      <span className="t-body max-w-[280px] text-text2">{children}</span>
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}
