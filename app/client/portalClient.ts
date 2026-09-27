/**
 * Which client org the portal is showing. Most client users belong to one;
 * someone who belongs to several picks one, and the choice is remembered.
 */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { getJson } from '@/lib/api';

export interface PortalClient {
  id: string;
  name: string;
  role: 'admin' | 'member';
  openItems: number;
  awaitingYou: number;
}

const KEY = 'portal.client';
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function usePortalClients() {
  return useQuery({ queryKey: ['portal', 'home'], queryFn: () => getJson<{ clients: PortalClient[] }>('/api/portal/home') });
}

export function usePortalClient(): { client: PortalClient | null; clients: PortalClient[]; select: (id: string) => void; isPending: boolean } {
  const home = usePortalClients();
  const stored = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => null,
  );
  const clients = home.data?.clients ?? [];
  const client = clients.find((c) => c.id === stored) ?? clients[0] ?? null;
  const select = useCallback((id: string) => {
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* private mode: the choice lasts until reload */
    }
    listeners.forEach((l) => l());
  }, []);
  return { client, clients, select, isPending: home.isPending };
}
