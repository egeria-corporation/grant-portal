/** Portal profile & team (spec §6.7): org details, colleagues, and invites for admins. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { usePortalClient } from '@/client/portalClient';
import { errorMessage, getJson, patchJson, postJson } from '@/lib/api';
import type { ClientProfile, Member } from '@/lib/types';
import { Button, Field, Input, Notice, Select, Textarea } from '@/ui/controls';
import { Avatar, Pill } from '@/ui/display';

export const Route = createFileRoute('/portal/profile')({ component: Profile });

const csv = (xs: string[]) => xs.join(', ');
const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function OrgDetails({ client }: { client: ClientProfile }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    legalName: client.legalName ?? '',
    mission: client.mission ?? '',
    programs: csv(client.programs),
    populations: csv(client.populations),
    geography: csv(client.geography),
    budgetBand: client.budgetBand ?? '',
  });
  const save = useMutation({
    mutationFn: () =>
      patchJson(`/api/clients/${client.id}`, {
        legalName: f.legalName || null,
        mission: f.mission || null,
        programs: list(f.programs),
        populations: list(f.populations),
        geography: list(f.geography),
        budgetBand: f.budgetBand || null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal', 'client', client.id] }),
  });
  const ro = !client.canEdit;
  const input = (k: keyof typeof f, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      {(p) => <Input {...p} readOnly={ro} value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} />}
    </Field>
  );
  return (
    <form
      className="card flex flex-col gap-3 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="t-h4">Organization</h2>
      {ro ? <p className="t-sm text-text2">Your consultant keeps these details up to date. Send them a message if something has changed.</p> : null}
      {input('legalName', 'Legal name')}
      <Field label="Mission">{(p) => <Textarea {...p} readOnly={ro} rows={3} value={f.mission} onChange={(e) => setF((x) => ({ ...x, mission: e.target.value }))} />}</Field>
      {input('programs', 'Programs', ro ? undefined : 'Separate with commas')}
      {input('populations', 'Populations served', ro ? undefined : 'Separate with commas')}
      {input('geography', 'Geography served', ro ? undefined : 'Separate with commas')}
      {input('budgetBand', 'Annual budget')}
      {save.isError ? <Notice tone="danger">{errorMessage(save.error)}</Notice> : save.isSuccess ? <p role="status" className="t-sm text-ok-text">Saved.</p> : null}
      {ro ? null : (
        <div>
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        </div>
      )}
    </form>
  );
}

function Team({ clientId, isAdmin }: { clientId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ['members', clientId], queryFn: () => getJson<{ members: Member[] }>(`/api/clients/${clientId}/members`) });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const invite = useMutation({
    mutationFn: () => postJson(`/api/clients/${clientId}/invites`, { email, role, delivery: 'email' }),
    onSuccess: async () => {
      setEmail('');
      await qc.invalidateQueries({ queryKey: ['members', clientId] });
    },
  });
  return (
    <section className="card overflow-hidden" aria-labelledby="team-h">
      <h2 id="team-h" className="sech">
        Your team<span className="ct">{members.data?.members.length ?? 0}</span>
      </h2>
      <ul className="divide-y divide-border">
        {members.data?.members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-4 py-3">
            <Avatar name={m.name ?? m.email} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{m.name ?? m.email}</span>
              <span className="t-xs truncate text-text2">{m.email}</span>
            </span>
            <Pill>{m.role === 'admin' ? 'Admin' : 'Member'}</Pill>
          </li>
        ))}
      </ul>
      {isAdmin ? (
        <form
          className="flex flex-col gap-3 border-t border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate();
          }}
        >
          <h3 className="t-h4">Invite a colleague</h3>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Field label="Email">{(p) => <Input {...p} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            <Field label="Role">
              {(p) => (
                <Select {...p} value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </Select>
              )}
            </Field>
          </div>
          {invite.isError ? <Notice tone="danger">{errorMessage(invite.error)}</Notice> : invite.isSuccess ? <p role="status" className="t-sm text-ok-text">Invite sent.</p> : null}
          <div>
            <Button type="submit" loading={invite.isPending}>
              Send invite
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function Profile() {
  const { client } = usePortalClient();
  const profile = useQuery({
    queryKey: ['portal', 'client', client?.id],
    queryFn: () => getJson<{ client: ClientProfile }>(`/api/clients/${client?.id}`),
    enabled: Boolean(client),
  });
  if (!client) return null;
  return (
    <>
      <h1 className="hd text-[26px] leading-8">Profile & team</h1>
      {profile.data ? <OrgDetails key={profile.dataUpdatedAt} client={profile.data.client} /> : null}
      <Team clientId={client.id} isAdmin={client.role === 'admin'} />
    </>
  );
}
