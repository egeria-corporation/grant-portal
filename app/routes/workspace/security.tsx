/** Staff security: sessions, passkeys, and (Owner) Turnstile + passkey policy. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { deleteJson, errorMessage, getJson, putJson } from '@/lib/api';
import { useMe } from '@/lib/session';
import { useOverview } from '@/setup/steps';
import { Button, Card, Field, Input, Notice } from '@/ui/controls';
import { AddPasskeyButton } from '@/ui/PasskeyButton';
import { SessionsCard } from '@/ui/SessionsCard';

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
      {remove.isError ? <Notice tone="danger">{errorMessage(remove.error)}</Notice> : null}
      <div className="mt-3">
        <AddPasskeyButton variant="secondary" label="Staff passkey" />
      </div>
    </Card>
  );
}

function OwnerSecurity() {
  const qc = useQueryClient();
  const overview = useOverview();
  const [siteKey, setSiteKey] = useState('');
  const [secret, setSecret] = useState('');
  const saveTs = useMutation({
    mutationFn: () => putJson('/api/settings/turnstile', { siteKey, secret }),
    onSuccess: () => {
      setSecret('');
      void qc.invalidateQueries();
    },
  });
  const removeToken = useMutation({
    mutationFn: () => deleteJson('/api/settings/cloudflare-token'),
    onSuccess: () => qc.invalidateQueries(),
  });
  const policy = useMutation({
    mutationFn: (value: boolean) => putJson('/api/settings/security', { requirePasskeysForStaff: value }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const o = overview.data;

  return (
    <>
      <Card>
        <h2 className="hd text-[17px]">Require passkeys for staff</h2>
        <p className="mt-1 text-text2">When on, staff with a passkey must use it to sign in, and staff without one must add one before continuing.</p>
        {policy.isError ? <Notice tone="danger">{errorMessage(policy.error)}</Notice> : null}
        <Button
          className="mt-3"
          variant={o?.security.requirePasskeysForStaff ? 'secondary' : 'primary'}
          loading={policy.isPending}
          onClick={() => policy.mutate(!o?.security.requirePasskeysForStaff)}
        >
          {o?.security.requirePasskeysForStaff ? 'Turn off' : 'Turn on'}
        </Button>
      </Card>
      <Card>
        <h2 className="hd text-[17px]">Turnstile bot protection</h2>
        <p className="mt-1 text-text2">
          {o?.turnstile.configured
            ? `On${o.turnstile.source === 'env' ? ' (configured as a Worker secret)' : ''}.`
            : 'Create a free widget in the Cloudflare dashboard (Turnstile → Add widget, mode “Invisible”) and paste its keys.'}
        </p>
        {o?.turnstile.source !== 'env' ? (
          <form
            className="mt-3 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              saveTs.mutate();
            }}
          >
            <Field label="Site key">{(p) => <Input {...p} required value={siteKey} onChange={(e) => setSiteKey(e.target.value)} />}</Field>
            <Field label="Secret key">
              {(p) => <Input {...p} required type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />}
            </Field>
            {saveTs.isError ? <Notice tone="danger">{errorMessage(saveTs.error)}</Notice> : null}
            {saveTs.isSuccess ? <Notice tone="ok">Saved. The sign-in form now uses Turnstile.</Notice> : null}
            <Button type="submit" variant="secondary" loading={saveTs.isPending}>
              Save keys
            </Button>
          </form>
        ) : null}
      </Card>
      {o?.cloudflareToken ? (
        <Card>
          <h2 className="hd text-[17px]">Cloudflare API token</h2>
          <p className="mt-1 text-text2">Saved (encrypted) for DNS records and the custom domain. Remove it once setup is done.</p>
          {removeToken.isError ? <Notice tone="danger">{errorMessage(removeToken.error)}</Notice> : null}
          <Button className="mt-3" variant="danger" loading={removeToken.isPending} onClick={() => removeToken.mutate()}>
            Remove token
          </Button>
        </Card>
      ) : null}
    </>
  );
}

function Security() {
  const me = useMe();
  return (
    <>
      <h1 className="hd text-[26px] leading-8">Security</h1>
      <SessionsCard />
      <PasskeysCard />
      {me.data?.user.role === 'owner' ? <OwnerSecurity /> : null}
    </>
  );
}
