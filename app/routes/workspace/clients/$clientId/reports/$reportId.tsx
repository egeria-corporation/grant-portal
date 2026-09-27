/**
 * Report builder (spec §5.3): title and intro, opportunities in order with a
 * note and a tag each, added from the client's saved opportunities, by hand,
 * or from OpenGrants. "Client preview" shows exactly what the client sees.
 * After sending: the client's answers, and a template offer for Pursue.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowDown, ArrowLeft, ArrowUp, Download, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { cardOf, money, OpportunityForm, SourceLine, STAGE_LABEL, TAG_LABEL, type OpportunityInput } from '@/client/Funding';
import { OpenGrantsSearch } from '@/client/OpenGrantsSearch';
import { deleteJson, errorMessage, getJson, patchJson, postJson, putJson } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import type { Opportunity, Report, ReportItem, ReportTag } from '@/lib/types';
import { Button, Checkbox, Field, Input, Notice, Segmented, Select, Textarea } from '@/ui/controls';
import { Pill } from '@/ui/display';
import { OpportunityCard } from '@/ui/documents';

export const Route = createFileRoute('/workspace/clients/$clientId/reports/$reportId')({ component: Builder });

const RESPONSE = { pursue: { label: 'Pursue', tone: 'ok' }, not_now: { label: 'Not now', tone: 'neutral' }, question: { label: 'Question', tone: 'info' } } as const;

function ItemEditor({ item, draft, onPatch, onMove, onRemove, first, last }: {
  item: ReportItem;
  draft: boolean;
  onPatch: (body: { note?: string | null; tag?: ReportTag | null }) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  first: boolean;
  last: boolean;
}) {
  const o = item.opportunity;
  const [note, setNote] = useState(item.note ?? '');
  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="t-xs text-text2">{o.funderName ?? 'Funder not listed'}</span>
          <span className="font-medium">{o.title}</span>
          <span className="t-xs text-text2">{[money(o.amountMin, o.amountMax), o.deadlineAt ? `due ${formatDate(o.deadlineAt)}` : 'no deadline listed'].filter(Boolean).join(' · ')}</span>
          <SourceLine o={o} />
        </div>
        {draft ? (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" aria-label={`Move ${o.title} up`} disabled={first} onClick={() => onMove(-1)}>
              <ArrowUp aria-hidden className="i" />
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Move ${o.title} down`} disabled={last} onClick={() => onMove(1)}>
              <ArrowDown aria-hidden className="i" />
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Remove ${o.title} from the report`} onClick={onRemove}>
              <Trash2 aria-hidden className="i" />
            </Button>
          </div>
        ) : item.response ? (
          <Pill tone={RESPONSE[item.response].tone}>{RESPONSE[item.response].label}</Pill>
        ) : (
          <Pill>No answer yet</Pill>
        )}
      </div>
      {draft ? (
        <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
          <Select aria-label={`Tag for ${o.title}`} value={item.tag ?? ''} onChange={(e) => onPatch({ tag: (e.target.value || null) as ReportTag | null })}>
            <option value="">No tag</option>
            {(Object.keys(TAG_LABEL) as ReportTag[]).map((t) => (
              <option key={t} value={t}>
                {TAG_LABEL[t]}
              </option>
            ))}
          </Select>
          <Textarea
            aria-label={`Your note on ${o.title}`}
            rows={2}
            maxLength={4000}
            placeholder="Why it fits, what to watch for…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note !== (item.note ?? '') && onPatch({ note: note || null })}
          />
        </div>
      ) : (
        <>
          {item.note ? <p className="t-sm whitespace-pre-line text-text2">{item.note}</p> : null}
          {item.comment ? <p className="rounded-md bg-sunken px-3 py-2">“{item.comment}”</p> : null}
          {item.respondedAt ? <span className="t-xs text-text2">Answered {formatDateTime(item.respondedAt)} · now {STAGE_LABEL[o.stage]}</span> : null}
        </>
      )}
    </li>
  );
}

function AddPanel({ clientId, report, items }: { clientId: string; report: Report; items: ReportItem[] }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'saved' | 'manual' | 'search'>('saved');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const opps = useQuery({ queryKey: ['opportunities', clientId], queryFn: () => getJson<{ opportunities: Opportunity[] }>(`/api/clients/${clientId}/opportunities`) });
  const inReport = new Set(items.map((i) => i.opportunity.id));
  const available = (opps.data?.opportunities ?? []).filter((o) => !inReport.has(o.id));
  const base = `/api/clients/${clientId}/reports/${report.id}`;
  const refresh = () => qc.invalidateQueries({ queryKey: ['report', report.id] });
  const addItems = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await postJson(`${base}/items`, { opportunityId: id });
    },
    onSuccess: async () => {
      setPicked(new Set());
      await refresh();
    },
  });
  const manual = useMutation({
    mutationFn: async (v: OpportunityInput) => {
      const { id } = await postJson<{ id: string }>(`/api/clients/${clientId}/opportunities`, v);
      await postJson(`${base}/items`, { opportunityId: id });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['opportunities', clientId] });
      await refresh();
      setTab('saved');
    },
  });
  const ogSaved = new Set((opps.data?.opportunities ?? []).flatMap((o) => (o.ogId ? [o.ogId] : [])));
  return (
    <section className="card flex flex-col gap-4 p-4" aria-label="Add opportunities">
      <Segmented
        label="Add opportunities from"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'saved', label: 'Saved' },
          { value: 'manual', label: 'By hand' },
          { value: 'search', label: 'OpenGrants' },
        ]}
      />
      {tab === 'saved' ? (
        available.length ? (
          <>
            <ul className="flex flex-col gap-1">
              {available.map((o) => (
                <li key={o.id}>
                  <Checkbox
                    checked={picked.has(o.id)}
                    onChange={(v) =>
                      setPicked((s) => {
                        const n = new Set(s);
                        if (v) n.add(o.id);
                        else n.delete(o.id);
                        return n;
                      })
                    }
                    label={
                      <span>
                        {o.title}
                        <span className="t-xs ml-2 text-text2">{[o.funderName, o.deadlineAt ? `due ${formatDate(o.deadlineAt)}` : null].filter(Boolean).join(' · ')}</span>
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
            <div>
              <Button size="sm" disabled={!picked.size} loading={addItems.isPending} onClick={() => addItems.mutate([...picked])}>
                Add {picked.size || ''} to report
              </Button>
            </div>
          </>
        ) : (
          <p className="t-sm text-text2">Everything saved for this client is already in the report. Add one by hand or from OpenGrants.</p>
        )
      ) : null}
      {tab === 'manual' ? <OpportunityForm submitLabel="Add to report" busy={manual.isPending} error={manual.isError ? errorMessage(manual.error) : null} onSubmit={(v) => manual.mutate(v)} /> : null}
      {tab === 'search' ? <OpenGrantsSearch clientId={clientId} savedIds={ogSaved} onAdded={(id) => addItems.mutate([id])} /> : null}
      {addItems.isError ? <Notice tone="danger">{errorMessage(addItems.error)}</Notice> : null}
    </section>
  );
}

function Builder() {
  const { clientId, reportId } = Route.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const data = useQuery({ queryKey: ['report', reportId], queryFn: () => getJson<{ report: Report; items: ReportItem[] }>(`/api/clients/${clientId}/reports/${reportId}`) });
  const base = `/api/clients/${clientId}/reports/${reportId}`;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['report', reportId] }), qc.invalidateQueries({ queryKey: ['reports', clientId] })]);
  const act = useMutation({
    mutationFn: (p: { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string; body?: unknown }) =>
      p.method === 'PATCH' ? patchJson(p.path, p.body) : p.method === 'PUT' ? putJson(p.path, p.body) : p.method === 'DELETE' ? deleteJson(p.path) : postJson(p.path, p.body),
    onSuccess: refresh,
  });
  const [title, setTitle] = useState<string | null>(null);
  const [intro, setIntro] = useState<string | null>(null);

  if (data.isError) return <Notice tone="danger">{errorMessage(data.error)}</Notice>;
  if (!data.data) return <p className="text-text2">Loading…</p>;
  const { report, items } = data.data;
  const draft = report.status === 'draft';
  const move = (idx: number, dir: -1 | 1) => {
    const ids = items.map((i) => i.opportunity.id);
    const [x] = ids.splice(idx, 1);
    ids.splice(idx + dir, 0, x as string);
    act.mutate({ method: 'PUT', path: `${base}/order`, body: { opportunityIds: ids } });
  };

  return (
    <>
      <Link to="/workspace/clients/$clientId/reports" params={{ clientId }} className="t-sm inline-flex items-center gap-1 text-text2 hover:text-text">
        <ArrowLeft aria-hidden className="size-3.5" /> Reports
      </Link>
      {report.pendingReview ? <Notice tone="warn">A funding alert drafted this report. Nothing goes to the client until you send it.</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="t-h3 min-w-0 flex-1 truncate">{report.title}</h2>
        {report.status === 'sent' ? <Pill tone="ok">Sent {formatDate(report.sentAt)}</Pill> : <Pill>Draft</Pill>}
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'edit', label: draft ? 'Edit' : 'Answers' },
            { value: 'preview', label: 'Client preview' },
          ]}
        />
        <a className="btn btn-secondary btn-sm" href={`${base}/pdf`} download>
          <Download aria-hidden className="i" /> PDF
        </a>
        {draft ? (
          <Button
            size="sm"
            disabled={!items.length}
            loading={act.isPending && act.variables?.path.endsWith('/send')}
            onClick={() => window.confirm(`Send “${report.title}” to everyone at this client?`) && act.mutate({ method: 'POST', path: `${base}/send` })}
          >
            <Send aria-hidden className="i" /> Send
          </Button>
        ) : null}
      </div>
      {act.isError ? <Notice tone="danger">{errorMessage(act.error)}</Notice> : null}

      {view === 'preview' ? (
        <div className="mx-auto flex w-full max-w-[680px] flex-col gap-4">
          <p className="t-xs text-text2">This is what the client sees in their portal. The PDF has the same content.</p>
          {report.intro ? <p className="whitespace-pre-line">{report.intro}</p> : null}
          {items.map((i) => (
            <OpportunityCard
              key={i.opportunity.id}
              opp={cardOf(i.opportunity, { tag: i.tag ? TAG_LABEL[i.tag] : undefined, note: i.note ? { author: 'Your consultant', text: i.note } : undefined })}
              onRespond={() => undefined}
            />
          ))}
          {!items.length ? <p className="text-text2">No opportunities yet.</p> : null}
        </div>
      ) : (
        <>
          {draft ? (
            <section className="card flex flex-col gap-3 p-4" aria-label="Report details">
              <Field label="Title">
                {(p) => (
                  <Input
                    {...p}
                    maxLength={160}
                    value={title ?? report.title}
                    onChange={(e) => setTitle(e.target.value)}
                    onBlur={() => title !== null && title.trim() && title !== report.title && act.mutate({ method: 'PATCH', path: base, body: { title } })}
                  />
                )}
              </Field>
              <Field label="Introduction" hint="Plain text, shown above the opportunities and in the email.">
                {(p) => (
                  <Textarea
                    {...p}
                    rows={3}
                    maxLength={8000}
                    value={intro ?? report.intro ?? ''}
                    onChange={(e) => setIntro(e.target.value)}
                    onBlur={() => intro !== null && intro !== (report.intro ?? '') && act.mutate({ method: 'PATCH', path: base, body: { intro: intro || null } })}
                  />
                )}
              </Field>
            </section>
          ) : report.intro ? (
            <p className="whitespace-pre-line text-text2">{report.intro}</p>
          ) : null}

          <section className="card overflow-hidden" aria-labelledby="items-h">
            <h3 id="items-h" className="sech">
              Opportunities <span className="ct">{items.length}</span>
              {!draft ? <span className="t-xs ml-auto font-normal text-text2">{report.answeredCount} answered</span> : null}
            </h3>
            {items.length ? (
              <ol className="divide-y divide-border">
                {items.map((i, idx) => (
                  <ItemEditor
                    key={i.opportunity.id}
                    item={i}
                    draft={draft}
                    first={idx === 0}
                    last={idx === items.length - 1}
                    onPatch={(body) => act.mutate({ method: 'PATCH', path: `${base}/items/${i.opportunity.id}`, body })}
                    onMove={(dir) => move(idx, dir)}
                    onRemove={() => act.mutate({ method: 'DELETE', path: `${base}/items/${i.opportunity.id}` })}
                  />
                ))}
              </ol>
            ) : (
              <p className="t-sm px-4 py-4 text-text2">Add opportunities below.</p>
            )}
          </section>

          {!draft && items.some((i) => i.response === 'pursue') ? (
            <Notice tone="ok" action={<Button size="sm" variant="ghost" onClick={() => void navigate({ to: '/workspace/clients/$clientId/pipeline', params: { clientId } })}>Open pipeline</Button>}>
              Pursued opportunities are on the pipeline as Researching. From there you can plan their deliverables from a template.
            </Notice>
          ) : null}

          {draft ? <AddPanel clientId={clientId} report={report} items={items} /> : null}

          {draft ? (
            <div>
              <Button variant="ghost" size="sm" onClick={() => window.confirm('Delete this draft?') && deleteJson(base).then(() => refresh()).then(() => navigate({ to: '/workspace/clients/$clientId/reports', params: { clientId } }))}>
                Delete draft
              </Button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
