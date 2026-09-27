/** Wizard steps 2–7 (spec §3.3). Each ends by calling onNext('done' | 'skipped'). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Cloud, Copy, ExternalLink, Sparkles, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { deleteJson, errorMessage, getJson, postJson, putJson } from '@/lib/api';
import { BrandEditor } from '@/settings/BrandEditor';
import { Button, CopyField, Field, Input, Notice } from '@/ui/controls';

export type StepResult = 'done' | 'skipped';
export interface StepProps {
  onNext: (state: StepResult) => void;
}

export interface Overview {
  brand: { firmName: string; shortName?: string; accent: string; welcome?: string };
  email: { status: 'none' | 'pending' | 'verified' | 'failed'; domain: string | null; from: string; verified: boolean };
  domain: { hostname: string; status: 'pending' | 'active' | 'manual' } | null;
  opengrants: { configured: boolean; source: 'env' | 'settings' | null };
  cloudflareToken: boolean;
  turnstile: { configured: boolean; source: string | null; siteKey: string | null };
  security: { requirePasskeysForStaff: boolean };
  workerName: string | null;
}

export function useOverview() {
  return useQuery({ queryKey: ['settings', 'overview'], queryFn: () => getJson<Overview>('/api/settings/overview') });
}

export function StepHeader({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <div>
      <p className="text-[12.5px] font-medium uppercase tracking-wide text-text3">Step {n} of 8</p>
      <h1 className="hd mt-1 text-[24px] leading-8">{title}</h1>
      {children ? <p className="mt-1.5 text-text2">{children}</p> : null}
    </div>
  );
}

function StepActions({ children, onSkip }: { children?: ReactNode; onSkip?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      {onSkip ? (
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
      ) : (
        <span />
      )}
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: brand (the full editor lives in Settings → Brand)
// ---------------------------------------------------------------------------
export function BrandStep({ onNext }: StepProps) {
  return (
    <div className="flex flex-col gap-5">
      <StepHeader n={2} title="Your brand">
        This is what your clients see. Fonts, favicon and link previews can be fine-tuned later in Settings → Brand.
      </StepHeader>
      <BrandEditor compact submitLabel="Save and continue" onSaved={() => onNext('done')} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: email sender
// ---------------------------------------------------------------------------
interface EmailSettings {
  email: {
    fromName?: string;
    fromLocal?: string;
    domain?: string;
    status: 'none' | 'pending' | 'verified' | 'failed';
    records: { type: string; name: string; value: string; priority?: number; status?: string }[];
  };
}

function CloudflareTokenForm({ onSaved }: { onSaved: () => void }) {
  const [token, setToken] = useState('');
  const save = useMutation({ mutationFn: () => putJson('/api/settings/cloudflare-token', { token }), onSuccess: onSaved });
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field
        label="Cloudflare API token (optional)"
        hint={
          <>
            Lets the portal create DNS records and attach your domain. Create one in{' '}
            <a className="text-acc-text underline" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">
              your Cloudflare profile
            </a>{' '}
            with “Zone · DNS · Edit” and “Account · Workers Scripts · Edit”. Stored encrypted; remove it any time.
          </>
        }
        error={save.isError ? errorMessage(save.error) : null}
      >
        {(p) => (
          <div className="flex gap-2">
            <Input {...p} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
            <Button type="submit" variant="secondary" loading={save.isPending} disabled={token.length < 20}>
              Save token
            </Button>
          </div>
        )}
      </Field>
    </form>
  );
}

export function EmailStep({ onNext }: StepProps) {
  const qc = useQueryClient();
  const overview = useOverview();
  const current = useQuery({ queryKey: ['settings', 'email'], queryFn: () => getJson<EmailSettings>('/api/settings/email') });
  const [fromName, setFromName] = useState('');
  const [fromLocal, setFromLocal] = useState('portal');
  const [domain, setDomain] = useState('');
  const email = current.data?.email;
  const pending = email?.status === 'pending';

  const save = useMutation({
    mutationFn: () => putJson<EmailSettings>('/api/settings/email', { fromName: fromName || undefined, fromLocal, domain }),
    onSuccess: (data) => qc.setQueryData(['settings', 'email'], data),
  });
  const verify = useMutation({
    mutationFn: () => postJson<EmailSettings>('/api/settings/email/verify'),
    onSuccess: (data) => qc.setQueryData(['settings', 'email'], data),
  });
  const autoDns = useMutation({ mutationFn: () => postJson<{ zone: string }>('/api/settings/email/cloudflare-dns') });

  // Poll while DNS propagates.
  const verifyRef = useRef(verify.mutate);
  useEffect(() => {
    verifyRef.current = verify.mutate;
  });
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => verifyRef.current(), 15_000);
    return () => window.clearInterval(t);
  }, [pending]);

  return (
    <div className="flex flex-col gap-5">
      <StepHeader n={3} title="Email sender">
        Send from your own address, like <span className="font-code">portal@yourfirm.com</span>. Until this is verified, client
        invites go out as copyable links instead of email.
      </StepHeader>

      {!email?.domain ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid grid-cols-[1fr_auto_1.4fr] items-end gap-2">
            <Field label="Address">{(p) => <Input {...p} required value={fromLocal} onChange={(e) => setFromLocal(e.target.value)} />}</Field>
            <span className="pb-2 text-text3">@</span>
            <Field label="Domain">
              {(p) => <Input {...p} required placeholder="yourfirm.com" value={domain} onChange={(e) => setDomain(e.target.value)} />}
            </Field>
          </div>
          <Field label="Sender name" hint="Defaults to your firm name.">
            {(p) => <Input {...p} value={fromName} onChange={(e) => setFromName(e.target.value)} />}
          </Field>
          {save.isError ? <Notice tone="danger">{errorMessage(save.error)}</Notice> : null}
          <Button type="submit" loading={save.isPending}>
            Create sending domain
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          {email.status === 'verified' ? (
            <Notice tone="ok">
              <strong>{email.domain}</strong> is verified. Mail now comes from {email.fromLocal}@{email.domain}.
            </Notice>
          ) : (
            <Notice tone="warn">
              Add these DNS records at your DNS provider. We check automatically every 15 seconds; DNS can take a few minutes, sometimes
              longer.
            </Notice>
          )}
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-[12.5px]">
              <thead className="bg-sunken text-text2">
                <tr>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {email.records.map((r) => (
                  <tr key={`${r.type}-${r.name}-${r.value}`} className="border-t border-border align-top">
                    <td className="px-3 py-2 font-code">{r.type}</td>
                    <td className="px-3 py-2 font-code break-all">{r.name}</td>
                    <td className="px-3 py-2 font-code break-all">
                      {r.priority !== undefined ? `${r.priority} ` : ''}
                      {r.value}
                      <button
                        type="button"
                        aria-label={`Copy ${r.type} value`}
                        className="ml-1 inline-flex text-text3 hover:text-text"
                        onClick={() => void navigator.clipboard?.writeText(r.value)}
                      >
                        <Copy aria-hidden className="size-3.5" />
                      </button>
                    </td>
                    <td className="px-3 py-2 text-text2">{r.status ?? 'pending'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {email.status !== 'verified' ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" loading={verify.isPending} onClick={() => verify.mutate()}>
                Check now
              </Button>
              {overview.data?.cloudflareToken ? (
                <Button variant="secondary" loading={autoDns.isPending} onClick={() => autoDns.mutate()}>
                  <Cloud aria-hidden className="size-4" />
                  Create records in Cloudflare
                </Button>
              ) : null}
            </div>
          ) : null}
          {autoDns.isSuccess ? <Notice tone="ok">Records created in the {autoDns.data.zone} zone. Verification will follow.</Notice> : null}
          {autoDns.isError ? <Notice tone="danger">{errorMessage(autoDns.error)}</Notice> : null}
          {verify.isError ? <Notice tone="danger">{errorMessage(verify.error)}</Notice> : null}
          {!overview.data?.cloudflareToken && email.status !== 'verified' ? (
            <CloudflareTokenForm onSaved={() => void qc.invalidateQueries({ queryKey: ['settings', 'overview'] })} />
          ) : null}
        </div>
      )}

      <StepActions onSkip={email?.status === 'verified' ? undefined : () => onNext('skipped')}>
        {email?.domain ? <Button onClick={() => onNext(email.status === 'verified' ? 'done' : 'skipped')}>Continue</Button> : null}
      </StepActions>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: custom domain
// ---------------------------------------------------------------------------
export function DomainStep({ onNext }: StepProps) {
  const overview = useOverview();
  const qc = useQueryClient();
  const [hostname, setHostname] = useState('');
  const save = useMutation({
    mutationFn: () => putJson<{ domain: { status: string } }>('/api/settings/domain', { hostname }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const worker = overview.data?.workerName;
  const auto = overview.data?.cloudflareToken;

  return (
    <div className="flex flex-col gap-5">
      <StepHeader n={4} title="Custom domain">
        Put the portal at an address like <span className="font-code">clients.yourfirm.com</span>. Optional; the portal already works at its
        current address.
      </StepHeader>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Portal address" hint={auto ? 'We’ll attach it with your Cloudflare token.' : undefined}>
          {(p) => <Input {...p} required placeholder="clients.yourfirm.com" value={hostname} onChange={(e) => setHostname(e.target.value)} />}
        </Field>
        {save.isError ? <Notice tone="danger">{errorMessage(save.error)}</Notice> : null}
        <Button type="submit" variant="secondary" loading={save.isPending}>
          {auto ? 'Attach domain' : 'Save'}
        </Button>
      </form>
      {save.data?.domain.status === 'active' ? (
        <Notice tone="ok">Attached. Cloudflare issues the certificate; the address usually works within a few minutes.</Notice>
      ) : save.data ? (
        <Notice tone="info">
          <p>To finish in the Cloudflare dashboard:</p>
          <ol className="mt-1 list-decimal pl-5">
            <li>Open Workers &amp; Pages → {worker ? <strong>{worker}</strong> : 'this Worker'} → Settings → Domains &amp; Routes.</li>
            <li>Choose Add → Custom domain and enter {hostname}.</li>
          </ol>
          <a className="mt-2 inline-flex items-center gap-1 underline" href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" target="_blank" rel="noreferrer">
            Open Cloudflare <ExternalLink aria-hidden className="size-3.5" />
          </a>
          <p className="mt-2">Passkeys are tied to an address, so team members add a new passkey after the switch.</p>
        </Notice>
      ) : null}
      <StepActions onSkip={save.data ? undefined : () => onNext('skipped')}>
        {save.data ? <Button onClick={() => onNext('done')}>Continue</Button> : null}
      </StepActions>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5: funding discovery (OpenGrants)
// ---------------------------------------------------------------------------
export function OpenGrantsStep({ onNext }: StepProps) {
  const overview = useOverview();
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const save = useMutation({
    mutationFn: () => putJson('/api/settings/opengrants', { apiKey }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['settings'] });
      onNext('done');
    },
  });
  const configured = overview.data?.opengrants.configured;

  return (
    <div className="flex flex-col gap-5">
      <StepHeader n={5} title="Funding discovery">
        Optional. With an OpenGrants API key the workspace adds grant search, profile-based matching, funder lookup and recurring funding alerts.
        Everything else works without it.
      </StepHeader>
      <ul className="flex flex-col gap-1.5 text-[13.5px] text-text2">
        {['Search grants and funders inside the report builder', 'Match opportunities to a client’s profile', 'Recurring alerts with a review step before anything is sent'].map(
          (t) => (
            <li key={t} className="flex gap-2">
              <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0 text-acc-text" />
              {t}
            </li>
          ),
        )}
      </ul>
      {configured ? (
        <Notice tone="ok">
          A key is already configured{overview.data?.opengrants.source === 'env' ? ' as a Worker secret' : ''}.
        </Notice>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field
            label="OpenGrants API key"
            hint={
              <>
                Get one at{' '}
                <a className="text-acc-text underline" href="https://ops.opengrants.io/api-docs" target="_blank" rel="noreferrer">
                  ops.opengrants.io/api-docs
                </a>
                . Stored encrypted.
              </>
            }
          >
            {(p) => <Input {...p} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />}
          </Field>
          {save.isError ? <Notice tone="danger">{errorMessage(save.error)}</Notice> : null}
          <Button type="submit" loading={save.isPending} disabled={apiKey.trim().length < 8}>
            Save key
          </Button>
        </form>
      )}
      <StepActions onSkip={configured ? undefined : () => onNext('skipped')}>
        {configured ? <Button onClick={() => onNext('done')}>Continue</Button> : null}
      </StepActions>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 6: invite your team
// ---------------------------------------------------------------------------
interface InviteResult {
  emailed: boolean;
  link?: string;
  added?: boolean;
}

export function TeamStep({ onNext }: StepProps) {
  const overview = useOverview();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ email: string; result: InviteResult }[]>([]);
  const canEmail = overview.data?.email.verified ?? false;
  const invite = useMutation({
    mutationFn: () => postJson<InviteResult>('/api/team/invites', { email, delivery: canEmail ? 'email' : 'link' }),
    onSuccess: (result) => {
      setSent((s) => [...s, { email, result }]);
      setEmail('');
    },
  });

  return (
    <div className="flex flex-col gap-5">
      <StepHeader n={6} title="Invite your team">
        Optional. Consultants see the clients you assign them.
        {canEmail ? '' : ' Your sending domain isn’t verified yet, so you’ll get a single-use link (valid 72 hours) to send them yourself.'}
      </StepHeader>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate();
        }}
      >
        <Input type="email" required aria-label="Team member email" placeholder="colleague@yourfirm.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button type="submit" variant="secondary" loading={invite.isPending}>
          <UserPlus aria-hidden className="size-4" />
          Invite
        </Button>
      </form>
      {invite.isError ? <Notice tone="danger">{errorMessage(invite.error)}</Notice> : null}
      {sent.map(({ email: to, result }) => (
        <div key={to} className="flex flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-[13px]">
            <Check aria-hidden className="size-4 text-ok-text" />
            {result.emailed ? `Invite emailed to ${to}` : `Invite link for ${to}`}
          </p>
          {result.link ? <CopyField value={result.link} label={`Invite link for ${to}`} /> : null}
        </div>
      ))}
      <StepActions onSkip={sent.length ? undefined : () => onNext('skipped')}>
        {sent.length ? <Button onClick={() => onNext('done')}>Continue</Button> : null}
      </StepActions>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 7: first client or demo
// ---------------------------------------------------------------------------
export function ClientStep({ onNext }: StepProps) {
  const overview = useOverview();
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const canEmail = overview.data?.email.verified ?? false;
  const create = useMutation({
    mutationFn: () =>
      postJson<{ id: string; invite: InviteResult | null }>('/api/clients', {
        name,
        contact: contact ? { email: contact, delivery: canEmail ? 'email' : 'link' } : undefined,
      }),
  });
  const demo = useMutation({ mutationFn: () => postJson<{ id: string }>('/api/demo'), onSuccess: () => onNext('done') });

  return (
    <div className="flex flex-col gap-5">
      <StepHeader n={7} title="Add your first client">
        Or load a demo client with sample deliverables, a sample report and a paused sample schedule. The demo never emails anyone and is easy to
        delete.
      </StepHeader>
      {create.data ? (
        <div className="flex flex-col gap-2">
          <Notice tone="ok">{name} is set up.</Notice>
          {create.data.invite?.link ? (
            <>
              <p className="text-[13px] text-text2">Send this single-use link to {contact}. It works for 72 hours.</p>
              <CopyField value={create.data.invite.link} label="Client invite link" />
            </>
          ) : create.data.invite?.emailed ? (
            <p className="text-[13px] text-text2">We emailed an invite to {contact}.</p>
          ) : create.data.invite?.added ? (
            <p className="text-[13px] text-text2">{contact} already has an account and was added. They sign in with their email as usual.</p>
          ) : null}
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Client organization">{(p) => <Input {...p} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Contact email (optional)" hint="They become the Client Admin for this organization.">
            {(p) => <Input {...p} type="email" value={contact} onChange={(e) => setContact(e.target.value)} />}
          </Field>
          {create.isError ? <Notice tone="danger">{errorMessage(create.error)}</Notice> : null}
          <Button type="submit" loading={create.isPending}>
            Add client
          </Button>
        </form>
      )}
      <div className="flex items-center gap-3 text-[12.5px] text-text3">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      {demo.isError ? <Notice tone="danger">{errorMessage(demo.error)}</Notice> : null}
      <Button variant="secondary" loading={demo.isPending} onClick={() => demo.mutate()}>
        <Sparkles aria-hidden className="size-4" />
        Load a demo client
      </Button>
      <StepActions onSkip={create.data ? undefined : () => onNext('skipped')}>
        {create.data ? <Button onClick={() => onNext('done')}>Continue</Button> : null}
      </StepActions>
    </div>
  );
}

export async function deleteDemo() {
  return deleteJson<{ deleted: number }>('/api/demo');
}
