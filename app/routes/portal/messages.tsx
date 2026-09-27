import { createFileRoute } from '@tanstack/react-router';
import { usePortalClient } from '@/client/portalClient';
import { Thread } from '@/client/Thread';
import { useConfig } from '@/lib/session';

export const Route = createFileRoute('/portal/messages')({ component: Messages });

function Messages() {
  const { client } = usePortalClient();
  const config = useConfig();
  if (!client) return null;
  const firm = config.data?.shortName || config.data?.firmName || 'your consultant';
  return (
    <>
      <h1 className="hd text-[26px] leading-8">Messages</h1>
      <Thread clientId={client.id} placeholder={`Write to ${firm}`} />
    </>
  );
}
