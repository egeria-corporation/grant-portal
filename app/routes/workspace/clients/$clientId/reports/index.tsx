/** A client's funding reports (spec §5.3): drafts, sent reports and how the client answered. */
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { errorMessage, getJson, postJson } from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { Report } from '@/lib/types';
import { Button, Input, Notice } from '@/ui/controls';
import { EmptyState, Pill } from '@/ui/display';

export const Route = createFileRoute('/workspace/clients/$clientId/reports/')({ component: Reports });

function Reports() {
  const { clientId } = Route.useParams();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const reports = useQuery({ queryKey: ['reports', clientId], queryFn: () => getJson<{ reports: Report[] }>(`/api/clients/${clientId}/reports`) });
  const create = useMutation({
    mutationFn: () => postJson<{ id: string }>(`/api/clients/${clientId}/reports`, { title }),
    onSuccess: (r) => void navigate({ to: '/workspace/clients/$clientId/reports/$reportId', params: { clientId, reportId: r.id } }),
  });
  const list = reports.data?.reports ?? [];
  const defaultTitle = `Funding opportunities: ${new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date())}`;
  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="t-h3 flex-1">Funding reports</h2>
        {!creating ? (
          <Button
            size="sm"
            onClick={() => {
              setTitle(defaultTitle);
              setCreating(true);
            }}
          >
            New report
          </Button>
        ) : null}
      </div>
      {creating ? (
        <form
          className="card flex flex-wrap items-end gap-2 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="flex min-w-[240px] flex-1 flex-col gap-1">
            <span className="label">Title</span>
            <Input required maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <Button type="submit" loading={create.isPending} disabled={!title.trim()}>
            Create draft
          </Button>
          <Button variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
          {create.isError ? <Notice tone="danger">{errorMessage(create.error)}</Notice> : null}
        </form>
      ) : null}
      {list.length ? (
        <section className="card overflow-hidden" aria-label="Reports">
          <ul className="divide-y divide-border">
            {list.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <Link to="/workspace/clients/$clientId/reports/$reportId" params={{ clientId, reportId: r.id }} className="font-medium">
                    {r.title}
                  </Link>
                  <span className="t-xs text-text2">
                    {r.itemCount} opportunit{r.itemCount === 1 ? 'y' : 'ies'}
                    {r.status === 'sent' ? ` · sent ${formatDate(r.sentAt)} · ${r.answeredCount} answered, ${r.pursueCount} to pursue` : ` · updated ${formatDate(r.updatedAt ?? r.createdAt)}`}
                  </span>
                </div>
                {r.pendingReview ? <Pill tone="warn">Waiting for your review</Pill> : r.status === 'sent' ? <Pill tone="ok">Sent</Pill> : <Pill>Draft</Pill>}
              </li>
            ))}
          </ul>
        </section>
      ) : !creating ? (
        <EmptyState icon={FileText} title={reports.isPending ? 'Loading…' : 'No reports yet'} action={<Button size="sm" onClick={() => { setTitle(defaultTitle); setCreating(true); }}>Start a report</Button>}>
          A report is a branded set of opportunities with your notes. The client answers each one: Pursue, Not now, or a question.
        </EmptyState>
      ) : null}
    </>
  );
}
