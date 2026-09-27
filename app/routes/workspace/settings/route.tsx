/** Settings (spec §5.9), Owner only. The API enforces it; this layout just keeps others out of the screens. */
import { createFileRoute, Link, Navigate, Outlet, useLocation } from '@tanstack/react-router';
import { useMe } from '@/lib/session';

export const Route = createFileRoute('/workspace/settings')({ component: SettingsLayout });

const TABS = [
  { to: '/workspace/settings/brand', label: 'Brand' },
  { to: '/workspace/settings/security', label: 'Security' },
  { to: '/workspace/settings/team', label: 'Team' },
  { to: '/workspace/settings/audit', label: 'Audit log' },
  { to: '/workspace/settings/data', label: 'Data' },
] as const;

function SettingsLayout() {
  const me = useMe();
  const { pathname } = useLocation();
  if (me.data && me.data.user.role !== 'owner') return <Navigate to="/workspace" replace />;
  if (pathname.replace(/\/$/, '') === '/workspace/settings') return <Navigate to="/workspace/settings/brand" replace />;
  return (
    <>
      <nav aria-label="Settings sections" className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
        {TABS.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className="shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[13.5px] text-text2 hover:text-text [&.active]:border-acc-solid [&.active]:font-medium [&.active]:text-text"
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
