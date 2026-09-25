/** Signed-in chrome shared by the workspace and the client portal. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { postJson } from '@/lib/api';
import { useBrand } from '@/lib/session';
import { FirmLogo, ThemeToggle } from './brand';
import { Button } from './controls';

export function AppShell({ nav, children }: { nav: { to: string; label: string }[]; children: ReactNode }) {
  useBrand();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation({
    mutationFn: () => postJson('/auth/signout'),
    onSettled: async () => {
      qc.clear();
      await navigate({ to: '/signin' });
    },
  });

  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-border bg-raised">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
          <FirmLogo height={28} />
          <nav className="ml-4 flex gap-1" aria-label="Main">
            {nav.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                activeOptions={{ exact: true }}
                className="rounded-md px-2.5 py-1.5 text-[13.5px] text-text2 hover:bg-hover hover:text-text [&.active]:bg-active [&.active]:text-text"
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto hidden sm:block">
            <ThemeToggle />
          </div>
          <Button variant="ghost" size="sm" loading={signOut.isPending} onClick={() => signOut.mutate()}>
            <LogOut aria-hidden className="size-3.5" />
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-8">{children}</main>
    </div>
  );
}
