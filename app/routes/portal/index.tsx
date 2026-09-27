/**
 * Portal home (spec §6.2): "What do you need from me?" and "What's happening
 * with my funding?" in one glance.
 */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { CircleCheck, ClipboardList, FileCheck2, MessagesSquare } from 'lucide-react';
import { usePortalClient } from '@/client/portalClient';
import { getJson } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { useConfig } from '@/lib/session';
import type { Overview } from '@/lib/types';
import { DeadlineChip, EmptyState, IconTile, PipelineMini } from '@/ui/display';

export const Route = createFileRoute('/portal/')({ component: PortalHome });

function Row({ icon, title, detail, to, params }: { icon: typeof ClipboardList; title: string; detail: string; to: string; params?: Record<string, string> }) {
  return (
    <li>
      <Link to={to} params={params} className="flex items-center gap-3 px-4 py-3 text-text no-underline hover:bg-hover">
        <IconTile icon={icon} size={36} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{title}</span>
          <span className="t-xs text-text2">{detail}</span>
        </span>
      </Link>
    </li>
  );
}

function PortalHome() {
  const config = useConfig();
  const { client, isPending } = usePortalClient();
  const overview = useQuery({
    queryKey: ['overview', client?.id],
    queryFn: () => getJson<Overview>(`/api/clients/${client?.id}/overview`),
    enabled: Boolean(client),
  });
  const firm = config.data?.shortName || config.data?.firmName || 'Your consultant';
  const o = overview.data;
  if (!isPending && !client) {
    return <EmptyState icon={ClipboardList} title="You’re all set">{firm} hasn’t added you to an organization yet.</EmptyState>;
  }
  const attention = o ? o.openItems.length + o.awaitingDecision.length + o.owedByCaller.length + (o.unreadMessages ? 1 : 0) : 0;
  const stages = o?.pipeline ?? {};

  return (
    <>
      <div>
        <h1 className="hd text-[26px] leading-8">{client?.name ?? 'Welcome'}</h1>
        <p className="mt-1 text-text2">{attention ? `${attention} thing${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} your attention.` : 'Nothing needs you right now.'}</p>
      </div>

      <section className="card overflow-hidden" aria-labelledby="attn-h">
        <h2 id="attn-h" className="sech">
          Needs your attention{attention ? <span className="ct">{attention}</span> : null}
        </h2>
        {o && attention ? (
          <ul className="divide-y divide-border">
            {o.openItems.length ? (
              <Row
                icon={ClipboardList}
                to="/portal/documents"
                title={`${o.openItems.length} document${o.openItems.length === 1 ? '' : 's'} to upload`}
                detail={o.openItems
                  .slice(0, 3)
                  .map((i) => i.label)
                  .join(', ')}
              />
            ) : null}
            {o.awaitingDecision.map((d) => (
              <Row key={d.id} icon={FileCheck2} to="/portal/deliverables/$deliverableId" params={{ deliverableId: d.id }} title={`Review: ${d.title}`} detail={`Version ${d.versionCount} is ready for you`} />
            ))}
            {o.owedByCaller.map((d) => (
              <Row key={d.id} icon={FileCheck2} to="/portal/deliverables/$deliverableId" params={{ deliverableId: d.id }} title={d.title} detail={d.dueAt ? `Due ${formatDate(d.dueAt)}` : 'Requested by your consultant'} />
            ))}
            {o.unreadMessages ? (
              <Row icon={MessagesSquare} to="/portal/messages" title={`${o.unreadMessages} new message${o.unreadMessages === 1 ? '' : 's'}`} detail={`From ${firm}`} />
            ) : null}
          </ul>
        ) : (
          <p className="t-sm flex items-center gap-2 px-4 py-4 text-ok-text">
            <CircleCheck aria-hidden className="size-4" /> {overview.isPending ? 'Loading…' : 'You’re up to date.'}
          </p>
        )}
      </section>

      {o?.deadlines.length ? (
        <section className="card overflow-hidden" aria-labelledby="soon-h">
          <h2 id="soon-h" className="sech">
            Coming up
          </h2>
          <ul className="divide-y divide-border">
            {o.deadlines.slice(0, 5).map((d) => (
              <li key={`${d.kind}-${d.id}`} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
                <DeadlineChip dueAt={d.dueAt} windowDays={30} sub={formatDate(d.dueAt, { month: 'short', day: 'numeric' })} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {o?.latestUpdate ? (
        <section className="card flex flex-col gap-2 p-4" aria-labelledby="update-h">
          <h2 id="update-h" className="t-h4">
            {o.latestUpdate.subject}
          </h2>
          {o.latestUpdate.intro ? <p className="whitespace-pre-line text-text2">{o.latestUpdate.intro}</p> : null}
          <span className="t-xs text-text2">
            Update from {firm} · {timeAgo(o.latestUpdate.sentAt)} ·{' '}
            <Link to="/portal/updates" className="text-acc-text hover:underline">
              Read it
            </Link>
          </span>
        </section>
      ) : null}

      {o?.latestFromConsultant ? (
        <section className="card flex flex-col gap-2 p-4" aria-labelledby="latest-h">
          <h2 id="latest-h" className="t-h4">
            Latest from {firm}
          </h2>
          <p className="whitespace-pre-line">{o.latestFromConsultant.body}</p>
          <span className="t-xs text-text2">
            {o.latestFromConsultant.author} · {timeAgo(o.latestFromConsultant.createdAt)} ·{' '}
            <Link to="/portal/messages" className="text-acc-text hover:underline">
              Reply
            </Link>
          </span>
        </section>
      ) : null}

      {Object.keys(stages).length ? (
        <section className="card flex flex-col gap-3 p-4" aria-labelledby="pipe-h">
          <h2 id="pipe-h" className="t-h4">
            Your funding pipeline
          </h2>
          <PipelineMini counts={[stages.researching ?? 0, stages.preparing ?? 0, stages.submitted ?? 0, stages.awarded ?? 0]} />
          <p className="t-sm text-text2">
            {stages.researching ?? 0} researching · {stages.preparing ?? 0} preparing · {stages.submitted ?? 0} submitted · {stages.awarded ?? 0} awarded
          </p>
        </section>
      ) : null}
    </>
  );
}
