import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { getJson } from '@/lib/api';

interface SecretStatus {
  name: 'SESSION_SECRET' | 'DATA_ENCRYPTION_KEY';
  source: 'env' | 'generated' | 'not_initialised';
  weakEnvIgnored: boolean;
  keyId: string | null;
}

/**
 * Owner-only notice (spec §3.2, §7.5): a key was generated on first boot and
 * lives in KV. The API answers 401 to anyone else, so this renders nothing.
 */
export function SecretsBanner() {
  const { data } = useQuery({
    queryKey: ['system', 'secrets'],
    queryFn: () => getJson<{ secrets: SecretStatus[] }>('/api/system/secrets'),
    retry: false,
  });
  const generated = data?.secrets.filter((s) => s.source === 'generated') ?? [];
  if (generated.length === 0) return null;

  return (
    <div role="status" className="flex items-start gap-3 rounded-md border border-warn-bd bg-warn-bg px-3.5 py-2.5 text-warn-text">
      <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p className="text-[13.5px]">
        {generated.map((s) => s.name).join(' and ')} {generated.length === 1 ? 'was' : 'were'} generated automatically
        and stored in KV. For stronger isolation, move {generated.length === 1 ? 'it' : 'them'} to a Worker secret.
      </p>
    </div>
  );
}
