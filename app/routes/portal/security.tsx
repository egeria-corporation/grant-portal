import { createFileRoute } from '@tanstack/react-router';
import { SessionsCard } from '@/ui/SessionsCard';

export const Route = createFileRoute('/portal/security')({ component: PortalSecurity });

function PortalSecurity() {
  return (
    <>
      <h1 className="hd text-[26px] leading-8">Security</h1>
      <SessionsCard />
    </>
  );
}
