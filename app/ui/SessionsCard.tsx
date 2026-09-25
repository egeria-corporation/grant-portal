/** "Where you're signed in" with per-session revoke and sign out everywhere (spec §7.1). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Monitor } from 'lucide-react';
import { deleteJson, errorMessage, getJson, postJson } from '@/lib/api';
import { Button, Card, Notice } from './controls';

interface SessionRow {
  id: string;
  device: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function SessionsCard() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ['sessions'], queryFn: () => getJson<{ sessions: SessionRow[] }>('/api/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => deleteJson(`/api/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  const everywhere = useMutation({
    mutationFn: () => postJson('/auth/signout-all'),
    onSuccess: async () => {
      qc.clear();
      await navigate({ to: '/signin' });
    },
  });

  return (
    <Card>
      <h2 className="hd text-[17px]">Where you’re signed in</h2>
      <ul className="mt-3 divide-y divide-border">
        {list.data?.sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-3 py-3">
            <Monitor aria-hidden className="size-4 shrink-0 text-text3" />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium">
                {s.device} {s.current ? <span className="ml-1 rounded-pill bg-ok-bg px-2 py-0.5 text-[11.5px] text-ok-text">This device</span> : null}
              </p>
              <p className="text-[12.5px] text-text3">
                Signed in {fmt(s.createdAt)} · last active {fmt(s.lastSeenAt)}
              </p>
            </div>
            {!s.current ? (
              <Button variant="ghost" size="sm" loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>
                Sign out
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {everywhere.isError ? <Notice tone="danger">{errorMessage(everywhere.error)}</Notice> : null}
      <Button variant="danger" className="mt-3" loading={everywhere.isPending} onClick={() => everywhere.mutate()}>
        Sign out everywhere
      </Button>
    </Card>
  );
}
