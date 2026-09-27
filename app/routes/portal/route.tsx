/** Client portal layout (spec §6): mobile-first, one client org at a time. */
import { createFileRoute, Navigate, Outlet } from '@tanstack/react-router';
import { usePortalClient } from '@/client/portalClient';
import { useMe } from '@/lib/session';
import { AppShell } from '@/ui/AppShell';
import { Select, Spinner } from '@/ui/controls';

export const Route = createFileRoute('/portal')({ component: Portal });

function Portal() {
  const me = useMe();
  const { clients, client, select } = usePortalClient();
  if (me.isPending) return <Spinner />;
  const user = me.data?.user;
  if (!user) return <Navigate to="/signin" replace />;
  if (user.kind !== 'client') return <Navigate to="/workspace" replace />;
  return (
    <AppShell
      nav={[
        { to: '/portal', label: 'Home', exact: true },
        { to: '/portal/documents', label: 'Documents' },
        { to: '/portal/deliverables', label: 'Deliverables' },
        { to: '/portal/messages', label: 'Messages' },
        { to: '/portal/profile', label: 'Profile' },
        { to: '/portal/security', label: 'Security' },
      ]}
      aside={
        clients.length > 1 ? (
          <Select aria-label="Organization" value={client?.id ?? ''} onChange={(e) => select(e.target.value)} className="w-auto max-w-[160px]">
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        ) : null
      }
    >
      <Outlet />
    </AppShell>
  );
}
