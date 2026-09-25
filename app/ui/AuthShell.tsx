/** Centered-card layout for sign-in, the interstitial, and setup (spec §6.1). */
import type { ReactNode } from 'react';
import { useBrand } from '@/lib/session';

export function FirmMark({ name, size = 40 }: { name: string | null | undefined; size?: number }) {
  const initials =
    (name ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || '•';
  return (
    <div
      aria-hidden
      className="grid shrink-0 place-items-center rounded-md bg-acc font-semibold text-acc-on"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials}
    </div>
  );
}

export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const config = useBrand();
  const firm = config.data?.firmName;
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 py-10">
      <div className={`w-full ${wide ? 'max-w-xl' : 'max-w-md'}`}>
        {firm ? (
          <div className="mb-6 flex items-center justify-center gap-3">
            <FirmMark name={firm} />
            <span className="hd text-lg">{firm}</span>
          </div>
        ) : null}
        <section className="rounded-card border border-border bg-raised p-6 shadow-panel sm:p-8">{children}</section>
      </div>
    </main>
  );
}
