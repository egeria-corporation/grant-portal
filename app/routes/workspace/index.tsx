/** Workspace home, "Today" (spec §5.1): what's due, what arrived, which clients need attention. */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { CalendarClock, FileUp, MessagesSquare, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { getJson } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { useMe } from '@/lib/session';
import { useOverview } from '@/setup/steps';
import { Card, Notice } from '@/ui/controls';
import { DeadlineChip, EmptyState, Pill } from '@/ui/display';
import { AddPasskeyButton } from '@/ui/PasskeyButton';
import { SecretsBanner } from '@/ui/SecretsBanner';

export const Route = createFileRoute('/workspace/')({ component: Today });

interface TodayData {
  deadlines: { kind: 'deliverable' | 'request' | 'opportunity'; id: string; title: string; dueAt: number; clientId: string; clientName: string }[];
  uploads: { id: string; filename: string; at: number; clientId: string; clientName: string; by: string }[];
  messages: { id: string; preview: string; at: number; clientId: string; clientName: string; by: string }[];
  awaitingClient: { id: string; title: string; at: number; clientId: string; clientName: string }[];
  awaitingYou: { id: string; title: string; at: number; clientId: string; clientName: string }[];
  needsAttention: { id: string; name: string; overdueRequests: number; awaitingClient: number; awaitingYou: number; overdueDeliverables: number; unread: number }[];
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

const KIND_LABEL = { deliverable: 'Deliverable', request: 'Documents', opportunity: 'Grant deadline' } as const;

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="card overflow-hidden" aria-label={title}>
      <h2 className="sech">
        {title}
        {count ? <span className="ct">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

function Today() {
  const me = useMe();
  const [now] = useState(() => Date.now());
  const today = useQuery({ queryKey: ['today'], queryFn: () => getJson<TodayData>('/api/today'), refetchInterval: 60_000 });
  const t = today.data;
  const isOwner = me.data?.user.role === 'owner';
  const nothing = t && !t.deadlines.length && !t.uploads.length && !t.messages.length && !t.awaitingYou.length && !t.needsAttention.length;

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="hd text-[26px] leading-8">Today</h1>
          <p className="mt-1 text-text2">{formatDate(now, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        </div>
        <Link to="/workspace/clients" search={{ new: true }} className="btn btn-secondary btn-sm">
          <UserPlus aria-hidden className="i" /> New client
        </Link>
      </div>
      {isOwner ? <OwnerNotices /> : null}
      {me.data && me.data.passkeyCount === 0 ? (
        <Card>
          <h2 className="hd text-[17px]">Sign in faster with a passkey</h2>
          <p className="mb-4 mt-1 text-text2">Use your device’s fingerprint, face or PIN instead of waiting for an email. Passkeys can’t be phished.</p>
          <AddPasskeyButton label="Staff passkey" />
        </Card>
      ) : null}

      {nothing ? (
        <EmptyState icon={CalendarClock} title="All clear" action={<Link to="/workspace/clients" className="btn btn-secondary btn-sm">Go to clients</Link>}>
          Nothing due this week, no new uploads or messages.
        </EmptyState>
      ) : null}

      {t?.needsAttention.length ? (
        <Section title="Clients needing attention" count={t.needsAttention.length}>
          <ul className="divide-y divide-border">
            {t.needsAttention.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <Link to="/workspace/clients/$clientId" params={{ clientId: c.id }} className="flex-1 font-medium text-text hover:text-acc-text underline underline-offset-2">
                  {c.name}
                </Link>
                {c.overdueRequests ? <Pill tone="danger">{c.overdueRequests} overdue request{c.overdueRequests > 1 ? 's' : ''}</Pill> : null}
                {c.overdueDeliverables ? <Pill tone="danger">{c.overdueDeliverables} overdue</Pill> : null}
                {c.awaitingYou ? <Pill tone="warn">{c.awaitingYou} to review</Pill> : null}
                {c.awaitingClient ? <Pill>{c.awaitingClient} with client</Pill> : null}
                {c.unread ? <Pill tone="info">{c.unread} unread</Pill> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2">
        {t?.deadlines.length ? (
          <Section title="Due this week" count={t.deadlines.length}>
            <ul className="divide-y divide-border">
              {t.deadlines.map((d) => (
                <li key={`${d.kind}-${d.id}`} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex min-w-0 flex-1 flex-col">
                    {d.kind === 'deliverable' ? (
                      <Link to="/workspace/clients/$clientId/deliverables/$deliverableId" params={{ clientId: d.clientId, deliverableId: d.id }} className="truncate font-medium text-text hover:underline">
                        {d.title}
                      </Link>
                    ) : (
                      <Link to="/workspace/clients/$clientId/documents" params={{ clientId: d.clientId }} className="truncate font-medium text-text hover:underline">
                        {d.title}
                      </Link>
                    )}
                    <span className="t-xs text-text2">
                      {KIND_LABEL[d.kind]} · {d.clientName}
                    </span>
                  </div>
                  <DeadlineChip dueAt={d.dueAt} windowDays={14} />
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {t?.awaitingYou.length ? (
          <Section title="Waiting for your review" count={t.awaitingYou.length}>
            <ul className="divide-y divide-border">
              {t.awaitingYou.map((d) => (
                <li key={d.id} className="flex flex-col px-4 py-3">
                  <Link to="/workspace/clients/$clientId/deliverables/$deliverableId" params={{ clientId: d.clientId, deliverableId: d.id }} className="font-medium text-text hover:underline">
                    {d.title}
                  </Link>
                  <span className="t-xs text-text2">
                    {d.clientName} · {timeAgo(d.at)}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {t?.uploads.length ? (
          <Section title="Uploads received" count={t.uploads.length}>
            <ul className="divide-y divide-border">
              {t.uploads.map((u) => (
                <li key={u.id} className="flex items-center gap-3 px-4 py-3">
                  <FileUp aria-hidden className="size-4 shrink-0 text-text3" />
                  <div className="flex min-w-0 flex-col">
                    <Link to="/workspace/clients/$clientId/documents" params={{ clientId: u.clientId }} className="truncate font-medium text-text hover:underline">
                      {u.filename}
                    </Link>
                    <span className="t-xs text-text2">
                      {u.by} · {u.clientName} · {timeAgo(u.at)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {t?.messages.length ? (
          <Section title="Unread messages" count={t.messages.length}>
            <ul className="divide-y divide-border">
              {t.messages.map((m) => (
                <li key={m.id} className="flex items-start gap-3 px-4 py-3">
                  <MessagesSquare aria-hidden className="mt-0.5 size-4 shrink-0 text-text3" />
                  <div className="flex min-w-0 flex-col">
                    <Link to="/workspace/clients/$clientId/messages" params={{ clientId: m.clientId }} className="line-clamp-2 text-text hover:underline">
                      {m.preview}
                    </Link>
                    <span className="t-xs text-text2">
                      {m.by} · {m.clientName} · {timeAgo(m.at)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </div>
    </>
  );
}
