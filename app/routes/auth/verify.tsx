/**
 * The sign-in interstitial (spec §7.1). Opening the emailed link only shows
 * this page; the token is spent by the POST behind "Continue", so email link
 * scanners that fetch the URL can't burn it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError, errorMessage, postJson } from '@/lib/api';
import { AuthShell } from '@/ui/AuthShell';
import { Button, Notice, Spinner } from '@/ui/controls';

export const Route = createFileRoute('/auth/verify')({ component: Verify });

interface Peek {
  purpose: 'signin' | 'invite' | 'setup';
  email: string;
  firm: string;
}

/** Read the token once, then drop it from the address bar and history. */
function takeToken(): string {
  const url = new URL(window.location.href);
  const t = url.searchParams.get('t') ?? sessionStorage.getItem('verify-token') ?? '';
  if (url.searchParams.has('t')) {
    sessionStorage.setItem('verify-token', t);
    url.searchParams.delete('t');
    window.history.replaceState(window.history.state, '', url.pathname + url.search);
  }
  return t;
}

function Verify() {
  const [token] = useState(takeToken);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const peek = useQuery({
    queryKey: ['peek', token],
    queryFn: () => postJson<Peek>('/auth/link/peek', { token }),
    retry: false,
    enabled: Boolean(token),
  });
  const consume = useMutation({
    mutationFn: () => postJson<{ redirect: string }>('/auth/link/consume', { token }),
    onSuccess: async (out) => {
      sessionStorage.removeItem('verify-token');
      await qc.invalidateQueries();
      await navigate({ to: out.redirect });
    },
  });

  if (token && peek.isPending) return <Spinner />;

  if (!token || peek.isError) {
    const expired = !token || (peek.error instanceof ApiError && peek.error.status === 410);
    return (
      <AuthShell>
        <h1 className="hd text-[22px] leading-7">{expired ? 'This link has expired' : 'Something went wrong'}</h1>
        <p className="mt-2 text-text2">
          {expired ? 'Sign-in links work once and expire after 15 minutes. Invites last 72 hours.' : errorMessage(peek.error)}
        </p>
        <Link to="/signin" className="mt-5 inline-block font-medium text-acc-text hover:underline">
          Request a new sign-in link
        </Link>
      </AuthShell>
    );
  }

  const info = peek.data;
  const heading =
    info?.purpose === 'setup' ? 'Claim this portal' : info?.purpose === 'invite' ? `Join ${info.firm}` : `Sign in to ${info?.firm}`;

  return (
    <AuthShell>
      <div className="flex flex-col gap-5">
        <div>
          <h1 className="hd text-[22px] leading-7">{heading}</h1>
          <p className="mt-1.5 text-text2">
            Continue as <strong className="text-text">{info?.email}</strong>.
          </p>
        </div>
        {consume.isError ? <Notice tone="danger">{errorMessage(consume.error)}</Notice> : null}
        <Button size="lg" block loading={consume.isPending} onClick={() => consume.mutate()}>
          Continue
        </Button>
        <p className="text-[12.5px] text-text3">Not you? Close this tab. Nothing happens until you press Continue.</p>
      </div>
    </AuthShell>
  );
}
