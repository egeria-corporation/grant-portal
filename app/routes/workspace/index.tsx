/** Workspace home. The Today feed and client screens arrive in M3; M1 shows setup-related notices and the client list. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Building2 } from 'lucide-react';
import { deleteJson, getJson } from '@/lib/api';
import { useMe } from '@/lib/session';
import { useOverview } from '@/setup/steps';
import { Button, Card, Notice } from '@/ui/controls';
import { AddPasskeyButton } from '@/ui/PasskeyButton';
import { SecretsBanner } from '@/ui/SecretsBanner';

export const Route = createFileRoute('/workspace/')({ component: WorkspaceHome });

interface ClientRow {
  id: string;
  name: string;
  status: string;
  isDemo: number;
}

function OwnerNotices() {
  const overview = useOverview();
  const o = overview.data;
  if (!o) return null;
  return (
    <>
      <SecretsBanner />
      {!o.email.verified ? (
        <Notice tone="warn" action={<Link to="/setup" className="text-[13px] font-medium underline">Verify domain</Link>}>
          Client invites and emails are paused until your sending domain is verified. You can still share single-use invite links.
        </Notice>
      ) : null}
      {!o.turnstile.configured ? (
        <Notice tone="info" action={<Link to="/workspace/security" className="text-[13px] font-medium underline">Add Turnstile</Link>}>
          Add Turnstile to protect the sign-in form from bots. Rate limits are on either way.
        </Notice>
      ) : null}
    </>
  );
}

function WorkspaceHome() {
  const me = useMe();
  const qc = useQueryClient();
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => getJson<{ clients: ClientRow[] }>('/api/clients') });
  const removeDemo = useMutation({
    mutationFn: () => deleteJson('/api/demo'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['clients'] }),
  });
  const isOwner = me.data?.user.role === 'owner';
  const hasDemo = clients.data?.clients.some((c) => c.isDemo);

  return (
    <>
      <div>
        <h1 className="hd text-[26px] leading-8">Welcome{me.data?.user.name ? `, ${me.data.user.name}` : ''}</h1>
        <p className="mt-1 text-text2">Signed in as {me.data?.user.email}</p>
      </div>
      {isOwner ? <OwnerNotices /> : null}
      {me.data && me.data.passkeyCount === 0 ? (
        <Card>
          <h2 className="hd text-[17px]">Sign in faster with a passkey</h2>
          <p className="mb-4 mt-1 text-text2">Use your device’s fingerprint, face or PIN instead of waiting for an email. Passkeys can’t be phished.</p>
          <AddPasskeyButton label="Staff passkey" />
        </Card>
      ) : null}
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="hd text-[17px]">Clients</h2>
          {isOwner && hasDemo ? (
            <Button variant="ghost" size="sm" loading={removeDemo.isPending} onClick={() => removeDemo.mutate()}>
              Delete demo client
            </Button>
          ) : null}
        </div>
        {clients.data?.clients.length ? (
          <ul className="mt-3 divide-y divide-border">
            {clients.data.clients.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-3">
                <Building2 aria-hidden className="size-4 text-text3" />
                <span className="font-medium">{c.name}</span>
                {c.isDemo ? <span className="rounded-pill bg-info-bg px-2 py-0.5 text-[11.5px] text-info-text">Demo</span> : null}
                <span className="ml-auto text-[12.5px] capitalize text-text3">{c.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-text2">No clients yet.</p>
        )}
      </Card>
    </>
  );
}
