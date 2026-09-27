/**
 * Portal report (spec §6.4): the consultant's picks with their notes; the
 * client answers each one Pursue / Not now / Ask a question.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, Download } from 'lucide-react';
import { useState } from 'react';
import { cardOf, TAG_LABEL } from '@/client/Funding';
import { usePortalClient } from '@/client/portalClient';
import { errorMessage, getJson, postJson } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useConfig } from '@/lib/session';
import type { Report, ReportItem, ReportResponse } from '@/lib/types';
import { Button, Notice, Textarea } from '@/ui/controls';
import { OpportunityCard } from '@/ui/documents';

export const Route = createFileRoute('/portal/reports/$reportId')({ component: PortalReport });

function Item({ item, firm, onAnswer, busy }: { item: ReportItem; firm: string; onAnswer: (r: ReportResponse, comment?: string) => void; busy: boolean }) {
  const [changing, setChanging] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const answered = item.response && !changing;
  const message =
    item.response === 'pursue'
      ? `You chose to pursue this. ${firm} will start on it.`
      : item.response === 'question'
        ? `You asked: “${item.comment ?? ''}” ${firm} will get back to you.`
        : 'Not now. You can change your mind.';
  return (
    <OpportunityCard
      opp={cardOf(item.opportunity, { tag: item.tag ? TAG_LABEL[item.tag] : undefined, note: item.note ? { author: firm, text: item.note } : undefined })}
      response={answered && item.response ? { kind: item.response, message, onUndo: () => setChanging(true) } : undefined}
      onRespond={
        asking
          ? undefined
          : (kind) => {
              if (kind === 'question') setAsking(true);
              else {
                setChanging(false);
                onAnswer(kind);
              }
            }
      }
    >
      {asking ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onAnswer('question', question.trim());
            setAsking(false);
            setChanging(false);
          }}
        >
          <Textarea aria-label={`Your question about ${item.opportunity.title}`} rows={3} maxLength={2000} required value={question} onChange={(e) => setQuestion(e.target.value)} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={busy} disabled={!question.trim()}>
              Send question
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </OpportunityCard>
  );
}

function PortalReport() {
  const { reportId } = Route.useParams();
  const { client } = usePortalClient();
  const config = useConfig();
  const qc = useQueryClient();
  const firm = config.data?.shortName || config.data?.firmName || 'Your consultant';
  const base = `/api/clients/${client?.id}/reports/${reportId}`;
  const data = useQuery({ queryKey: ['report', reportId], queryFn: () => getJson<{ report: Report; items: ReportItem[] }>(base), enabled: Boolean(client) });
  const answer = useMutation({
    mutationFn: (p: { opportunityId: string; response: ReportResponse; comment?: string }) =>
      postJson(`${base}/items/${p.opportunityId}/respond`, { response: p.response, comment: p.comment || null }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['report', reportId] }),
        qc.invalidateQueries({ queryKey: ['reports', client?.id] }),
        qc.invalidateQueries({ queryKey: ['opportunities', client?.id] }),
        qc.invalidateQueries({ queryKey: ['overview', client?.id] }),
      ]),
  });
  if (data.isError) return <Notice tone="danger">{errorMessage(data.error)}</Notice>;
  if (!data.data) return <p className="text-text2">Loading…</p>;
  const { report, items } = data.data;
  const open = items.filter((i) => !i.response).length;
  return (
    <>
      <Link to="/portal/reports" className="t-sm inline-flex items-center gap-1 text-text2 hover:text-text">
        <ArrowLeft aria-hidden className="size-3.5" /> Funding
      </Link>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="hd text-[26px] leading-8">{report.title}</h1>
          <p className="t-sm text-text2">
            From {firm} · {formatDate(report.sentAt)} · {open ? `${open} to answer` : 'all answered'}
          </p>
        </div>
        <a className="btn btn-secondary btn-sm" href={`${base}/pdf`} download>
          <Download aria-hidden className="i" /> PDF
        </a>
      </div>
      {report.intro ? <p className="whitespace-pre-line">{report.intro}</p> : null}
      {answer.isError ? <Notice tone="danger">{errorMessage(answer.error)}</Notice> : null}
      <div className="flex flex-col gap-4">
        {items.map((i) => (
          <Item
            key={i.opportunity.id}
            item={i}
            firm={firm}
            busy={answer.isPending}
            onAnswer={(response, comment) => answer.mutate({ opportunityId: i.opportunity.id, response, comment })}
          />
        ))}
      </div>
    </>
  );
}
