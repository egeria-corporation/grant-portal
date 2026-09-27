/** Updates the consultant has sent (spec §5.7), newest first. */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Newspaper } from 'lucide-react';
import { usePortalClient } from '@/client/portalClient';
import { getJson } from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { ClientUpdate } from '@/lib/types';
import { EmptyState } from '@/ui/display';
import { BlockList } from '@/client/BlockList';

export const Route = createFileRoute('/portal/updates')({ component: Updates });

function Updates() {
  const { client } = usePortalClient();
  const updates = useQuery({
    queryKey: ['updates', client?.id],
    queryFn: () => getJson<{ updates: ClientUpdate[] }>(`/api/clients/${client?.id}/updates`),
    enabled: Boolean(client),
  });
  if (!client) return null;
  const list = updates.data?.updates ?? [];
  return (
    <>
      <h1 className="hd text-[26px] leading-8">Updates</h1>
      {list.length ? (
        list.map((u) => (
          <article key={u.id} className="card flex flex-col gap-3 p-5">
            <header>
              <h2 className="t-h3">{u.subject}</h2>
              <p className="t-xs text-text2">{u.sentAt ? formatDate(u.sentAt) : ''}</p>
            </header>
            {u.intro ? <p className="whitespace-pre-line">{u.intro}</p> : null}
            {u.content ? <BlockList blocks={u.content} /> : null}
          </article>
        ))
      ) : (
        <EmptyState icon={Newspaper} title={updates.isPending ? 'Loading…' : 'No updates yet'}>
          Updates from your consultant will appear here.
        </EmptyState>
      )}
    </>
  );
}
