/** Client detail layout: header and tabs (spec §5.2). */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { errorMessage, getJson } from '@/lib/api';
import { STATUS_LABEL } from '@/lib/format';
import type { ClientProfile } from '@/lib/types';
import { Notice } from '@/ui/controls';
import { OrgMark, Pill } from '@/ui/display';

export const Route = createFileRoute('/workspace/clients/$clientId')({ component: ClientLayout });

export interface StaffClient {
  client: ClientProfile;
  access: 'staff';
  assignedStaff: { id: string; name: string | null; email: string; role: string }[];
}

export function useStaffClient(clientId: string) {
  return useQuery({ queryKey: ['client', clientId], queryFn: () => getJson<StaffClient>(`/api/clients/${clientId}`) });
}

const TABS = [
  { to: '/workspace/clients/$clientId', label: 'Overview', exact: true },
  { to: '/workspace/clients/$clientId/documents', label: 'Documents' },
  { to: '/workspace/clients/$clientId/deliverables', label: 'Deliverables' },
  { to: '/workspace/clients/$clientId/messages', label: 'Messages' },
  { to: '/workspace/clients/$clientId/updates', label: 'Updates' },
  { to: '/workspace/clients/$clientId/reports', label: 'Reports' },
  { to: '/workspace/clients/$clientId/pipeline', label: 'Pipeline' },
  { to: '/workspace/clients/$clientId/funding', label: 'Funding' },
  { to: '/workspace/clients/$clientId/people', label: 'People' },
  { to: '/workspace/clients/$clientId/timeline', label: 'Timeline' },
] as const;

function ClientLayout() {
  const { clientId } = Route.useParams();
  const client = useStaffClient(clientId);
  if (client.isError) return <Notice tone="danger">{errorMessage(client.error)}</Notice>;
  const c = client.data?.client;
  return (
    <>
      <Link to="/workspace/clients" className="t-sm inline-flex items-center gap-1 text-text2 hover:text-text">
        <ArrowLeft aria-hidden className="size-3.5" /> Clients
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <OrgMark name={c?.name ?? '…'} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="hd truncate text-[24px] leading-8">{c?.name ?? 'Loading…'}</h1>
          {c?.legalName && c.legalName !== c.name ? <span className="t-sm text-text2">{c.legalName}</span> : null}
        </div>
        {c ? <Pill>{STATUS_LABEL[c.status]}</Pill> : null}
      </div>
      <nav aria-label="Client sections" className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
        {TABS.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            params={{ clientId }}
            activeOptions={{ exact: 'exact' in t }}
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
