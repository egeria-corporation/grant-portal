/** Portal: funding reports from the consultant, and the client's own pipeline (spec §6.4, §5.4). */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { FileText } from 'lucide-react';
import { PipelineBoard } from '@/client/Funding';
import { usePortalClient } from '@/client/portalClient';
import { getJson } from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { Opportunity, Report } from '@/lib/types';
import { EmptyState, Pill } from '@/ui/display';

export const Route = createFileRoute('/portal/reports/')({ component: PortalReports });

function PortalReports() {
  const { client } = usePortalClient();
  const reports = useQuery({ queryKey: ['reports', client?.id], queryFn: () => getJson<{ reports: Report[] }>(`/api/clients/${client?.id}/reports`), enabled: Boolean(client) });
  const opps = useQuery({
    queryKey: ['opportunities', client?.id],
    queryFn: () => getJson<{ opportunities: Opportunity[] }>(`/api/clients/${client?.id}/opportunities`),
    enabled: Boolean(client),
  });
  const list = reports.data?.reports ?? [];
  const pipeline = (opps.data?.opportunities ?? []).filter((o) => o.stage !== 'none');
  return (
    <>
      <h1 className="hd text-[26px] leading-8">Funding</h1>
      <section className="card overflow-hidden" aria-labelledby="reports-h">
        <h2 id="reports-h" className="sech">
          Reports
        </h2>
        {list.length ? (
          <ul className="divide-y divide-border">
            {list.map((r) => {
              const open = r.itemCount - r.answeredCount;
              return (
                <li key={r.id}>
                  <Link to="/portal/reports/$reportId" params={{ reportId: r.id }} className="flex flex-wrap items-center gap-3 px-4 py-3 text-text no-underline hover:bg-hover">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">{r.title}</span>
                      <span className="t-xs text-text2">
                        {formatDate(r.sentAt)} · {r.itemCount} opportunit{r.itemCount === 1 ? 'y' : 'ies'}
                      </span>
                    </span>
                    {open ? <Pill tone="acc">{open} to answer</Pill> : <Pill tone="ok">Answered</Pill>}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={FileText} title={reports.isPending ? 'Loading…' : 'No reports yet'}>
            When your consultant finds funding that fits, the report appears here and you’ll get an email.
          </EmptyState>
        )}
      </section>
      {pipeline.length ? (
        <section className="flex flex-col gap-3" aria-labelledby="pipe-h">
          <h2 id="pipe-h" className="t-h3">
            Your pipeline
          </h2>
          <PipelineBoard items={pipeline} />
        </section>
      ) : null}
    </>
  );
}
