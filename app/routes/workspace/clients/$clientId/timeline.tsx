/** Client timeline (spec §5.2): everything that happened, newest first. */
import { useInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { getJson } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/ui/controls';

export const Route = createFileRoute('/workspace/clients/$clientId/timeline')({ component: Timeline });

interface Event {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
  actor: { name: string | null; kind: string | null } | null;
}

const s = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** Plain-language line per event type. Unknown types fall back to the type name. */
export function describe(e: Event): string {
  const p = e.payload;
  switch (e.type) {
    case 'client.created':
      return 'created the client';
    case 'client.updated':
      return 'updated the profile';
    case 'client.status_changed':
      return `changed the status to ${s(p.to)}`;
    case 'client.ein_updated':
      return 'updated the EIN';
    case 'client.ein_revealed':
      return 'revealed the EIN';
    case 'client.assignments_changed':
      return 'changed the assigned consultants';
    case 'member.invited':
      return `invited a ${s(p.role) || 'new'} user`;
    case 'member.signed_in':
      return 'signed in';
    case 'file.uploaded':
      return `uploaded ${s(p.filename)}`;
    case 'file.updated':
      return 'updated a document';
    case 'file.deleted':
      return `deleted ${s(p.filename)}`;
    case 'request.created':
      return `requested documents: ${s(p.title)}`;
    case 'request.updated':
      return 'updated a document request';
    case 'request.item_fulfilled':
      return `sent ${s(p.label)}`;
    case 'request.item_returned':
      return `asked again for ${s(p.label)}`;
    case 'request.completed':
      return `completed ${s(p.title)}`;
    case 'deliverable.created':
      return p.template ? `added ${s(p.count)} deliverables from ${s(p.template)}` : `added the deliverable ${s(p.title)}`;
    case 'deliverable.updated':
      return p.status ? `moved ${s(p.title)} to ${s(p.status).replace('_', ' ')}` : `updated ${s(p.title)}`;
    case 'deliverable.deleted':
      return `deleted the deliverable ${s(p.title)}`;
    case 'deliverable.version_added':
      return `added v${s(p.version)} of ${s(p.title)}`;
    case 'deliverable.approved':
      return `approved v${s(p.version)} of ${s(p.title)}`;
    case 'deliverable.changes_requested':
      return `asked for changes to v${s(p.version)} of ${s(p.title)}`;
    case 'message.posted':
      return 'sent a message';
    case 'demo.loaded':
      return 'loaded the demo data';
    default:
      return e.type;
  }
}

function Timeline() {
  const { clientId } = Route.useParams();
  const q = useInfiniteQuery({
    queryKey: ['timeline', clientId],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getJson<{ events: Event[] }>(`/api/clients/${clientId}/timeline${pageParam ? `?before=${pageParam}` : ''}`),
    getNextPageParam: (last) => (last.events.length === 100 ? last.events.at(-1)?.createdAt : undefined),
  });
  const events = q.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <section className="card overflow-hidden" aria-label="Timeline">
      <ol className="divide-y divide-border">
        {events.map((e) => (
          <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 px-4 py-2.5">
            <span className="t-xs w-36 shrink-0 tabular-nums text-text3">{formatDateTime(e.createdAt)}</span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{e.actor?.name ?? 'System'}</span> {describe(e)}
            </span>
          </li>
        ))}
        {!events.length ? <li className="t-sm px-4 py-3 text-text2">{q.isPending ? 'Loading…' : 'Nothing yet.'}</li> : null}
      </ol>
      {q.hasNextPage ? (
        <div className="border-t border-border p-3">
          <Button variant="ghost" size="sm" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Show older
          </Button>
        </div>
      ) : null}
    </section>
  );
}
