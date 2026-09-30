import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { ApiError, errorMessage, postJson } from '@/lib/api';
import { Button, Notice } from './controls';

type RegOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];

/** Registers a passkey for the signed-in staff user (spec §7.1). Needs a recent step-up (D-079). */
export function AddPasskeyButton({ label, variant = 'primary' }: { label?: string; variant?: 'primary' | 'secondary' }) {
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: async () => {
      const { challengeId, options } = await postJson<{ challengeId: string; options: RegOptions }>('/auth/passkey/register/options');
      const response = await startRegistration({ optionsJSON: options });
      return postJson('/auth/passkey/register/verify', { challengeId, response, label });
    },
    onSuccess: () => qc.invalidateQueries(),
  });
  return (
    <div className="flex flex-col gap-2">
      <Button variant={variant} loading={add.isPending} onClick={() => add.mutate()}>
        <KeyRound aria-hidden className="size-4" />
        Add a passkey
      </Button>
      {add.isError ? (
        needsStepUp(add.error) ? (
          <StepUp onDone={() => add.mutate()} />
        ) : (
          <Notice tone="danger">{add.error instanceof Error && add.error.name === 'NotAllowedError' ? 'Passkey setup was cancelled.' : errorMessage(add.error)}</Notice>
        )
      ) : null}
      {add.isSuccess ? <Notice tone="ok">Passkey added. Next time, sign in with it.</Notice> : null}
    </div>
  );
}

type AuthOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];

/**
 * Shown when an action answers `step_up_required` (spec §7.1): confirm with a
 * passkey, then retry. Without a passkey, a fresh sign-in also counts.
 */
export function StepUp({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const confirm = useMutation({
    mutationFn: async () => {
      const { challengeId, options } = await postJson<{ challengeId: string; options: AuthOptions }>('/auth/passkey/options');
      const response = await startAuthentication({ optionsJSON: options });
      return postJson('/auth/passkey/verify', { challengeId, response });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      onDone();
    },
  });
  return (
    <Notice
      tone="warn"
      action={
        <Button size="sm" loading={confirm.isPending} onClick={() => confirm.mutate()}>
          <KeyRound aria-hidden className="size-4" /> Confirm with passkey
        </Button>
      }
    >
      For security, confirm it’s you first. No passkey on this device?{' '}
      <Link to="/signin" className="underline underline-offset-2">
        Sign in again with an email link
      </Link>
      , then try again within 30 minutes.
      {confirm.isError ? <span className="mt-1 block">{confirm.error instanceof Error && confirm.error.name === 'NotAllowedError' ? 'Cancelled.' : errorMessage(confirm.error)}</span> : null}
    </Notice>
  );
}

/** True when an error is the server asking for a step-up. */
export const needsStepUp = (err: unknown) => err instanceof ApiError && err.code === 'step_up_required';
