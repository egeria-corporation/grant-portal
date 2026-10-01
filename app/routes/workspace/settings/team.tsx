/**
 * Settings → Team (spec §5.9 "Team and roles"): staff, their role, whether a
 * consultant sees every client, passkey reset for a lost device, removal, and
 * consultant invites. Changes and invites need a step-up.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError, deleteJson, errorMessage, getJson, patchJson, postJson } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { useMe } from '@/lib/session';
import { Button, Card, CopyField, Field, Input, Notice, Select, Toggle } from '@/ui/controls';
import { Avatar, Pill } from '@/ui/display';
import { needsStepUp, StepUp } from '@/ui/PasskeyButton';

export const Route = createFileRoute('/workspace/settings/team')({ component: Team });

interface Member {
  id: string;
  email: string;
  name: string | null;
  role: 'owner' | 'consultant';
  allClients: boolean;
  createdAt: number;
  passkeys: number;
  clients: number;
  lastSeenAt: number | null;
}

interface Invite {
  id: string;
  email: string;
  expiresAt: number;
}

const ERRORS: Record<string, string> = {
  last_owner: 'There must always be at least one Owner. Make someone else an Owner first.',
  cannot_remove_self: 'You can’t remove yourself.',
  domain_not_allowed: 'That address isn’t in the allowed staff email domains (Settings → Security).',
  email_domain_unverified: 'Email isn’t set up yet, so use “Give me a link” instead.',
  invite_conflict: 'That address already belongs to someone else in the portal.',
  already_member: 'They’re already on the team.',
};
const message = (err: unknown): string => (err instanceof ApiError ? ERRORS[err.code] : undefined) ?? errorMessage(err);

function InviteForm() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [link, setLink] = useState(false);
  const invite = useMutation({
    mutationFn: () => postJson<{ emailed: boolean; link?: string }>('/api/team/invites', { email, delivery: link ? 'link' : 'email' }),
    onSuccess: async () => {
      setEmail('');
      await qc.invalidateQueries({ queryKey: ['team'] });
    },
  });
  return (
    <Card>
      <h2 className="hd text-[17px]">Invite a consultant</h2>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate();
        }}
      >
        <Field label="Email">{(p) => <Input {...p} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <label className="t-sm flex items-center gap-2">
          <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} /> Give me a link to send myself instead of emailing
        </label>
        {invite.isError ? needsStepUp(invite.error) ? <StepUp onDone={() => invite.mutate()} /> : <Notice tone="danger">{message(invite.error)}</Notice> : null}
        {invite.data?.link ? <CopyField label="Invite link" value={invite.data.link} /> : invite.data?.emailed ? <Notice tone="ok">Invite sent.</Notice> : null}
        <div>
          <Button type="submit" loading={invite.isPending}>
            Invite
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Team() {
  const me = useMe();
  const qc = useQueryClient();
  const team = useQuery({ queryKey: ['team'], queryFn: () => getJson<{ members: Member[]; invites: Invite[] }>('/api/team') });
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const act = useMutation({
    mutationFn: (p: { method: 'PATCH' | 'DELETE'; path: string; body?: unknown }) => (p.method === 'PATCH' ? patchJson(p.path, p.body) : deleteJson(p.path)),
    onSuccess: () => {
      setRetry(null);
      return qc.invalidateQueries({ queryKey: ['team'] });
    },
  });
  const run = (p: { method: 'PATCH' | 'DELETE'; path: string; body?: unknown }) => {
    setRetry(() => () => act.mutate(p));
    act.mutate(p);
  };
  const members = team.data?.members ?? [];
  return (
    <>
      <div>
        <h1 className="hd t-h1">Team</h1>
        <p className="mt-1 text-text2">Owners manage settings and see every client. Consultants see the clients they’re assigned to, or all of them if you allow it.</p>
      </div>
      {act.isError ? needsStepUp(act.error) && retry ? <StepUp onDone={retry} /> : <Notice tone="danger">{message(act.error)}</Notice> : null}
      <section className="card overflow-hidden" aria-label="Team">
        <ul className="divide-y divide-border" aria-label="Team members">
          {members.map((m) => {
            const self = m.id === me.data?.user.id;
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Avatar name={m.name ?? m.email} tone="consultant" />
                <div className="flex min-w-[180px] flex-1 flex-col">
                  <span className="font-medium">
                    {m.name ?? m.email} {self ? <span className="t-xs text-text2">(you)</span> : null}
                  </span>
                  <span className="t-xs text-text2">
                    {m.email} · {m.passkeys} passkey{m.passkeys === 1 ? '' : 's'} · {m.lastSeenAt ? `active ${timeAgo(m.lastSeenAt)}` : 'not signed in yet'}
                    {m.role === 'consultant' && !m.allClients ? ` · ${m.clients} client${m.clients === 1 ? '' : 's'}` : ''}
                  </span>
                </div>
                <Select aria-label={`Role for ${m.email}`} className="w-auto" value={m.role} onChange={(e) => run({ method: 'PATCH', path: `/api/team/${m.id}`, body: { role: e.target.value } })}>
                  <option value="owner">Owner</option>
                  <option value="consultant">Consultant</option>
                </Select>
                {m.role === 'consultant' ? (
                  <span className="t-sm flex items-center gap-2">
                    All clients
                    <Toggle label={`${m.email} sees all clients`} checked={m.allClients} onChange={(v) => run({ method: 'PATCH', path: `/api/team/${m.id}`, body: { allClients: v } })} />
                  </span>
                ) : (
                  <Pill>All clients</Pill>
                )}
                {m.passkeys ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => window.confirm(`Remove all of ${m.email}’s passkeys? They’ll sign in by email and can add a new one.`) && run({ method: 'DELETE', path: `/api/team/${m.id}/passkeys` })}
                  >
                    Reset passkeys
                  </Button>
                ) : null}
                {!self ? (
                  <Button size="sm" variant="ghost" onClick={() => window.confirm(`Remove ${m.email} from the team? They’re signed out everywhere. Their past work stays.`) && run({ method: 'DELETE', path: `/api/team/${m.id}` })}>
                    Remove
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
      {team.data?.invites.length ? (
        <Card>
          <h2 className="hd text-[17px]">Pending invites</h2>
          <ul className="mt-2 divide-y divide-border">
            {team.data.invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2">
                <span className="flex-1">{i.email}</span>
                <span className="t-xs text-text2">expires {formatDate(i.expiresAt)}</span>
                <Button size="sm" variant="ghost" onClick={() => run({ method: 'DELETE', path: `/api/team/invites/${i.id}` })}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <InviteForm />
    </>
  );
}
