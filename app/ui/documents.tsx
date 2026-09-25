/**
 * Documents and decisions (board 05): file drop zone, checklist row with an
 * upload slot, opportunity card, kanban card, version history and approval
 * bar. Presentational: data and handlers come from the screens (M3+).
 */
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CloudUpload,
  DollarSign,
  HelpCircle,
  Loader2,
  MessageCircleQuestion,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import { Button, Notice } from './controls';
import { Avatar, DeadlineChip, FitScore, IconTile, OrgMark, Pill, ProgressBar, SegBar } from './display';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export function FileType({ name }: { name: string }) {
  const ext = (/\.([a-z0-9]{1,4})$/i.exec(name)?.[1] ?? 'FILE').toUpperCase();
  return (
    <span className="ftype" aria-hidden>
      {ext}
    </span>
  );
}

export type DropState =
  | { kind: 'idle' }
  | { kind: 'uploading'; name: string; progress: number; detail?: string; onCancel?: () => void }
  | { kind: 'scanning'; name: string }
  | { kind: 'received'; name: string; when: string; visibleTo: string }
  | { kind: 'error'; message: string; onRetry?: () => void };

/** Six states (board 05 §14). Scanning is shown so a pause never looks like a failure. */
export function DropZone({ state, onFiles, accept, hint }: { state: DropState; onFiles: (files: File[]) => void; accept?: string; hint?: string }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = () => input.current?.click();
  const common = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      onFiles([...e.dataTransfer.files]);
    },
  };
  const hidden = <input ref={input} type="file" multiple accept={accept} className="sr-only" tabIndex={-1} onChange={(e) => onFiles([...(e.target.files ?? [])])} />;

  if (state.kind === 'uploading' || state.kind === 'scanning') {
    return (
      <div className="drop min-h-[200px] items-stretch border-solid border-border" aria-live="polite">
        <div className="fileline border-0 p-0">
          <FileType name={state.name} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex justify-between gap-2">
              <span className="t-sm truncate font-medium">{state.name}</span>
              {state.kind === 'uploading' ? <span className="t-xs tabular-nums text-text2">{Math.round(state.progress * 100)}%</span> : null}
            </div>
            <ProgressBar label={state.kind === 'uploading' ? `Uploading ${state.name}` : `Checking ${state.name}`} value={state.kind === 'uploading' ? state.progress : undefined} indeterminate={state.kind === 'scanning'} />
            <span className="t-xs flex items-center gap-1.5 text-text2">
              {state.kind === 'scanning' ? (
                <>
                  <ShieldCheck aria-hidden className="i size-3.5" />
                  Checking the file is safe · a few seconds
                </>
              ) : (
                state.detail
              )}
            </span>
          </div>
          {state.kind === 'uploading' && state.onCancel ? (
            <Button variant="ghost" size="sm" icon aria-label="Cancel upload" onClick={state.onCancel}>
              <X aria-hidden className="i" />
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  if (state.kind === 'received') {
    return (
      <div className="drop min-h-[200px] border-solid border-ok-bd bg-ok-bg" role="status">
        <IconTile icon={CircleCheck} tone="ok" />
        <span className="t-h4 text-ok-text">Received</span>
        <span className="t-sm text-ok-text">
          {state.name} · {state.when}
        </span>
        <span className="trust mt-1">
          <ShieldCheck aria-hidden className="i" />
          <span>Encrypted · visible to {state.visibleTo}</span>
        </span>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="drop is-err min-h-[200px]" role="alert">
        <IconTile icon={CircleAlert} tone="danger" />
        <span className="t-h4 text-danger-text">Upload didn’t finish</span>
        <span className="t-sm text-danger-text">{state.message}</span>
        <div className="mt-1.5 flex gap-2">
          {state.onRetry ? (
            <Button variant="secondary" size="sm" onClick={state.onRetry}>
              <RotateCcw aria-hidden className="i" />
              Try again
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={pick}>
            Choose another file
          </Button>
        </div>
        {hidden}
      </div>
    );
  }
  return (
    <div className={cx('drop min-h-[200px]', over && 'is-over')} {...common}>
      <IconTile icon={CloudUpload} />
      <span className="t-h4">{over ? 'Release to upload' : 'Drop files here'}</span>
      <span className="t-sm text-text2">
        or{' '}
        <button type="button" className="font-medium text-acc-text hover:underline" onClick={pick}>
          choose from your device
        </button>
      </span>
      {hint ? <span className="t-xs mt-1.5 text-text3">{hint}</span> : null}
      {hidden}
    </div>
  );
}

export type ChecklistStatus = 'needed' | 'uploading' | 'checking' | 'received' | 'rejected';

const STAT: Record<ChecklistStatus, { cls: string; icon: typeof CircleDashed; label: string }> = {
  needed: { cls: 'stat-need', icon: CircleDashed, label: 'Needed' },
  uploading: { cls: 'stat-busy', icon: Loader2, label: 'Uploading' },
  checking: { cls: 'stat-busy', icon: Loader2, label: 'Checking' },
  received: { cls: 'stat-ok', icon: CircleCheck, label: 'Received' },
  rejected: { cls: 'stat-err', icon: CircleAlert, label: 'Needs attention' },
};

/** One row per requested document; the slot changes in place (board 05 §15). */
export function ChecklistItem({
  title,
  detail,
  status,
  progress,
  note,
  receivedAt,
  action,
  overdue,
}: {
  title: string;
  detail?: string;
  status: ChecklistStatus;
  progress?: number;
  note?: ReactNode;
  receivedAt?: string;
  action?: ReactNode;
  overdue?: ReactNode;
}) {
  const s = STAT[status];
  const I = s.icon;
  return (
    <div className="chk">
      <span className={cx('stat', s.cls)} role="img" aria-label={s.label}>
        <I aria-hidden className={cx('i', (status === 'uploading' || status === 'checking') && 'spin')} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="t-h4 text-[15px]">{title}</span>
        {detail ? <span className="t-sm text-text2">{detail}</span> : null}
        {note ? <span className="t-sm text-danger-text">{note}</span> : null}
        {overdue ? <span className="mt-0.5 flex gap-1.5">{overdue}</span> : null}
      </div>
      {status === 'uploading' || status === 'checking' ? (
        <div className="flex w-[150px] flex-col gap-1.5">
          <ProgressBar label={`${s.label} ${title}`} value={progress} indeterminate={status === 'checking'} />
          <span className="t-xs tabular-nums text-text2">{status === 'uploading' ? `Uploading · ${Math.round((progress ?? 0) * 100)}%` : 'Checking file'}</span>
        </div>
      ) : status === 'received' ? (
        <span className="t-sm inline-flex items-center gap-1.5 tabular-nums text-ok-text">
          <CircleCheck aria-hidden className="i size-4" />
          Received {receivedAt}
        </span>
      ) : (
        action
      )}
    </div>
  );
}

export interface Opportunity {
  funder: string;
  title: string;
  amount: string;
  dueAt: number;
  fit?: { score: number; label: string };
  eligibility?: { ok: boolean; text: string }[];
  note?: { author: string; text: string };
  tag?: 'Recommended' | 'Consider' | 'FYI';
}

/** Funder, amount, deadline, fit, the consultant's note, and three plain choices (board 05 §16). */
export function OpportunityCard({
  opp,
  response,
  onRespond,
  now,
}: {
  opp: Opportunity;
  response?: { kind: 'pursue' | 'not_now' | 'question'; message: ReactNode; onUndo?: () => void };
  onRespond?: (kind: 'pursue' | 'not_now' | 'question') => void;
  now?: number;
}) {
  return (
    <article className="opp">
      <div className="flex items-start gap-3">
        <OrgMark name={opp.funder} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="t-sm text-text2">{opp.funder}</span>
          <h4 className="hd t-h3">{opp.title}</h4>
        </div>
        {opp.tag ? (
          <Pill tone={opp.tag === 'Recommended' ? 'acc' : 'neutral'} icon={opp.tag === 'Recommended' ? Sparkles : undefined}>
            {opp.tag}
          </Pill>
        ) : null}
      </div>
      <div className="meta">
        <span className="tabular-nums">
          <DollarSign aria-hidden className="i" />
          <b className="font-medium text-text">{opp.amount}</b>
        </span>
        <DeadlineChip dueAt={opp.dueAt} now={now} />
        {opp.fit ? <FitScore score={opp.fit.score} label={opp.fit.label} /> : null}
      </div>
      {opp.eligibility?.length ? (
        <div className="elig">
          {opp.eligibility.map((e) => (
            <span key={e.text} className={e.ok ? 'y' : 'n'}>
              {e.ok ? <CircleCheck aria-hidden className="i" /> : <HelpCircle aria-hidden className="i" />}
              {e.text}
            </span>
          ))}
        </div>
      ) : null}
      {opp.note ? (
        <div className="note">
          <Avatar name={opp.note.author} tone="consultant" size="sm" />
          <div className="flex flex-col gap-0.5">
            <span className="t-xs font-medium text-text2">{opp.note.author}’s note</span>
            <span>{opp.note.text}</span>
          </div>
        </div>
      ) : null}
      {response ? (
        <Notice tone={response.kind === 'pursue' ? 'ok' : 'info'} action={response.onUndo ? <Button variant="ghost" size="sm" onClick={response.onUndo}>Undo</Button> : undefined}>
          {response.message}
        </Notice>
      ) : onRespond ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onRespond('pursue')}>
            <ThumbsUp aria-hidden className="i" />
            Pursue
          </Button>
          <Button variant="secondary" onClick={() => onRespond('not_now')}>
            Not now
          </Button>
          <Button variant="ghost" onClick={() => onRespond('question')}>
            <MessageCircleQuestion aria-hidden className="i" />
            Ask a question
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** Pipeline card (board 05 §17). The client mark shows only on the all-clients board. */
export function KanbanCard({
  funder,
  title,
  amount,
  dueAt,
  done,
  awarded,
  deliverables,
  assignee,
  client,
  dragging,
  now,
}: {
  funder: string;
  title: string;
  amount: string;
  dueAt: number;
  done?: boolean;
  awarded?: boolean;
  deliverables: { done: number; total: number };
  assignee: string;
  client?: string;
  dragging?: boolean;
  now?: number;
}) {
  return (
    <div className={cx('kcard', dragging && 'is-drag')}>
      {client ? (
        <div className="flex items-center gap-[7px]">
          <OrgMark name={client} size="sm" />
          <span className="t-xs truncate text-text2">{client}</span>
        </div>
      ) : null}
      <div className="flex flex-col gap-0.5">
        <span className="t-xs text-text2">{funder}</span>
        <span className="t-h4">{title}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="t-sm font-medium tabular-nums">{amount}</span>
        <DeadlineChip dueAt={dueAt} now={now} done={done || awarded} doneLabel={awarded ? 'Awarded' : 'Submitted'} />
      </div>
      <div className="flex items-center gap-2">
        <SegBar done={deliverables.done} total={deliverables.total} complete={deliverables.done === deliverables.total} />
        <span className="t-xs flex-1 tabular-nums text-text2">
          {deliverables.done} of {deliverables.total} deliverables
        </span>
        <Avatar name={assignee} size="sm" />
      </div>
    </div>
  );
}

export interface Version {
  n: number;
  summary: string;
  by: string;
  when: string;
  context: string;
  status: 'draft' | 'waiting' | 'changes' | 'approved';
  current?: boolean;
}

const VERSION_PILL = {
  draft: { tone: 'neutral', label: 'Draft' },
  waiting: { tone: 'warn', label: 'Waiting on client' },
  changes: { tone: 'neutral', label: 'Changes requested' },
  approved: { tone: 'ok', label: 'Approved' },
} as const;

export function VersionList({ versions }: { versions: Version[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="sech">
        Versions<span className="ct">{versions.length}</span>
      </div>
      {versions.map((v) => (
        <div key={v.n} className={cx('flex items-center gap-3 border-t border-border px-4 py-3', v.current && 'bg-acc-50')}>
          <span className="t-mono w-6 font-medium">v{v.n}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="t-sm font-medium">{v.summary}</span>
            <span className="t-xs text-text2">
              {v.by} · {v.when} · {v.context}
            </span>
          </div>
          <Pill tone={VERSION_PILL[v.status].tone}>{VERSION_PILL[v.status].label}</Pill>
        </div>
      ))}
    </div>
  );
}

/** Sticks to the bottom of the viewport on the review screen (board 05 §18). */
export function ApprovalBar({ title, detail, onApprove, onRequestChanges, approved }: { title: string; detail: string; onApprove: () => void; onRequestChanges: () => void; approved?: { when: string; onUndo?: () => void } }) {
  if (approved) {
    return (
      <div className="panel flex items-center gap-3.5 border-ok-bd bg-ok-bg px-[18px] py-3.5" role="status">
        <span className="flex flex-1 items-center gap-2.5 text-ok-text">
          <CircleCheck aria-hidden className="i size-4" />
          <span>
            <b className="font-semibold">Approved</b> · {approved.when}
          </span>
        </span>
        {approved.onUndo ? (
          <Button variant="ghost" size="sm" onClick={approved.onUndo}>
            Undo
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="panel flex flex-wrap items-center gap-3.5 py-3 pl-[18px] pr-3 shadow-pop">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="t-h4">{title}</span>
        <span className="t-sm text-text2">{detail}</span>
      </div>
      <Button variant="secondary" size="lg" onClick={onRequestChanges}>
        Request changes
      </Button>
      <Button size="lg" onClick={onApprove}>
        <CircleCheck aria-hidden className="i" />
        Approve
      </Button>
    </div>
  );
}
