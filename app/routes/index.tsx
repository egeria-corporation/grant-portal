import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { CircleCheck, CircleAlert } from 'lucide-react';
import { SecretsBanner } from '@/ui/SecretsBanner';

interface Health {
  status: 'ok' | 'degraded';
  version: string;
  checks: { db: string };
}

export const Route = createFileRoute('/')({ component: ItWorks });

function ItWorks() {
  const health = useQuery({ queryKey: ['healthz'], queryFn: async () => (await fetch('/healthz')).json() as Promise<Health>, retry: false });
  const ok = health.data?.status === 'ok';

  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4">
      <section className="w-full max-w-md rounded-card border border-border bg-raised p-8 shadow-panel">
        <h1 className="hd text-[30px] leading-9">It works</h1>
        <p className="mt-2 text-text2">Your portal is deployed. Setup comes next.</p>
        <div className="mt-6 flex items-center gap-2 text-[13.5px]" data-testid="health">
          {health.isPending ? (
            <span className="text-text3">Checking…</span>
          ) : ok ? (
            <>
              <CircleCheck aria-hidden className="size-4 text-ok-text" />
              <span>All systems ready</span>
            </>
          ) : (
            <>
              <CircleAlert aria-hidden className="size-4 text-warn-text" />
              <span>
                {health.data?.checks.db === 'migrations_pending'
                  ? 'Database migrations have not run yet.'
                  : 'The server is not ready yet.'}
              </span>
            </>
          )}
        </div>
        <div className="mt-4">
          <SecretsBanner />
        </div>
      </section>
    </main>
  );
}
