import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useConfig, useMe } from '@/lib/session';
import { Spinner } from '@/ui/controls';

export const Route = createFileRoute('/')({ component: Home });

/** Sends each visitor where they belong: wizard, sign-in, workspace, or portal. */
function Home() {
  const config = useConfig();
  const me = useMe();
  if (config.isPending || me.isPending) return <Spinner />;
  if (config.data?.setupStatus === 'unclaimed') return <Navigate to="/setup" replace />;
  const user = me.data?.user;
  if (!user) return <Navigate to="/signin" replace />;
  if (user.kind === 'client') return <Navigate to="/portal" replace />;
  if (user.role === 'owner' && me.data?.setupStatus !== 'complete') return <Navigate to="/setup" replace />;
  return <Navigate to="/workspace" replace />;
}
