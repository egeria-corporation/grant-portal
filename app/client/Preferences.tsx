/**
 * Email preferences, time zone (spec §6.7, §9) and calendar feeds (spec §5.7),
 * shared by the workspace Security page and the portal Profile page.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { deleteJson, errorMessage, getJson, postJson, putJson } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useMe } from '@/lib/session';
import { Button, Checkbox, CopyField, Field, Notice, Select } from '@/ui/controls';
import { needsStepUp, StepUp } from '@/ui/PasskeyButton';

const ZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
})();

/** Fills in the browser's time zone the first time someone signs in. */
export function useAutoTimezone() {
  const me = useMe();
  const qc = useQueryClient();
  const tz = me.data?.timezone;
  const loaded = Boolean(me.data);
  useEffect(() => {
    if (!loaded || tz) return;
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (local) void putJson('/api/me/preferences', { timezone: local }).then(() => qc.invalidateQueries({ queryKey: ['me'] }));
  }, [loaded, tz, qc]);
}

export function NotificationsCard() {
  const me = useMe();
  const qc = useQueryClient();
  const current = me.data?.preferences;
  const [activity, setActivity] = useState<string | null>(null);
  const [reminders, setReminders] = useState<boolean | null>(null);
  const [updates, setUpdates] = useState<boolean | null>(null);
  const [tz, setTz] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (extra: Record<string, unknown> = {}) =>
      putJson('/api/me/preferences', {
        timezone: tz ?? me.data?.timezone ?? undefined,
        preferences: { activity: activity ?? current?.activity, reminders: reminders ?? current?.reminders, updates: updates ?? current?.updates },
        ...extra,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  if (!me.data || !current) return null;
  const staff = me.data.user.kind === 'staff';
  return (
    <section id="notifications" className="card flex flex-col gap-4 p-6" aria-labelledby="notif-h">
      <h2 id="notif-h" className="hd text-[17px]">
        Email notifications
      </h2>
      {me.data.emailSuppressed ? (
        <Notice tone="warn" action={<Button size="sm" variant="secondary" onClick={() => save.mutate({ clearSuppression: true })}>Turn email back on</Button>}>
          Email to {me.data.user.email} bounced or was marked as spam, so we stopped sending updates. Sign-in emails still go out.
        </Notice>
      ) : null}
      <Field label={staff ? 'New versions, decisions and messages from clients' : 'New drafts, decisions and messages'}>
        {(p) => (
          <Select {...p} value={activity ?? current.activity} onChange={(e) => setActivity(e.target.value)}>
            <option value="instant">Right away</option>
            <option value="daily">Daily summary</option>
            <option value="weekly">Weekly summary (Mondays)</option>
            <option value="off">Don’t email me</option>
          </Select>
        )}
      </Field>
      <Checkbox checked={reminders ?? current.reminders} onChange={setReminders} label="Reminders about due documents, reviews and deadlines" />
      {staff ? null : <Checkbox checked={updates ?? current.updates} onChange={setUpdates} label="Updates from your consultant" />}
      <p className="t-sm text-text2">{staff ? 'Sign-in emails are always sent.' : 'Sign-in emails and document requests are always sent.'}</p>
      <Field label="Time zone" hint="Summaries arrive at 8am, and dates in email use this zone.">
        {(p) => (
          <Select {...p} value={tz ?? me.data?.timezone ?? 'UTC'} onChange={(e) => setTz(e.target.value)}>
            {ZONES.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {save.isError ? <Notice tone="danger">{errorMessage(save.error)}</Notice> : save.isSuccess ? <p role="status" className="t-sm text-ok-text">Saved.</p> : null}
      <div>
        <Button loading={save.isPending} onClick={() => save.mutate({})}>
          Save
        </Button>
      </div>
    </section>
  );
}

interface Feed {
  id: string;
  clientId: string | null;
  clientName: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

/** `clients`: the scopes the person may choose (staff: "all" plus each client; client users: their org). */
export function CalendarCard({ clients, allowAll }: { clients: { id: string; name: string }[]; allowAll: boolean }) {
  const qc = useQueryClient();
  const feeds = useQuery({ queryKey: ['calendar-feeds'], queryFn: () => getJson<{ feeds: Feed[] }>('/api/calendar-feeds') });
  const [scope, setScope] = useState<string>(allowAll ? '' : (clients[0]?.id ?? ''));
  const [url, setUrl] = useState<string | null>(null);
  const [ipRestricted, setIpRestricted] = useState(false);
  // Staff links need a recent step-up; with a staff IP allowlist they only load from those networks (D-079).
  const create = useMutation({
    mutationFn: () => postJson<{ url: string; ipRestricted?: boolean }>('/api/calendar-feeds', { clientId: scope || null }),
    onSuccess: async (r) => {
      setUrl(r.url);
      setIpRestricted(Boolean(r.ipRestricted));
      await qc.invalidateQueries({ queryKey: ['calendar-feeds'] });
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => deleteJson(`/api/calendar-feeds/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['calendar-feeds'] }) });
  const options = useMemo(() => [...(allowAll ? [{ id: '', name: 'All my clients' }] : []), ...clients], [allowAll, clients]);
  return (
    <section className="card flex flex-col gap-4 p-6" aria-labelledby="cal-h">
      <h2 id="cal-h" className="hd flex items-center gap-2 text-[17px]">
        <CalendarDays aria-hidden className="size-4 text-text3" /> Calendar feed
      </h2>
      <p className="t-sm text-text2">
        Subscribe in Google Calendar, Outlook or Apple Calendar to see due dates and deadlines. The link is private: anyone who has it can read the calendar, so revoke it if it leaks.
      </p>
      {options.length > 1 ? (
        <Field label="Include">
          {(p) => (
            <Select {...p} value={scope} onChange={(e) => setScope(e.target.value)}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      {url ? (
        <div className="flex flex-col gap-2">
          <CopyField value={url} label="Calendar URL" />
          <p className="t-xs text-text2">Copy it now: it won’t be shown again.</p>
          {ipRestricted ? (
            <p className="t-xs text-text2">
              Your firm only allows staff access from its own networks, so this calendar only loads there. Google Calendar and Outlook.com load calendars from their own servers and can’t use it; subscribe from a calendar app on a device on your firm’s network.
            </p>
          ) : null}
        </div>
      ) : null}
      {create.isError ? needsStepUp(create.error) ? <StepUp onDone={() => create.mutate()} /> : <Notice tone="danger">{errorMessage(create.error)}</Notice> : null}
      <div>
        <Button variant="secondary" loading={create.isPending} onClick={() => create.mutate()} disabled={!options.length}>
          Create a calendar link
        </Button>
      </div>
      {feeds.data?.feeds.length ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {feeds.data.feeds.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="t-sm font-medium">{f.clientName ?? 'All my clients'}</span>
                <span className="t-xs block text-text2">
                  Created {formatDate(f.createdAt)}
                  {f.lastUsedAt ? ` · last synced ${formatDate(f.lastUsedAt)}` : ' · not used yet'}
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => revoke.mutate(f.id)} loading={revoke.isPending && revoke.variables === f.id} aria-label="Revoke calendar link">
                <Trash2 aria-hidden className="i" /> Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
