import { startRegistration } from '@simplewebauthn/browser';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { errorMessage, postJson } from '@/lib/api';
import { Button, Notice } from './controls';

type RegOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];

/** Registers a passkey for the signed-in staff user (spec §7.1). */
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
        <Notice tone="danger">{add.error instanceof Error && add.error.name === 'NotAllowedError' ? 'Passkey setup was cancelled.' : errorMessage(add.error)}</Notice>
      ) : null}
      {add.isSuccess ? <Notice tone="ok">Passkey added. Next time, sign in with it.</Notice> : null}
    </div>
  );
}
