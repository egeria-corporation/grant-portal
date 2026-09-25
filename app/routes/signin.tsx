import { startAuthentication } from '@simplewebauthn/browser';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { KeyRound, Mail } from 'lucide-react';
import { useState } from 'react';
import { errorMessage, postJson } from '@/lib/api';
import { useConfig } from '@/lib/session';
import { AuthShell } from '@/ui/AuthShell';
import { Button, Field, Input, Notice } from '@/ui/controls';
import { Turnstile } from '@/ui/Turnstile';

export const Route = createFileRoute('/signin')({ component: SignIn });

function SignIn() {
  const config = useConfig();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const siteKey = config.data?.turnstileSiteKey ?? null;

  const done = async (out: { redirect: string }) => {
    await qc.invalidateQueries();
    await navigate({ to: out.redirect });
  };

  const request = useMutation({
    mutationFn: () => postJson('/auth/magic/request', { email, turnstileToken: turnstileToken ?? undefined }),
    onSuccess: () => setSentTo(email.trim()),
  });
  const verify = useMutation({
    mutationFn: () => postJson<{ redirect: string }>('/auth/code/verify', { email: sentTo, code }),
    onSuccess: done,
  });
  const passkey = useMutation({
    mutationFn: async () => {
      const { challengeId, options } = await postJson<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>(
        '/auth/passkey/options',
      );
      const response = await startAuthentication({ optionsJSON: options });
      return postJson<{ redirect: string }>('/auth/passkey/verify', { challengeId, response });
    },
    onSuccess: done,
  });

  if (sentTo) {
    return (
      <AuthShell>
        <div className="flex flex-col gap-5">
          <div className="grid size-11 place-items-center rounded-full bg-acc-50 text-acc-text">
            <Mail aria-hidden className="size-5" />
          </div>
          <div>
            <h1 className="hd text-[22px] leading-7">Check your email</h1>
            <p className="mt-1.5 text-text2">
              If <strong className="text-text">{sentTo}</strong> has an account
              {config.data?.firmName ? ` with ${config.data.firmName}` : ''}, a sign-in link is on its way. It expires in 15
              minutes.
            </p>
          </div>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              verify.mutate();
            }}
          >
            <Field label="Or enter the 6-digit code from the email" error={verify.isError ? errorMessage(verify.error) : null}>
              {(p) => (
                <Input
                  {...p}
                  inputSize="lg"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]*"
                  maxLength={7}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="text-center font-code tracking-[0.3em]"
                  invalid={verify.isError}
                />
              )}
            </Field>
            <Button type="submit" size="lg" block loading={verify.isPending} disabled={code.replace(/\s/g, '').length !== 6}>
              Sign in
            </Button>
          </form>
          <Button variant="link" onClick={() => (setSentTo(null), setCode(''), verify.reset())}>
            Use a different email
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="flex flex-col gap-5">
        <div>
          <h1 className="hd text-[22px] leading-7">Sign in</h1>
          <p className="mt-1.5 text-text2">{config.data?.welcome || "Enter your email and we'll send you a sign-in link."}</p>
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            request.mutate();
          }}
        >
          <Field label="Email address">
            {(p) => (
              <Input
                {...p}
                type="email"
                inputSize="lg"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@organization.org"
              />
            )}
          </Field>
          {siteKey ? <Turnstile siteKey={siteKey} onToken={setTurnstileToken} /> : null}
          {request.isError ? <Notice tone="danger">{errorMessage(request.error)}</Notice> : null}
          <Button type="submit" size="lg" block loading={request.isPending} disabled={Boolean(siteKey) && !turnstileToken}>
            Email me a sign-in link
          </Button>
        </form>
        <div className="flex items-center gap-3 text-[12.5px] text-text3">
          <span className="h-px flex-1 bg-border" />
          Team members
          <span className="h-px flex-1 bg-border" />
        </div>
        {passkey.isError ? <Notice tone="danger">{errorMessage(passkey.error)}</Notice> : null}
        <Button variant="secondary" size="lg" block loading={passkey.isPending} onClick={() => passkey.mutate()}>
          <KeyRound aria-hidden className="size-4" />
          Sign in with a passkey
        </Button>
      </div>
    </AuthShell>
  );
}
