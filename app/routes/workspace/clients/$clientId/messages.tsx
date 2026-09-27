import { createFileRoute } from '@tanstack/react-router';
import { Thread } from '@/client/Thread';

export const Route = createFileRoute('/workspace/clients/$clientId/messages')({ component: Messages });

function Messages() {
  const { clientId } = Route.useParams();
  return <Thread clientId={clientId} placeholder="Write to the client" />;
}
