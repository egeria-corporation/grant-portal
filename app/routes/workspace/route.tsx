/** Consultant workspace layout. The API enforces access; this only routes people to the right place. */
import { createFileRoute, Navigate, Outlet } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { useMe } from '@/lib/session';
import { AppShell } from '@/ui/AppShell';
import { AuthShell } from '@/ui/AuthShell';
import { Spinner } from '@/ui/controls';
import { AddPasskeyButton } from '@/ui/PasskeyButton';

export const Route = createFileRoute('/workspace')({ component: Workspace });

function Workspace() {
  const me = useMe();
  if (me.isPending) return <Spinner />;
  const user = me.data?.user;
  if (!user) return <Navigate to="/signin" replace />;
  if (user.kind !== 'staff') return <Navigate to="/portal" replace />;

  if (me.data?.needsPasskey) {
    return (
      <AuthShell>
        <KeyRound aria-hidden className="size-7 text-acc-text" />
        <h1 className="hd mt-2 text-[22px] leading-7">Add a passkey to continue</h1>
        <p className="mb-5 mt-1.5 text-text2">
          Your firm requires staff to sign in with a passkey: your device’s fingerprint, face or PIN. It takes a few seconds.
        </p>
        <AddPasskeyButton label="Staff passkey" />
      </AuthShell>
    );
  }

  const nav = [
    { to: '/workspace', label: 'Home' },
    { to: '/workspace/security', label: 'Security' },
  ];
  return (
    <AppShell nav={nav}>
      <Outlet />
    </AppShell>
  );
}
