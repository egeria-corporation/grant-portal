/** Client users, invites, session revocation, and (Owner) consultant assignments. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { errorMessage, getJson, postJson, putJson } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useMe } from '@/lib/session';
import type { Member } from '@/lib/types';
import { Button, Checkbox, CopyField, Field, Input, Notice, Select } from '@/ui/controls';
import { Avatar, Pill } from '@/ui/display';
import { useStaffClient } from './route';

export const Route = createFileRoute('/workspace/clients/$clientId/people')({ component: People });

function Invite({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [asLink, setAsLink] = useState(false);
  const invite = useMutation({
    mutationFn: () => postJson<{ emailed: boolean; link?: string }>(`/api/clients/${clientId}/invites`, { email, role, delivery: asLink ? 'link' : 'email' }),
    onSuccess: async () => {
      setEmail('');
      await qc.invalidateQueries({ queryKey: ['members', clientId] });
    },
  });
  return (
    <form
      className="card flex flex-col gap-3 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        invite.mutate();
      }}
    >
      <h2 className="t-h4">Invite someone from this client</h2>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="Email">{(p) => <Input {...p} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Role">
          {(p) => (
            <Select {...p} value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')}>
              <option value="member">Member</option>
              <option value="admin">Admin (can invite colleagues)</option>
            </Select>
          )}
        </Field>
      </div>
      <Checkbox checked={asLink} onChange={setAsLink} label="Give me a link to send myself instead of emailing" />
      {invite.isError ? <Notice tone="danger">{errorMessage(invite.error)}</Notice> : null}
      {invite.data?.link ? <CopyField value={invite.data.link} label="Invite link" /> : null}
      {invite.data?.emailed ? <p role="status" className="t-sm text-ok-text">Invite sent.</p> : null}
      <div>
        <Button type="submit" loading={invite.isPending}>
          Invite
        </Button>
      </div>
    </form>
  );
}

function Assignments({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const client = useStaffClient(clientId);
  const team = useQuery({
    queryKey: ['team'],
    queryFn: () => getJson<{ members: { id: string; name: string | null; email: string; role: string }[] }>('/api/team'),
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const current = selected ?? new Set(client.data?.assignedStaff.map((s) => s.id) ?? []);
  const save = useMutation({
    mutationFn: () => putJson(`/api/clients/${clientId}/assignments`, { userIds: [...current] }),
    onSuccess: async () => {
      setSelected(null);
      await qc.invalidateQueries({ queryKey: ['client', clientId] });
    },
  });
  const consultants = (team.data?.members ?? []).filter((m) => m.role === 'consultant');
  return (
    <section className="card flex flex-col gap-3 p-5" aria-labelledby="assign-h">
      <h2 id="assign-h" className="t-h4">
        Consultants on this client
      </h2>
      {consultants.length ? (
        consultants.map((m) => (
          <Checkbox
            key={m.id}
            checked={current.has(m.id)}
            onChange={(v) => {
              const next = new Set(current);
              if (v) next.add(m.id);
              else next.delete(m.id);
              setSelected(next);
            }}
            label={m.name ?? m.email}
          />
        ))
      ) : (
        <p className="t-sm text-text2">No consultants on your team yet. You (the Owner) can always see every client.</p>
      )}
      {save.isError ? <Notice tone="danger">{errorMessage(save.error)}</Notice> : null}
      {consultants.length ? (
        <div>
          <Button size="sm" loading={save.isPending} disabled={!selected} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function People() {
  const { clientId } = Route.useParams();
  const me = useMe();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ['members', clientId], queryFn: () => getJson<{ members: Member[] }>(`/api/clients/${clientId}/members`) });
  const revoke = useMutation({
    mutationFn: (userId: string) => postJson<{ revoked: number }>(`/api/clients/${clientId}/members/${userId}/revoke-sessions`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['members', clientId] }),
  });
  return (
    <>
      <section className="card overflow-hidden" aria-labelledby="people-h">
        <h2 id="people-h" className="sech">
          Client users<span className="ct">{members.data?.members.length ?? 0}</span>
        </h2>
        <ul className="divide-y divide-border">
          {members.data?.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Avatar name={m.name ?? m.email} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{m.name ?? m.email}</span>
                <span className="t-xs text-text2">
                  {m.email} · joined {formatDate(m.joinedAt)}
                </span>
              </div>
              <Pill>{m.role === 'admin' ? 'Admin' : 'Member'}</Pill>
              <span className="t-xs text-text2">{m.activeSessions ?? 0} active session{m.activeSessions === 1 ? '' : 's'}</span>
              <Button variant="ghost" size="sm" disabled={!m.activeSessions} loading={revoke.isPending && revoke.variables === m.id} onClick={() => revoke.mutate(m.id)}>
                Sign out everywhere
              </Button>
            </li>
          ))}
          {members.data && !members.data.members.length ? <li className="t-sm px-4 py-3 text-text2">Nobody from this client has joined yet.</li> : null}
        </ul>
        {revoke.isError ? (
          <div className="p-3">
            <Notice tone="danger">{errorMessage(revoke.error)}</Notice>
          </div>
        ) : null}
      </section>
      <Invite clientId={clientId} />
      {me.data?.user.role === 'owner' ? <Assignments clientId={clientId} /> : null}
    </>
  );
}
