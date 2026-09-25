import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { getJson } from '@/lib/api';
import { useConfig, useMe } from '@/lib/session';
import { Card } from '@/ui/controls';

export const Route = createFileRoute('/portal/')({ component: PortalHome });

function PortalHome() {
  const me = useMe();
  const config = useConfig();
  const home = useQuery({
    queryKey: ['portal', 'home'],
    queryFn: () => getJson<{ clients: { id: string; name: string; role: string }[] }>('/api/portal/home'),
  });
  return (
    <>
      <div>
        <h1 className="hd text-[26px] leading-8">Welcome</h1>
        <p className="mt-1 text-text2">Signed in as {me.data?.user.email}</p>
      </div>
      <Card>
        <h2 className="hd text-[17px]">Your organization{(home.data?.clients.length ?? 0) > 1 ? 's' : ''}</h2>
        <ul className="mt-2 flex flex-col gap-1">
          {home.data?.clients.map((c) => (
            <li key={c.id} className="text-[14px]">
              {c.name}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-text2">
          {config.data?.firmName ?? 'Your consultant'} will share requests, deliverables and updates here.
        </p>
      </Card>
    </>
  );
}
