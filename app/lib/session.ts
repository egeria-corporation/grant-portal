import { checkAccent } from '@shared/contrast';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError, getJson } from './api';

export interface PublicConfig {
  firmName: string | null;
  shortName: string | null;
  accent: string;
  welcome: string | null;
  setupStatus: 'unclaimed' | 'claimed' | 'complete';
  turnstileSiteKey: string | null;
}

export interface Me {
  user: { id: string; email: string; name: string | null; kind: 'staff' | 'client'; role: string };
  session: { id: string; stepUpAt: number | null };
  needsPasskey: boolean;
  passkeyCount: number;
  setupStatus: 'claimed' | 'complete' | null;
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: () => getJson<PublicConfig>('/api/public/config'), staleTime: 60_000 });
}

/** The signed-in user, or null when signed out. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await getJson<Me>('/api/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 30_000,
  });
}

/**
 * Applies the brand accent to the semantic tokens (CSSOM, so CSP-safe). The
 * full generated ramp and /brand/theme.css replace this in M2.
 */
export function applyAccent(accent: string | null | undefined, target: HTMLElement = document.documentElement) {
  const check = accent ? checkAccent(accent) : null;
  if (!accent || !check) return;
  target.style.setProperty('--acc-solid', accent);
  target.style.setProperty('--acc-solidh', accent);
  target.style.setProperty('--acc-on', check.onAccent);
  target.style.setProperty('--acc-focus', accent);
  target.style.setProperty('--acc-brand', accent);
}

export function useBrand() {
  const config = useConfig();
  const accent = config.data?.accent;
  const firm = config.data?.firmName;
  useEffect(() => applyAccent(accent), [accent]);
  useEffect(() => {
    document.title = firm || 'Client portal';
  }, [firm]);
  return config;
}
