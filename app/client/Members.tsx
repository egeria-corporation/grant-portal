/**
 * Managing a client's users (DECISIONS D-080), shared by the workspace People
 * tab and the portal's Profile & team page: change someone's role, remove
 * them, and revoke pending invites. Staff, and client admins for their own
 * organization; nobody changes or removes themselves.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteJson, errorMessage, getJson, patchJson } from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { Member, PendingInvite } from '@/lib/types';
import { Button, Notice, Select } from '@/ui/controls';
import { Pill } from '@/ui/display';

type Action = { kind: 'role'; userId: string; role: Member['role'] } | { kind: 'remove'; userId: string } | { kind: 'revoke'; inviteId: string };

export function useMemberActions(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: Action) =>
      a.kind === 'role'
        ? patchJson(`/api/clients/${clientId}/members/${a.userId}`, { role: a.role })
        : a.kind === 'remove'
          ? deleteJson(`/api/clients/${clientId}/members/${a.userId}`)
          : deleteJson(`/api/clients/${clientId}/invites/${a.inviteId}`),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['members', clientId] }), qc.invalidateQueries({ queryKey: ['invites', clientId] })]),
  });
}

export type MemberActions = ReturnType<typeof useMemberActions>;

/** Role picker and Remove for one person; just their role for yourself. */
export function MemberControls({ member, self, act }: { member: Member; self: boolean; act: MemberActions }) {
  if (self) return <Pill>{member.role === 'admin' ? 'Admin' : 'Member'}</Pill>;
  return (
    <>
      <Select
        aria-label={`Role for ${member.email}`}
        className="w-auto"
        value={member.role}
        disabled={act.isPending}
        onChange={(e) => act.mutate({ kind: 'role', userId: member.id, role: e.target.value as Member['role'] })}
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
      </Select>
      <Button
        size="sm"
        variant="ghost"
        disabled={act.isPending}
        onClick={() => window.confirm(`Remove ${member.email}? They lose access to this organization right away and are signed out.`) && act.mutate({ kind: 'remove', userId: member.id })}
      >
        Remove
      </Button>
    </>
  );
}

export function MemberActionError({ act }: { act: MemberActions }) {
  return act.isError ? (
    <div className="p-3">
      <Notice tone="danger">{errorMessage(act.error)}</Notice>
    </div>
  ) : null;
}

/** Invites that haven't been accepted yet, each revocable. Renders nothing when there are none. */
export function PendingInvites({ clientId, act }: { clientId: string; act: MemberActions }) {
  const invites = useQuery({ queryKey: ['invites', clientId], queryFn: () => getJson<{ invites: PendingInvite[] }>(`/api/clients/${clientId}/invites`) });
  const rows = invites.data?.invites ?? [];
  if (!rows.length) return null;
  return (
    <section className="card overflow-hidden" aria-labelledby="pending-invites-h">
      <h2 id="pending-invites-h" className="sech">
        Pending invites<span className="ct">{rows.length}</span>
      </h2>
      <ul className="divide-y divide-border">
        {rows.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1 truncate">{i.email}</span>
            <Pill>{i.role === 'admin' ? 'Admin' : 'Member'}</Pill>
            <span className="t-xs text-text2">expires {formatDate(i.expiresAt)}</span>
            <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ kind: 'revoke', inviteId: i.id })}>
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
