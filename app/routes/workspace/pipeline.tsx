/** Every client's pipeline on one board (spec §5.4 "cross-client pipeline view"). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { KanbanSquare } from 'lucide-react';
import { useState } from 'react';
import { PipelineBoard } from '@/client/Funding';
import { errorMessage, getJson, patchJson } from '@/lib/api';
import type { Opportunity, Stage } from '@/lib/types';
import { Notice, Select } from '@/ui/controls';
import { EmptyState } from '@/ui/display';

export const Route = createFileRoute('/workspace/pipeline')({ component: AllPipeline });

function AllPipeline() {
  const qc = useQueryClient();
  const [client, setClient] = useState('');
  const data = useQuery({ queryKey: ['pipeline'], queryFn: () => getJson<{ opportunities: Opportunity[] }>('/api/pipeline') });
  const move = useMutation({
    mutationFn: (p: { o: Opportunity; stage: Stage }) => patchJson(`/api/clients/${p.o.clientId}/opportunities/${p.o.id}`, { stage: p.stage }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pipeline'] }),
  });
  const all = data.data?.opportunities ?? [];
  const clients = [...new Map(all.map((o) => [o.clientId, o.clientName ?? ''])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const shown = client ? all.filter((o) => o.clientId === client) : all;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="hd flex-1 text-[24px] leading-8">Pipeline</h1>
        {clients.length > 1 ? (
          <Select aria-label="Filter by client" className="w-auto" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">All clients</option>
            {clients.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
      {move.isError ? <Notice tone="danger">{errorMessage(move.error)}</Notice> : null}
      {shown.length ? (
        <PipelineBoard
          items={shown}
          showClient
          onMove={(o, stage) => move.mutate({ o, stage })}
          actions={(o) => (
            <Link to="/workspace/clients/$clientId/pipeline" params={{ clientId: o.clientId }} className="t-xs">
              Open client pipeline
            </Link>
          )}
        />
      ) : (
        <EmptyState icon={KanbanSquare} title={data.isPending ? 'Loading…' : 'Nothing in the pipeline yet'}>
          When a client chooses Pursue in a report, or you add an opportunity to their pipeline, it shows up here.
        </EmptyState>
      )}
    </>
  );
}
