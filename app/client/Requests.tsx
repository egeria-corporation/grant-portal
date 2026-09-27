/**
 * Document requests as checklists (spec §5.6, §6.3). Clients upload straight
 * into each item; staff see what arrived and can send an item back.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, CloudUpload, Download, RotateCcw } from 'lucide-react';
import { useRef, useState } from 'react';
import { deleteJson, errorMessage, getJson, patchJson, putJson } from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { ClientAccess, DocRequest, RequestItem } from '@/lib/types';
import { fileUrl, uploadToVault } from '@/lib/upload';
import { Button, Notice } from '@/ui/controls';
import { DeadlineChip, EmptyState, Pill, SegBar } from '@/ui/display';
import { ChecklistItem } from '@/ui/documents';
import { vaultKey } from './Vault';

export function requestsKey(clientId: string) {
  return ['requests', clientId] as const;
}

export function useRequests(clientId: string) {
  return useQuery({ queryKey: requestsKey(clientId), queryFn: () => getJson<{ requests: DocRequest[] }>(`/api/clients/${clientId}/requests`) });
}

function reminderText(r: DocRequest['reminders']): string | null {
  if (!r) return null;
  const parts = [
    ...r.beforeDays.map((d) => `${d} day${d === 1 ? '' : 's'} before`),
    ...(r.onDue ? ['on the due date'] : []),
    ...r.afterDays.map((d) => `${d} day${d === 1 ? '' : 's'} after`),
  ];
  return parts.length ? `Reminders ${parts.join(', ')}` : 'No reminders';
}

function ItemRow({ clientId, request, item, access }: { clientId: string; request: DocRequest; item: RequestItem; access: ClientAccess }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const staff = access === 'staff';
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: requestsKey(clientId) }), qc.invalidateQueries({ queryKey: vaultKey(clientId) }), qc.invalidateQueries({ queryKey: ['overview', clientId] })]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      const uploaded = await uploadToVault(clientId, file, { folder: null, onProgress: setProgress });
      await putJson(`/api/clients/${clientId}/requests/${request.id}/items/${item.id}/file`, { fileId: uploaded.id });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  };
  const sendBack = useMutation({
    mutationFn: () => deleteJson(`/api/clients/${clientId}/requests/${request.id}/items/${item.id}/file`),
    onSuccess: refresh,
  });

  const open = request.status !== 'cancelled';
  const status = progress !== null ? 'uploading' : item.fulfilledAt ? 'received' : error ? 'rejected' : 'needed';
  return (
    <ChecklistItem
      title={item.label}
      detail={[item.hint, item.required ? null : 'Optional', item.file ? item.file.filename : null].filter(Boolean).join(' · ') || undefined}
      status={status}
      progress={progress ?? undefined}
      note={error}
      receivedAt={item.fulfilledAt ? formatDate(item.fulfilledAt, { month: 'short', day: 'numeric' }) : undefined}
      action={
        open ? (
          <>
            <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void upload(e.target.files?.[0])} />
            <Button variant="secondary" size="sm" onClick={() => input.current?.click()} aria-label={`Upload ${item.label}`}>
              <CloudUpload aria-hidden className="i" />
              Upload
            </Button>
          </>
        ) : null
      }
      overdue={
        item.fulfilledAt && item.file ? (
          <>
            <a href={fileUrl(item.file.id)} download className="t-xs inline-flex items-center gap-1 text-acc-text hover:underline">
              <Download aria-hidden className="size-3" /> Download
            </a>
            {staff && open ? (
              <button type="button" className="t-xs inline-flex items-center gap-1 text-text2 hover:text-text hover:underline" onClick={() => sendBack.mutate()}>
                <RotateCcw aria-hidden className="size-3" /> Ask again
              </button>
            ) : null}
            {!staff && open ? (
              <button type="button" className="t-xs text-text2 hover:text-text hover:underline" onClick={() => input.current?.click()}>
                Replace
              </button>
            ) : null}
          </>
        ) : undefined
      }
    />
  );
}

export function RequestCard({ clientId, request, access }: { clientId: string; request: DocRequest; access: ClientAccess }) {
  const qc = useQueryClient();
  const done = request.items.filter((i) => i.fulfilledAt).length;
  const cancel = useMutation({
    mutationFn: (status: 'open' | 'cancelled') => patchJson(`/api/clients/${clientId}/requests/${request.id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: requestsKey(clientId) }),
  });
  return (
    <section className="card overflow-hidden" aria-labelledby={`req-${request.id}`}>
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 id={`req-${request.id}`} className="t-h4">
            {request.title}
          </h3>
          {request.message ? <p className="t-sm whitespace-pre-line text-text2">{request.message}</p> : null}
          {access === 'staff' ? <span className="t-xs text-text3">{reminderText(request.reminders)}</span> : null}
        </div>
        <SegBar done={done} total={request.items.length} complete={request.status === 'complete'} />
        {request.status === 'complete' ? (
          <Pill tone="ok">Complete</Pill>
        ) : request.status === 'cancelled' ? (
          <Pill>Cancelled</Pill>
        ) : request.dueAt ? (
          <DeadlineChip dueAt={request.dueAt} windowDays={14} sub={formatDate(request.dueAt, { month: 'short', day: 'numeric' })} />
        ) : null}
        {access === 'staff' ? (
          <Button variant="ghost" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate(request.status === 'cancelled' ? 'open' : 'cancelled')}>
            {request.status === 'cancelled' ? 'Reopen' : 'Cancel request'}
          </Button>
        ) : null}
      </header>
      <div className="flex flex-col">
        {request.items.map((item) => (
          <ItemRow key={item.id} clientId={clientId} request={request} item={item} access={access} />
        ))}
      </div>
    </section>
  );
}

export function RequestList({ clientId, access, emptyAction }: { clientId: string; access: ClientAccess; emptyAction?: React.ReactNode }) {
  const requests = useRequests(clientId);
  if (requests.isError) return <Notice tone="danger">{errorMessage(requests.error)}</Notice>;
  const list = requests.data?.requests ?? [];
  if (!list.length) {
    return (
      <EmptyState icon={ClipboardList} title={requests.isPending ? 'Loading…' : 'No document requests'} action={emptyAction}>
        {access === 'staff' ? 'Ask for the documents you need; each one becomes a checklist item with an upload slot.' : 'Nothing to send right now.'}
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {list.map((r) => (
        <RequestCard key={r.id} clientId={clientId} request={r} access={access} />
      ))}
    </div>
  );
}
