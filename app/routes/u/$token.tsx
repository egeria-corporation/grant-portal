/** Unsubscribe page for links in email (spec §9). The same URL takes one-click POSTs from mail apps. */
import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { MailX } from 'lucide-react';
import { errorMessage, postJson } from '@/lib/api';
import { AuthShell } from '@/ui/AuthShell';
import { Button, Notice } from '@/ui/controls';

export const Route = createFileRoute('/u/$token')({ component: Unsubscribe });

const WHAT: Record<string, string> = {
  activity: 'emails about new drafts, decisions and messages',
  reminders: 'reminder emails',
  updates: 'update emails',
};

function Unsubscribe() {
  const { token } = Route.useParams();
  const category = token.split('.')[1] ?? '';
  const go = useMutation({ mutationFn: () => postJson(`/u/${token}`) });
  return (
    <AuthShell>
      <MailX aria-hidden className="size-7 text-acc-text" />
      <h1 className="hd mt-2 text-[22px] leading-7">{go.isSuccess ? 'You’re unsubscribed' : 'Unsubscribe'}</h1>
      {go.isSuccess ? (
        <p className="mt-1.5 text-text2">You won’t get {WHAT[category] ?? 'these emails'} any more. You can turn them back on from your profile after signing in.</p>
      ) : (
        <>
          <p className="mb-5 mt-1.5 text-text2">Stop {WHAT[category] ?? 'these emails'}? Sign-in emails and document requests still come through.</p>
          {go.isError ? <Notice tone="danger">{errorMessage(go.error)}</Notice> : null}
          <Button block loading={go.isPending} onClick={() => go.mutate()}>
            Unsubscribe
          </Button>
        </>
      )}
    </AuthShell>
  );
}
