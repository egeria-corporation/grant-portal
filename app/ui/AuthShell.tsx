/** Centered-card layout for sign-in, the interstitial, and setup (spec §6.1). */
import type { ReactNode } from 'react';
import { useBrand } from '@/lib/session';
import { FirmLogo, ThemeToggle } from './brand';

export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const config = useBrand();
  const branded = Boolean(config.data?.firmName);
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 py-10">
      <div className={`w-full ${wide ? 'max-w-xl' : 'max-w-md'}`}>
        {branded ? (
          <div className="mb-6 flex justify-center">
            <FirmLogo height={36} />
          </div>
        ) : null}
        <section className="card shadow-panel p-6 sm:p-8">{children}</section>
        <div className="mt-6 flex items-center justify-center gap-4">
          <ThemeToggle />
          {config.data?.poweredBy ? <span className="t-xs text-text3">Powered by open-source software</span> : null}
        </div>
      </div>
    </main>
  );
}
