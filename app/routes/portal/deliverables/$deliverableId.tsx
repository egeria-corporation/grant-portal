/** Deliverable review (spec §6.5): versions, approve or request changes, discussion. */
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { DeliverableView } from '@/client/Deliverables';
import { usePortalClient } from '@/client/portalClient';

export const Route = createFileRoute('/portal/deliverables/$deliverableId')({ component: Review });

function Review() {
  const { deliverableId } = Route.useParams();
  const { client } = usePortalClient();
  if (!client) return null;
  return (
    <DeliverableView
      clientId={client.id}
      deliverableId={deliverableId}
      access={client.role}
      backLink={
        <Link to="/portal/deliverables" className="t-sm inline-flex items-center gap-1 text-text2 hover:text-text">
          <ArrowLeft aria-hidden className="size-3.5" /> All deliverables
        </Link>
      }
    />
  );
}
