/**
 * Deliverables list and review screen (spec §5.5, §6.5). The owning side adds
 * versions (upload, pick from the vault, or a link); the other side approves
 * or asks for changes with a comment. Every version stays in the history.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleCheck, ExternalLink, FileCheck2, Link2, MessageSquareText } from 'lucide-react';
import { useRef, useState } from 'react';
import { errorMessage, getJson, postJson } from '@/lib/api';
import { formatDate, STATUS_LABEL, timeAgo } from '@/lib/format';
import type { ClientAccess, Deliverable, DeliverableDetail, DeliverableStatus } from '@/lib/types';
import { uploadToVault } from '@/lib/upload';
import { Button, Field, Input, Notice, Select, Textarea } from '@/ui/controls';
import { DeadlineChip, EmptyState, Pill, type PillTone } from '@/ui/display';
import { ApprovalBar } from '@/ui/documents';
import { Thread } from './Thread';
import { FileRow, useVault, vaultKey } from './Vault';

export const STATUS_TONE: Record<DeliverableStatus, PillTone> = {
  not_started: 'neutral',
  in_progress: 'info',
  in_review: 'warn',
  approved: 'ok',
  done: 'ok',
};

export function deliverablesKey(clientId: string) {
  return ['deliverables', clientId] as const;
}

export function useDeliverables(clientId: string) {
  return useQuery({ queryKey: deliverablesKey(clientId), queryFn: () => getJson<{ deliverables: Deliverable[] }>(`/api/clients/${clientId}/deliverables`) });
}

/** What the status means for the person looking at it. */
export function statusFor(d: Deliverable, access: ClientAccess): { label: string; tone: PillTone } {
  const client = access !== 'staff';
  if (d.status === 'in_review') {
    const waitingOnMe = client ? d.side === 'consultant' : d.side === 'client';
    return { label: waitingOnMe ? 'Waiting on you' : client ? 'With your consultant' : 'Waiting on client', tone: 'warn' };
  }
  if (d.status === 'in_progress' && d.latestDecision === 'changes') return { label: 'Changes requested', tone: 'info' };
  return { label: STATUS_LABEL[d.status] ?? d.status, tone: STATUS_TONE[d.status] };
}

export function DeliverableList({
  clientId,
  access,
  linkTo,
  emptyAction,
}: {
  clientId: string;
  access: ClientAccess;
  linkTo: (d: Deliverable) => { to: string; params: Record<string, string> };
  emptyAction?: React.ReactNode;
}) {
  const list = useDeliverables(clientId);
  const rows = list.data?.deliverables ?? [];
  if (!rows.length) {
    return (
      <EmptyState icon={FileCheck2} title={list.isPending ? 'Loading…' : 'No deliverables yet'} action={emptyAction}>
        {access === 'staff' ? 'Track what you owe the client, and what they owe you.' : 'Drafts for you to review will appear here.'}
      </EmptyState>
    );
  }
  return (
    <ul className="card divide-y divide-border overflow-hidden">
      {rows.map((d) => {
        const s = statusFor(d, access);
        const link = linkTo(d);
        return (
          <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Link to={link.to} params={link.params} className="truncate font-medium text-text hover:text-acc-text hover:underline">
                {d.title}
              </Link>
              <span className="t-xs text-text2">
                {d.side === 'consultant' ? (access === 'staff' ? 'We deliver' : 'From your consultant') : access === 'staff' ? 'Client delivers' : 'From you'}
                {d.versionCount ? ` · v${d.versionCount}` : ''}
                {d.assignee?.name ? ` · ${d.assignee.name}` : ''}
                {d.opportunity?.title ? ` · ${d.opportunity.title}` : ''}
              </span>
            </div>
            {d.dueAt && !['approved', 'done'].includes(d.status) ? (
              <DeadlineChip dueAt={d.dueAt} windowDays={30} sub={formatDate(d.dueAt, { month: 'short', day: 'numeric' })} />
            ) : null}
            <Pill tone={s.tone}>{s.label}</Pill>
          </li>
        );
      })}
    </ul>
  );
}

function AddVersion({ clientId, deliverableId, onDone }: { clientId: string; deliverableId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const vault = useVault(clientId);
  const [mode, setMode] = useState<'upload' | 'vault' | 'link'>('upload');
  const [fileId, setFileId] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);

  const submit = async () => {
    setError(null);
    try {
      let id = fileId;
      if (mode === 'upload') {
        if (!picked) return setError('Choose a file first.');
        setProgress(0);
        id = (await uploadToVault(clientId, picked, { folder: 'Submitted Applications', onProgress: setProgress })).id;
        void qc.invalidateQueries({ queryKey: vaultKey(clientId) });
      }
      await postJson(`/api/clients/${clientId}/deliverables/${deliverableId}/versions`, mode === 'link' ? { url, note: note || undefined } : { fileId: id, note: note || undefined });
      await Promise.all([qc.invalidateQueries({ queryKey: ['deliverable', clientId, deliverableId] }), qc.invalidateQueries({ queryKey: deliverablesKey(clientId) })]);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <form
      className="card flex flex-col gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="t-h4">Add a version</h3>
      <div role="radiogroup" aria-label="Source" className="flex flex-wrap gap-2">
        {(['upload', 'vault', 'link'] as const).map((m) => (
          <Button key={m} size="sm" variant={mode === m ? 'primary' : 'secondary'} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
            {m === 'upload' ? 'Upload a file' : m === 'vault' ? 'From documents' : 'Link'}
          </Button>
        ))}
      </div>
      {mode === 'upload' ? (
        <div className="flex items-center gap-2">
          <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => setPicked(e.target.files?.[0] ?? null)} />
          <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
            Choose file
          </Button>
          <span className="t-sm truncate text-text2">{picked?.name ?? 'No file chosen'}</span>
          {progress !== null ? <span className="t-xs tabular-nums text-text2">{Math.round(progress * 100)}%</span> : null}
        </div>
      ) : mode === 'vault' ? (
        <Field label="Document">
          {(p) => (
            <Select {...p} value={fileId} onChange={(e) => setFileId(e.target.value)}>
              <option value="">Choose a document…</option>
              {vault.data?.files
                .filter((f) => f.shared)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.filename}
                  </option>
                ))}
            </Select>
          )}
        </Field>
      ) : (
        <Field label="Link" hint="An https link, e.g. a shared Google Doc">
          {(p) => <Input {...p} type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />}
        </Field>
      )}
      <Field label="Note (optional)">{(p) => <Textarea {...p} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed in this version" />}</Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex gap-2">
        <Button type="submit" loading={progress !== null}>
          Send for review
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function DeliverableView({ clientId, deliverableId, access, backLink }: { clientId: string; deliverableId: string; access: ClientAccess; backLink: React.ReactNode }) {
  const qc = useQueryClient();
  const key = ['deliverable', clientId, deliverableId] as const;
  const detail = useQuery({ queryKey: key, queryFn: () => getJson<DeliverableDetail>(`/api/clients/${clientId}/deliverables/${deliverableId}`) });
  const [adding, setAdding] = useState(false);
  const [changes, setChanges] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (p: { versionId: string; decision: 'approved' | 'changes'; comment?: string }) =>
      postJson(`/api/clients/${clientId}/deliverables/${deliverableId}/versions/${p.versionId}/decision`, { decision: p.decision, comment: p.comment }),
    onSuccess: async () => {
      setChanges(null);
      await Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: deliverablesKey(clientId) }), qc.invalidateQueries({ queryKey: ['overview', clientId] })]);
    },
  });

  if (detail.isError) return <Notice tone="danger">{errorMessage(detail.error)}</Notice>;
  if (!detail.data) return <p className="text-text2">Loading…</p>;
  const { deliverable: d, versions, canAddVersion, canDecide } = detail.data;
  const latest = versions[0];
  const pendingDecision = latest && !latest.decisions.length && d.status === 'in_review';
  const s = statusFor(d, access);

  return (
    <div className="flex flex-col gap-5 pb-28">
      {backLink}
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="hd text-[24px] leading-8">{d.title}</h1>
          <p className="t-sm text-text2">
            {d.side === 'consultant' ? (access === 'staff' ? 'We deliver to the client' : 'From your consultant') : access === 'staff' ? 'The client delivers to us' : 'From you to your consultant'}
            {d.dueAt ? ` · due ${formatDate(d.dueAt)}` : ''}
          </p>
          {d.description ? <p className="mt-1 whitespace-pre-line">{d.description}</p> : null}
        </div>
        <Pill tone={s.tone} size="lg">
          {s.label}
        </Pill>
      </div>

      {canAddVersion && !adding ? (
        <div>
          <Button variant={versions.length ? 'secondary' : 'primary'} onClick={() => setAdding(true)}>
            {versions.length ? 'Add a new version' : 'Add the first version'}
          </Button>
        </div>
      ) : null}
      {adding ? <AddVersion clientId={clientId} deliverableId={deliverableId} onDone={() => setAdding(false)} /> : null}

      <section aria-labelledby="versions-h" className="card overflow-hidden">
        <h2 id="versions-h" className="sech">
          Versions<span className="ct">{versions.length}</span>
        </h2>
        {versions.length ? (
          <ol>
            {versions.map((v) => (
              <li key={v.id} className={v === latest ? 'border-t border-border bg-acc-50' : 'border-t border-border'}>
                <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
                  <span className="t-mono font-medium">v{v.version}</span>
                  <span className="t-xs text-text2">
                    {v.createdBy.name ?? 'Someone'} · {timeAgo(v.createdAt)}
                  </span>
                  {v.decisions.map((dec) => (
                    <Pill key={dec.id} tone={dec.decision === 'approved' ? 'ok' : 'info'}>
                      {dec.decision === 'approved' ? `Approved by ${dec.by.name ?? 'reviewer'}` : `Changes requested by ${dec.by.name ?? 'reviewer'}`}
                    </Pill>
                  ))}
                </div>
                {v.note ? <p className="t-sm whitespace-pre-line px-4 pt-1 text-text2">{v.note}</p> : null}
                {v.decisions
                  .filter((dec) => dec.comment)
                  .map((dec) => (
                    <p key={dec.id} className="t-sm mx-4 mt-2 flex gap-2 rounded-md bg-sunken px-3 py-2">
                      <MessageSquareText aria-hidden className="mt-0.5 size-4 shrink-0 text-text3" />
                      <span className="whitespace-pre-line">{dec.comment}</span>
                    </p>
                  ))}
                {v.file ? (
                  <FileRow file={v.file} />
                ) : v.url ? (
                  <div className="px-4 py-3">
                    <a href={v.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-acc-text hover:underline">
                      <Link2 aria-hidden className="size-4" />
                      {new URL(v.url).host}
                      <ExternalLink aria-hidden className="size-3.5" />
                    </a>
                  </div>
                ) : (
                  <p className="t-sm px-4 py-3 text-text3">The file for this version was removed.</p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="t-sm border-t border-border px-4 py-3 text-text2">No versions yet.</p>
        )}
      </section>

      <section aria-labelledby="discussion-h" className="flex flex-col gap-2">
        <h2 id="discussion-h" className="t-h4">
          Discussion
        </h2>
        <Thread clientId={clientId} thread={deliverableId} placeholder={`Message about ${d.title}`} compact />
      </section>

      {canDecide && pendingDecision && latest ? (
        <div className="fixed inset-x-0 bottom-0 z-10 mx-auto max-w-5xl px-4 pb-4">
          {changes !== null ? (
            <form
              className="panel flex flex-col gap-2 p-4 shadow-pop"
              onSubmit={(e) => {
                e.preventDefault();
                decide.mutate({ versionId: latest.id, decision: 'changes', comment: changes });
              }}
            >
              <Field label={`What should change in v${latest.version}?`}>
                {(p) => <Textarea {...p} rows={3} value={changes} onChange={(e) => setChanges(e.target.value)} required autoFocus />}
              </Field>
              {decide.isError ? <Notice tone="danger">{errorMessage(decide.error)}</Notice> : null}
              <div className="flex gap-2">
                <Button type="submit" loading={decide.isPending} disabled={!changes.trim()}>
                  Send request
                </Button>
                <Button variant="ghost" onClick={() => setChanges(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <>
              {decide.isError ? <Notice tone="danger">{errorMessage(decide.error)}</Notice> : null}
              <ApprovalBar
                title={`Review v${latest.version}`}
                detail={access === 'staff' ? 'Approve it, or ask the client for changes.' : 'Approve it, or tell your consultant what to change.'}
                onApprove={() => decide.mutate({ versionId: latest.id, decision: 'approved' })}
                onRequestChanges={() => setChanges('')}
              />
            </>
          )}
        </div>
      ) : d.status === 'approved' && latest?.decisions[0]?.decision === 'approved' ? (
        <p className="t-sm inline-flex items-center gap-2 text-ok-text" role="status">
          <CircleCheck aria-hidden className="size-4" /> Approved {timeAgo(latest.decisions[0].createdAt)}
        </p>
      ) : null}
    </div>
  );
}
