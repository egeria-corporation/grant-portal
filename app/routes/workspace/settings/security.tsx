/**
 * Settings → Security (spec §5.9): who may sign in as staff and from where,
 * how long sessions and sign-in links last, and how long deleted files and
 * the email log are kept. Saving needs a step-up; the API refuses changes that
 * would lock the Owner out.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { deleteJson, errorMessage, putJson } from '@/lib/api';
import { useOverview, type SecurityPolicy } from '@/setup/steps';
import { Button, Card, Field, Input, Notice, Textarea, Toggle } from '@/ui/controls';
import { needsStepUp, StepUp } from '@/ui/PasskeyButton';

export const Route = createFileRoute('/workspace/settings/security')({ component: SecuritySettings });

const lines = (v: string) =>
  v
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

const ERRORS: Record<string, string> = {
  would_lock_you_out: 'That would lock you out: include your own email domain or your current IP address.',
  register_passkey_first: 'Add a passkey to your own account first (Account page).',
  invalid_input: 'Check the highlighted values: idle time can’t be longer than the maximum, and IP ranges look like 203.0.113.0/24.',
};

function Form({ initial, yourIp }: { initial: SecurityPolicy; yourIp: string }) {
  const qc = useQueryClient();
  const [p, setP] = useState(initial);
  const [domains, setDomains] = useState(initial.staffEmailDomains.join('\n'));
  const [ips, setIps] = useState(initial.staffIpAllowlist.join('\n'));
  const save = useMutation({
    mutationFn: () => putJson<{ security: SecurityPolicy }>('/api/settings/security', { ...p, staffEmailDomains: lines(domains), staffIpAllowlist: lines(ips) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'overview'] }),
  });
  const num = (key: 'staffIdleHours' | 'staffMaxDays' | 'clientIdleDays' | 'clientMaxDays' | 'linkMinutes', label: string, min: number, max: number, unit: string) => (
    <Field label={label} hint={`${min}–${max} ${unit}`}>
      {(f) => <Input {...f} type="number" inputMode="numeric" min={min} max={max} required value={p[key]} onChange={(e) => setP({ ...p, [key]: Number(e.target.value) })} />}
    </Field>
  );
  const code = save.error && 'code' in save.error ? String((save.error as { code: string }).code) : '';
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Card>
        <h2 className="hd text-[17px]">Staff sign-in</h2>
        <div className="mt-3 flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium">Require passkeys for staff</p>
              <p className="t-sm text-text2">Staff with a passkey must use it to sign in; staff without one add one before continuing.</p>
            </div>
            <Toggle checked={p.requirePasskeysForStaff} onChange={(v) => setP({ ...p, requirePasskeysForStaff: v })} label="Require passkeys for staff" />
          </div>
          <Field label="Allowed email domains" hint="One per line, e.g. yourfirm.com. Subdomains are included. Leave empty to allow any address.">
            {(f) => <Textarea {...f} rows={2} value={domains} onChange={(e) => setDomains(e.target.value)} />}
          </Field>
          <Field label="Allowed IP addresses" hint={`One address or range per line, e.g. 203.0.113.0/24. Leave empty to allow anywhere. You’re connecting from ${yourIp}.`}>
            {(f) => <Textarea {...f} rows={2} value={ips} onChange={(e) => setIps(e.target.value)} />}
          </Field>
          {!ips.trim() ? (
            <div>
              <Button size="sm" variant="ghost" onClick={() => setIps(yourIp)}>
                Use my current address
              </Button>
            </div>
          ) : null}
          <p className="t-xs text-text2">These apply to staff only. Client users can always sign in with their email.</p>
        </div>
      </Card>
      <Card>
        <h2 className="hd text-[17px]">Sessions and sign-in links</h2>
        <p className="mt-1 text-text2">New lengths apply from each person’s next sign-in.</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {num('staffIdleHours', 'Staff: sign out after inactivity', 1, 24, 'hours')}
          {num('staffMaxDays', 'Staff: sign in again at least every', 1, 30, 'days')}
          {num('clientIdleDays', 'Clients: sign out after inactivity', 1, 30, 'days')}
          {num('clientMaxDays', 'Clients: sign in again at least every', 1, 90, 'days')}
          {num('linkMinutes', 'Sign-in links and codes expire after', 5, 60, 'minutes')}
        </div>
      </Card>
      <Card>
        <h2 className="hd text-[17px]">Data retention</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Deleted documents are erased after" hint="1–365 days. Until then an Owner can still find them in the data export.">
            {(f) => (
              <Input
                {...f}
                type="number"
                min={1}
                max={365}
                required
                value={p.retention.deletedFilesDays}
                onChange={(e) => setP({ ...p, retention: { ...p.retention, deletedFilesDays: Number(e.target.value) } })}
              />
            )}
          </Field>
          <Field label="Keep the sent-email log for" hint="30–3650 days.">
            {(f) => (
              <Input
                {...f}
                type="number"
                min={30}
                max={3650}
                required
                value={p.retention.emailLogDays}
                onChange={(e) => setP({ ...p, retention: { ...p.retention, emailLogDays: Number(e.target.value) } })}
              />
            )}
          </Field>
        </div>
        <p className="t-xs mt-3 text-text2">The audit log is never deleted. Export it from the Audit log tab.</p>
      </Card>
      {save.isError ? needsStepUp(save.error) ? <StepUp onDone={() => save.mutate()} /> : <Notice tone="danger">{ERRORS[code] ?? errorMessage(save.error)}</Notice> : null}
      {save.isSuccess ? <Notice tone="ok">Saved.</Notice> : null}
      <div>
        <Button type="submit" loading={save.isPending}>
          Save security settings
        </Button>
      </div>
    </form>
  );
}

/** Turnstile and the saved Cloudflare token (moved from the account page in M6). */
function BotProtection() {
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
  const o = overview.data;

  return (
    <>
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

function SecuritySettings() {
  const overview = useOverview();
  return (
    <>
      <div>
        <h1 className="hd t-h1">Security</h1>
        <p className="mt-1 text-text2">Who can sign in as your team, from where, and for how long.</p>
      </div>
      {overview.data ? <Form initial={overview.data.security} yourIp={overview.data.yourIp} /> : <p className="text-text2">Loading…</p>}
      <BotProtection />
    </>
  );
}
