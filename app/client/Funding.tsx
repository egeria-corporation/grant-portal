/**
 * Funding pieces shared by the workspace and the portal (spec §5.3, §5.4,
 * §6.4): stage labels, money formatting, the pipeline board, the manual
 * opportunity form, and the OpenGrants usage meter.
 */
import { useId, useState } from 'react';
import { formatDate, fromDateInput, toDateInput } from '@/lib/format';
import type { FundingUsage, Opportunity, OpportunityDraft, Stage } from '@/lib/types';
import { Button, Field, Input, Notice, Select, Textarea } from '@/ui/controls';
import { DeadlineChip, OrgMark, ProgressBar, SegBar } from '@/ui/display';
import type { Opportunity as CardOpportunity } from '@/ui/documents';

export const STAGE_LABEL: Record<Stage, string> = {
  none: 'Not in pipeline',
  researching: 'Researching',
  preparing: 'Preparing',
  submitted: 'Submitted',
  awarded: 'Awarded',
  declined: 'Declined',
};
export const BOARD_STAGES = ['researching', 'preparing', 'submitted', 'awarded', 'declined'] as const satisfies readonly Stage[];

const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
export function money(min: number | null, max: number | null): string {
  if (min && max && min !== max) return `${usd(min)}–${usd(max)}`;
  if (max) return min === max ? usd(max) : `Up to ${usd(max)}`;
  if (min) return `From ${usd(min)}`;
  return '';
}

export const TAG_LABEL = { recommended: 'Recommended', consider: 'Consider', fyi: 'FYI' } as const;

/** API opportunity → the design system's card data. */
export function cardOf(o: Pick<Opportunity, 'title' | 'funderName' | 'amountMin' | 'amountMax' | 'deadlineAt' | 'url' | 'fitScore' | 'eligibilityNotes'>, extra: Partial<CardOpportunity> = {}): CardOpportunity {
  return {
    funder: o.funderName ?? 'Funder not listed',
    title: o.title,
    amount: money(o.amountMin, o.amountMax),
    dueAt: o.deadlineAt,
    href: o.url,
    fit: o.fitScore !== null ? { score: o.fitScore, label: 'fit' } : undefined,
    eligibility: o.eligibilityNotes ? [{ ok: true, text: o.eligibilityNotes.length > 160 ? `${o.eligibilityNotes.slice(0, 160)}…` : o.eligibilityNotes }] : undefined,
    ...extra,
  };
}

/** "Source: OpenGrants" appears only in consultant views (spec §10.5). */
export function SourceLine({ o }: { o: Pick<Opportunity, 'source' | 'url'> | OpportunityDraft }) {
  const og = 'ogId' in o && !('source' in o) ? true : (o as Opportunity).source === 'opengrants';
  return (
    <span className="t-xs text-text3">
      {og ? 'Source: OpenGrants' : (o as Opportunity).source === 'csv' ? 'Source: CSV import' : 'Added by hand'}
      {o.url ? (
        <>
          {' · '}
          <a href={o.url} target="_blank" rel="noopener noreferrer" className="text-acc-text hover:underline">
            Funder listing
          </a>
        </>
      ) : null}
    </span>
  );
}

export function UsageMeter({ usage }: { usage: FundingUsage }) {
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div className="t-sm flex items-center justify-between gap-2">
        <span>OpenGrants requests today</span>
        <span className="tabular-nums text-text2">
          {usage.used} of {usage.limit}
        </span>
      </div>
      <ProgressBar value={usage.used / Math.max(1, usage.limit)} label={`${usage.used} of ${usage.limit} OpenGrants requests used today`} />
      {usage.remaining === 0 ? (
        <p className="t-xs text-danger-text">Today’s requests are used up. Search is back {formatDate(usage.resetsAt, { hour: 'numeric', minute: '2-digit' })}; manual entry works meanwhile.</p>
      ) : usage.low ? (
        <p className="t-xs text-warn-text">Running low: scheduled alerts pause until the daily reset. Searching still works. Repeated searches come from cache and are free.</p>
      ) : (
        <p className="t-xs text-text2">Repeated searches come from cache and don’t count.</p>
      )}
    </div>
  );
}

/** Pipeline board (spec §5.4). Staff move cards with a stage menu (keyboard-friendly, no drag needed). */
export function PipelineBoard({
  items,
  onMove,
  showClient,
  actions,
}: {
  items: Opportunity[];
  onMove?: (o: Opportunity, stage: Stage) => void;
  showClient?: boolean;
  actions?: (o: Opportunity) => React.ReactNode;
}) {
  const [now] = useState(() => Date.now());
  const uid = useId();
  return (
    <div className="-mx-1 grid auto-cols-[minmax(240px,1fr)] grid-flow-col gap-3 overflow-x-auto px-1 pb-2" role="group" aria-label="Pipeline">
      {BOARD_STAGES.map((stage) => {
        const col = items.filter((o) => o.stage === stage);
        return (
          <section key={stage} aria-labelledby={`${uid}-${stage}`} className="flex min-w-0 flex-col gap-2 rounded-lg bg-sunken p-2">
            <div className="t-sm flex items-center justify-between px-1 font-medium">
              <h3 id={`${uid}-${stage}`}>{STAGE_LABEL[stage]}</h3>
              <span className="t-xs tabular-nums text-text2" aria-label={`${col.length} opportunities`}>
                {col.length}
              </span>
            </div>
            {col.length ? (
              col.map((o) => (
                <article key={o.id} className="kcard" aria-label={o.title}>
                  {showClient && o.clientName ? (
                    <div className="flex items-center gap-[7px]">
                      <OrgMark name={o.clientName} size="sm" />
                      <span className="t-xs truncate text-text2">{o.clientName}</span>
                    </div>
                  ) : null}
                  <div className="flex flex-col gap-0.5">
                    <span className="t-xs text-text2">{o.funderName ?? 'Funder not listed'}</span>
                    <span className="t-h4">{o.title}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="t-sm font-medium tabular-nums">{money(o.amountMin, o.amountMax)}</span>
                    {o.deadlineAt ? (
                      <DeadlineChip dueAt={o.deadlineAt} now={now} done={stage === 'submitted' || stage === 'awarded' || stage === 'declined'} doneLabel={STAGE_LABEL[stage]} />
                    ) : null}
                  </div>
                  {o.deliverables?.total ? (
                    <div className="flex items-center gap-2">
                      <SegBar done={o.deliverables.done} total={o.deliverables.total} complete={o.deliverables.done === o.deliverables.total} />
                      <span className="t-xs tabular-nums text-text2">
                        {o.deliverables.done} of {o.deliverables.total} deliverables
                      </span>
                    </div>
                  ) : null}
                  {onMove ? (
                    <Select aria-label={`Stage for ${o.title}`} value={o.stage} onChange={(e) => onMove(o, e.target.value as Stage)}>
                      {(['none', ...BOARD_STAGES] as Stage[]).map((s) => (
                        <option key={s} value={s}>
                          {s === 'none' ? 'Remove from pipeline' : STAGE_LABEL[s]}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                  {actions?.(o)}
                </article>
              ))
            ) : (
              <p className="t-xs px-1 py-2 text-text2">Nothing here.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

export interface OpportunityInput {
  title: string;
  funderName: string | null;
  url: string | null;
  amountMin: number | null;
  amountMax: number | null;
  deadlineAt: number | null;
  eligibilityNotes: string | null;
  notes: string | null;
}

const num = (v: string) => (v.trim() ? Math.max(0, Math.round(Number(v.replace(/[$,\s]/g, '')))) || null : null);

/** Manual entry (spec §5.3 "Without OpenGrants"): title, funder, URL, deadline, amount, notes. */
export function OpportunityForm({
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<Opportunity>;
  submitLabel: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (v: OpportunityInput) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [funder, setFunder] = useState(initial?.funderName ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [deadline, setDeadline] = useState(toDateInput(initial?.deadlineAt));
  const [min, setMin] = useState(initial?.amountMin ? String(initial.amountMin) : '');
  const [max, setMax] = useState(initial?.amountMax ? String(initial.amountMax) : '');
  const [elig, setElig] = useState(initial?.eligibilityNotes ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const badUrl = url.trim() !== '' && !/^https?:\/\//i.test(url.trim());
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (badUrl) return;
        onSubmit({
          title: title.trim(),
          funderName: funder.trim() || null,
          url: url.trim() || null,
          amountMin: num(min),
          amountMax: num(max),
          deadlineAt: fromDateInput(deadline),
          eligibilityNotes: elig.trim() || null,
          notes: notes.trim() || null,
        });
      }}
    >
      <div className="sm:col-span-2">
        <Field label="Title">{(p) => <Input {...p} required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
      </div>
      <Field label="Funder">{(p) => <Input {...p} maxLength={200} value={funder} onChange={(e) => setFunder(e.target.value)} />}</Field>
      <Field label="Listing URL" error={badUrl ? 'Use a full https:// link' : null}>
        {(p) => <Input {...p} type="url" inputMode="url" placeholder="https://" maxLength={2000} invalid={badUrl} value={url} onChange={(e) => setUrl(e.target.value)} />}
      </Field>
      <Field label="Deadline">{(p) => <Input {...p} type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />}</Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Amount from">{(p) => <Input {...p} inputMode="numeric" placeholder="$" value={min} onChange={(e) => setMin(e.target.value)} />}</Field>
        <Field label="Amount up to">{(p) => <Input {...p} inputMode="numeric" placeholder="$" value={max} onChange={(e) => setMax(e.target.value)} />}</Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Eligibility notes" hint="Shown to the client.">
          {(p) => <Textarea {...p} rows={2} maxLength={2000} value={elig} onChange={(e) => setElig(e.target.value)} />}
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Private notes" hint="Only your team sees these.">
          {(p) => <Textarea {...p} rows={2} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
      {error ? (
        <div className="sm:col-span-2">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" loading={busy} disabled={!title.trim()}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
