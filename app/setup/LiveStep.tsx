/** Wizard end: "Your portal is live" (spec §3.3). */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CircleCheck, Circle, PartyPopper } from 'lucide-react';
import { errorMessage, postJson } from '@/lib/api';
import { useMe } from '@/lib/session';
import { Button, CopyField, Notice } from '@/ui/controls';
import { AddPasskeyButton } from '@/ui/PasskeyButton';
import { useOverview } from './steps';

export function LiveStep() {
  const overview = useOverview();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const loginUrl = `${window.location.origin}/signin`;
  const firm = overview.data?.brand.firmName || 'our firm';
  const inviteText = `Hi,\n\nWe've set up a secure client portal for our work together. There's no password: enter your email at ${loginUrl} and we'll send you a sign-in link.\n\nThanks,\n${firm}`;

  const finish = useMutation({
    mutationFn: () => postJson('/api/setup/complete'),
    onSuccess: async () => {
      await qc.invalidateQueries();
      await navigate({ to: '/workspace' });
    },
  });

  const o = overview.data;
  const checklist = [
    { done: (me.data?.passkeyCount ?? 0) > 0, label: 'Add a passkey for faster, phishing-resistant sign-in' },
    { done: o?.email.verified ?? false, label: 'Verify your sending domain so invites and updates can be emailed' },
    { done: o?.domain?.status === 'active', label: 'Put the portal on your own domain' },
    { done: o?.turnstile.configured ?? false, label: 'Add Turnstile bot protection to the sign-in form' },
    { done: o?.opengrants.configured ?? false, label: 'Connect OpenGrants for funding discovery' },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <PartyPopper aria-hidden className="size-7 text-acc-text" />
        <h1 className="hd mt-2 text-[26px] leading-8">Your portal is live</h1>
        <p className="mt-1.5 text-text2">Clients sign in here with just their email.</p>
      </div>
      <CopyField value={loginUrl} label="Client sign-in address" />
      <div className="flex flex-col gap-1.5">
        <p className="text-[13px] font-medium">An invite you can paste into an email</p>
        <textarea
          readOnly
          value={inviteText}
          rows={7}
          aria-label="Invite email text"
          className="w-full resize-none rounded-sm border border-binput bg-raised p-3 text-[13px] text-text"
          onFocus={(e) => e.currentTarget.select()}
        />
      </div>
      <div>
        <p className="mb-2 text-[13px] font-medium">Optional next steps</p>
        <ul className="flex flex-col gap-2">
          {checklist.map((item) => (
            <li key={item.label} className="flex items-start gap-2 text-[13.5px]">
              {item.done ? (
                <CircleCheck aria-label="Done" className="mt-0.5 size-4 shrink-0 text-ok-text" />
              ) : (
                <Circle aria-label="Not yet" className="mt-0.5 size-4 shrink-0 text-text3" />
              )}
              <span className={item.done ? 'text-text2 line-through' : ''}>{item.label}</span>
            </li>
          ))}
        </ul>
      </div>
      {(me.data?.passkeyCount ?? 0) === 0 ? <AddPasskeyButton variant="secondary" label="Owner passkey" /> : null}
      {finish.isError ? <Notice tone="danger">{errorMessage(finish.error)}</Notice> : null}
      <Button size="lg" block loading={finish.isPending} onClick={() => finish.mutate()}>
        Go to your workspace
      </Button>
    </div>
  );
}
