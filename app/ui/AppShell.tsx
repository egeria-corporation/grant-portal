/** Signed-in chrome shared by the workspace and the client portal. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { postJson } from '@/lib/api';
import { useBrand, useConfig } from '@/lib/session';
import { FirmLogo, ThemeToggle } from './brand';
import { Button } from './controls';

export function AppShell({ nav, children, aside }: { nav: { to: string; label: string; exact?: boolean }[]; children: ReactNode; aside?: ReactNode }) {
  useBrand();
  const config = useConfig();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation({
    mutationFn: () => postJson('/auth/signout'),
    onSettled: async () => {
      qc.clear();
      await navigate({ to: '/signin' });
    },
  });

  const links = nav.map((n) => (
    <Link
      key={n.to}
      to={n.to}
      activeOptions={{ exact: n.exact ?? false }}
      className="shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13.5px] text-text2 hover:bg-hover hover:text-text [&.active]:bg-active [&.active]:text-text"
    >
      {n.label}
    </Link>
  ));

  return (
    <div className="min-h-dvh bg-bg">
      {config.data?.demo ? (
        <p role="note" className="t-sm bg-warn-bg px-4 py-1.5 text-center text-warn-text">
          Public demo with sample data. It’s read-only, so changes won’t save.
        </p>
      ) : null}
      <header className="border-b border-border bg-raised">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <FirmLogo height={28} />
          {/* Wide screens: the sections sit inline. Narrower: their own wrapping row below, so none hide off-screen. */}
          <nav className="ml-2 hidden min-w-0 flex-1 gap-1 lg:flex" aria-label="Main">
            {links}
          </nav>
          <span className="flex-1 lg:hidden" />
          {aside}
          <div className="hidden sm:block">
            <ThemeToggle />
          </div>
          <Button variant="ghost" size="sm" loading={signOut.isPending} onClick={() => signOut.mutate()} aria-label="Sign out">
            <LogOut aria-hidden className="size-3.5" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
        <nav className="mx-auto flex max-w-6xl flex-wrap gap-1 px-3 pb-2 lg:hidden" aria-label="Main">
          {links}
        </nav>
      </header>
      <main className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-8">{children}</main>
    </div>
  );
}
