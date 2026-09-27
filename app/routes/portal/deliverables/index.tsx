import { createFileRoute } from '@tanstack/react-router';
import { DeliverableList } from '@/client/Deliverables';
import { usePortalClient } from '@/client/portalClient';

export const Route = createFileRoute('/portal/deliverables/')({ component: Deliverables });

function Deliverables() {
  const { client } = usePortalClient();
  if (!client) return null;
  return (
    <>
      <h1 className="hd text-[26px] leading-8">Deliverables</h1>
      <DeliverableList clientId={client.id} access={client.role} linkTo={(d) => ({ to: '/portal/deliverables/$deliverableId', params: { deliverableId: d.id } })} />
    </>
  );
}
