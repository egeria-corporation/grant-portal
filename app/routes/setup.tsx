/** First-run setup wizard (spec §3.3). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { getJson, putJson } from '@/lib/api';
import { useMe } from '@/lib/session';
import { ClaimStep } from '@/setup/ClaimStep';
import { LiveStep } from '@/setup/LiveStep';
import { BrandStep, ClientStep, DomainStep, EmailStep, OpenGrantsStep, type StepResult, TeamStep } from '@/setup/steps';
import { AuthShell } from '@/ui/AuthShell';
import { Spinner } from '@/ui/controls';

export const Route = createFileRoute('/setup')({ component: Setup });

const STEPS = ['brand', 'email', 'domain', 'opengrants', 'team', 'client'] as const;
type Step = (typeof STEPS)[number];

function Setup() {
  const status = useQuery({
    queryKey: ['setup', 'status'],
    queryFn: () => getJson<{ status: 'unclaimed' | 'claimed' | 'complete'; emailConfigured: boolean }>('/api/setup/status'),
  });
  const me = useMe();

  if (status.isPending || me.isPending) return <Spinner />;
  if (status.data?.status === 'unclaimed') {
    return (
      <AuthShell wide>
        <ClaimStep emailConfigured={status.data.emailConfigured} />
      </AuthShell>
    );
  }
  if (me.data?.user.role !== 'owner') {
    return (
      <AuthShell>
        <h1 className="hd text-[22px] leading-7">This portal is set up</h1>
        <p className="mt-2 text-text2">It has already been claimed by its Owner.</p>
        <Link to="/signin" className="mt-5 inline-block font-medium text-acc-text hover:underline">
          Sign in
        </Link>
      </AuthShell>
    );
  }
  return <OwnerWizard />;
}

function OwnerWizard() {
  const qc = useQueryClient();
  const progress = useQuery({
    queryKey: ['setup', 'progress'],
    queryFn: () => getJson<{ status: string; steps: Partial<Record<Step, StepResult>> }>('/api/setup/progress'),
  });
  const [current, setCurrent] = useState<Step | 'live' | null>(null);
  const mark = useMutation({
    mutationFn: ({ step, state }: { step: Step; state: StepResult }) => putJson(`/api/setup/steps/${step}`, { state }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['setup', 'progress'] }),
  });

  if (progress.isPending) return <Spinner />;
  const firstOpen = STEPS.find((s) => !progress.data?.steps[s]) ?? 'live';
  const step = current ?? firstOpen;
  const index = step === 'live' ? STEPS.length : STEPS.indexOf(step);

  const next = (state: StepResult) => {
    if (step === 'live') return;
    mark.mutate({ step, state });
    setCurrent(STEPS[index + 1] ?? 'live');
  };

  return (
    <AuthShell wide>
      <nav aria-label="Setup progress" className="mb-6 flex gap-1.5">
        {[...STEPS, 'live' as const].map((s, i) => (
          <button
            key={s}
            type="button"
            aria-label={`Go to step ${i + 2}`}
            aria-current={s === step ? 'step' : undefined}
            onClick={() => setCurrent(s)}
            className={`h-1.5 flex-1 rounded-pill ${i < index ? 'bg-acc' : i === index ? 'bg-acc-300' : 'bg-sunken'}`}
          />
        ))}
      </nav>
      {step === 'brand' ? <BrandStep onNext={next} /> : null}
      {step === 'email' ? <EmailStep onNext={next} /> : null}
      {step === 'domain' ? <DomainStep onNext={next} /> : null}
      {step === 'opengrants' ? <OpenGrantsStep onNext={next} /> : null}
      {step === 'team' ? <TeamStep onNext={next} /> : null}
      {step === 'client' ? <ClientStep onNext={next} /> : null}
      {step === 'live' ? <LiveStep /> : null}
    </AuthShell>
  );
}
