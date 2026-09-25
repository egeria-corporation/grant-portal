/** Wizard step 1: claim this portal by email, or with the setup code from the Worker logs. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Mail, Terminal } from 'lucide-react';
import { useState } from 'react';
import { errorMessage, postJson } from '@/lib/api';
import { Button, Field, Input, Notice } from '@/ui/controls';

export function ClaimStep({ emailConfigured }: { emailConfigured: boolean }) {
  const [mode, setMode] = useState<'email' | 'code'>(emailConfigured ? 'email' : 'code');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const navigate = useNavigate();
  const qc = useQueryClient();

  const finish = async (out: { redirect: string }) => {
    await qc.invalidateQueries();
    await navigate({ to: out.redirect, replace: true });
  };

  const claim = useMutation({ mutationFn: () => postJson('/api/setup/claim', { email }), onSuccess: () => setSent(true) });
  const verify = useMutation({
    mutationFn: () => postJson<{ redirect: string }>('/auth/code/verify', { email, code, purpose: 'setup' }),
    onSuccess: finish,
  });
  const reissue = useMutation({ mutationFn: () => postJson('/api/setup/setup-code') });
  const withCode = useMutation({
    mutationFn: () => postJson<{ redirect: string }>('/api/setup/claim-with-code', { email, setupCode }),
    onSuccess: finish,
  });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-[12.5px] font-medium uppercase tracking-wide text-text3">Step 1 of 8</p>
        <h1 className="hd mt-1 text-[24px] leading-8">Claim this portal</h1>
        <p className="mt-1.5 text-text2">
          You’ll become the Owner. Only one person can claim a portal, and the first to finish this step wins.
        </p>
      </div>

      {mode === 'email' && !sent ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            claim.mutate();
          }}
        >
          <Field
            label="Your email"
            hint="Use the email address you signed up to Resend with. Until you verify your own sending domain, Resend only delivers to that address."
          >
            {(p) => (
              <Input {...p} type="email" inputSize="lg" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            )}
          </Field>
          {claim.isError ? <Notice tone="danger">{errorMessage(claim.error)}</Notice> : null}
          <Button type="submit" size="lg" block loading={claim.isPending}>
            <Mail aria-hidden className="size-4" />
            Email me a setup link
          </Button>
        </form>
      ) : null}

      {mode === 'email' && sent ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            verify.mutate();
          }}
        >
          <Notice tone="ok">
            Sent to <strong>{email}</strong>. Open the link on this device, or type the 6-digit code below.
          </Notice>
          <Field label="Code from the email" error={verify.isError ? errorMessage(verify.error) : null}>
            {(p) => (
              <Input
                {...p}
                inputSize="lg"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="text-center font-code tracking-[0.3em]"
              />
            )}
          </Field>
          <Button type="submit" size="lg" block loading={verify.isPending} disabled={code.replace(/\s/g, '').length !== 6}>
            Claim portal
          </Button>
        </form>
      ) : null}

      {mode === 'code' ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            withCode.mutate();
          }}
        >
          <Notice tone="info">
            A one-time setup code is printed in your Worker’s logs. In the Cloudflare dashboard, open{' '}
            <strong>Workers &amp; Pages → your Worker → Logs</strong> and look for “Portal setup code”.
          </Notice>
          <Field label="Your email">
            {(p) => <Input {...p} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label="Setup code" hint="Looks like ABCD-EFGH-JKMN.">
            {(p) => (
              <Input
                {...p}
                required
                autoComplete="off"
                value={setupCode}
                onChange={(e) => setSetupCode(e.target.value)}
                className="font-code uppercase tracking-wider"
              />
            )}
          </Field>
          {withCode.isError ? <Notice tone="danger">{errorMessage(withCode.error)}</Notice> : null}
          <Button type="submit" size="lg" block loading={withCode.isPending}>
            Claim portal
          </Button>
          <Button variant="ghost" size="sm" loading={reissue.isPending} onClick={() => reissue.mutate()}>
            <Terminal aria-hidden className="size-3.5" />
            {reissue.isSuccess ? 'New code printed to the logs' : 'Print a new setup code to the logs'}
          </Button>
        </form>
      ) : null}

      <div className="border-t border-border pt-4 text-center">
        {mode === 'email' ? (
          <Button variant="link" onClick={() => setMode('code')}>
            Email not arriving? Use the setup code instead
          </Button>
        ) : emailConfigured ? (
          <Button variant="link" onClick={() => setMode('email')}>
            Claim by email instead
          </Button>
        ) : (
          <p className="text-[12.5px] text-text3">Email isn’t configured on this deployment (RESEND_API_KEY is not set).</p>
        )}
      </div>
    </div>
  );
}
