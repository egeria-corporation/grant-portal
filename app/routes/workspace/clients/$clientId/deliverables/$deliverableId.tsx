/** Deliverable detail for staff: versions, review, discussion, and status controls. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { DeliverableView, deliverablesKey } from '@/client/Deliverables';
import { deleteJson, errorMessage, patchJson } from '@/lib/api';
import { STATUS_LABEL } from '@/lib/format';
import type { DeliverableStatus } from '@/lib/types';
import { Button, Notice, Select } from '@/ui/controls';

export const Route = createFileRoute('/workspace/clients/$clientId/deliverables/$deliverableId')({ component: DeliverablePage });

const STATUSES: DeliverableStatus[] = ['not_started', 'in_progress', 'in_review', 'approved', 'done'];

function DeliverablePage() {
  const { clientId, deliverableId } = Route.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const setStatus = useMutation({
    mutationFn: (status: DeliverableStatus) => patchJson(`/api/clients/${clientId}/deliverables/${deliverableId}`, { status }),
    onSuccess: () =>
      Promise.all([qc.invalidateQueries({ queryKey: ['deliverable', clientId, deliverableId] }), qc.invalidateQueries({ queryKey: deliverablesKey(clientId) })]),
  });
  const remove = useMutation({
    mutationFn: () => deleteJson(`/api/clients/${clientId}/deliverables/${deliverableId}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: deliverablesKey(clientId) });
      await navigate({ to: '/workspace/clients/$clientId/deliverables', params: { clientId } });
    },
  });
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="dlv-status" className="t-sm text-text2">
          Status
        </label>
        <Select id="dlv-status" className="w-auto" onChange={(e) => setStatus.mutate(e.target.value as DeliverableStatus)} defaultValue="">
          <option value="" disabled>
            Set status…
          </option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          loading={remove.isPending}
          onClick={() => {
            if (window.confirm('Delete this deliverable and its version history?')) remove.mutate();
          }}
        >
          Delete
        </Button>
      </div>
      {setStatus.isError || remove.isError ? <Notice tone="danger">{errorMessage(setStatus.error ?? remove.error)}</Notice> : null}
      <DeliverableView
        clientId={clientId}
        deliverableId={deliverableId}
        access="staff"
        backLink={
          <Link to="/workspace/clients/$clientId/deliverables" params={{ clientId }} className="t-sm inline-flex items-center gap-1 text-text2 hover:text-text">
            <ArrowLeft aria-hidden className="size-3.5" /> All deliverables
          </Link>
        }
      />
    </>
  );
}
