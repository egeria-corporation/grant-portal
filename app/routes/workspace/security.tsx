/** Staff account: email preferences, calendar feed, sessions, passkeys. Owner settings live under Settings. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { deleteJson, errorMessage, getJson } from '@/lib/api';
import { Button, Card, Notice } from '@/ui/controls';
import { AddPasskeyButton, needsStepUp, StepUp } from '@/ui/PasskeyButton';
import { SessionsCard } from '@/ui/SessionsCard';
import { CalendarCard, NotificationsCard } from '@/client/Preferences';

export const Route = createFileRoute('/workspace/security')({ component: Security });

interface PasskeyRow {
  id: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

function PasskeysCard() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['passkeys'], queryFn: () => getJson<{ passkeys: PasskeyRow[] }>('/api/passkeys') });
  const remove = useMutation({
    mutationFn: (id: string) => deleteJson(`/api/passkeys/${id}`),
    onSuccess: () => qc.invalidateQueries(),
  });
  return (
    <Card>
      <h2 className="hd text-[17px]">Passkeys</h2>
      <ul className="mt-3 divide-y divide-border">
        {list.data?.passkeys.map((p) => (
          <li key={p.id} className="flex items-center gap-3 py-3">
            <KeyRound aria-hidden className="size-4 text-text3" />
            <div className="flex-1">
              <p className="text-[13.5px] font-medium">{p.label || 'Passkey'}</p>
              <p className="text-[12.5px] text-text3">
                Added {new Date(p.createdAt).toLocaleDateString()}
                {p.lastUsedAt ? ` · last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : ''}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => remove.mutate(p.id)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {remove.isError ? needsStepUp(remove.error) ? <StepUp onDone={() => remove.mutate(remove.variables)} /> : <Notice tone="danger">{errorMessage(remove.error)}</Notice> : null}
      <div className="mt-3">
        <AddPasskeyButton variant="secondary" label="Staff passkey" />
      </div>
    </Card>
  );
}

function Security() {
  const clients = useQuery({ queryKey: ['clients', false], queryFn: () => getJson<{ clients: { id: string; name: string }[] }>('/api/clients') });
  return (
    <>
      <h1 className="hd text-[26px] leading-8">Account & security</h1>
      <NotificationsCard />
      <CalendarCard clients={clients.data?.clients ?? []} allowAll />
      <SessionsCard />
      <PasskeysCard />
    </>
  );
}
