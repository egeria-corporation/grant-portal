/** Client portal layout (mobile-first screens arrive in M3). */
import { createFileRoute, Navigate, Outlet } from '@tanstack/react-router';
import { useMe } from '@/lib/session';
import { AppShell } from '@/ui/AppShell';
import { Spinner } from '@/ui/controls';

export const Route = createFileRoute('/portal')({ component: Portal });

function Portal() {
  const me = useMe();
  if (me.isPending) return <Spinner />;
  const user = me.data?.user;
  if (!user) return <Navigate to="/signin" replace />;
  if (user.kind !== 'client') return <Navigate to="/workspace" replace />;
  return (
    <AppShell
      nav={[
        { to: '/portal', label: 'Home' },
        { to: '/portal/security', label: 'Security' },
      ]}
    >
      <Outlet />
    </AppShell>
  );
}
