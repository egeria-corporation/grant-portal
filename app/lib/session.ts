import type { Mode } from '@shared/theme/ramp';
import { modeVars, sharedVars, type ThemeInput } from '@shared/theme/tokens';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError, getJson } from './api';

export interface PublicConfig {
  firmName: string | null;
  shortName: string | null;
  accent: string;
  welcome: string | null;
  theme: ThemeInput;
  brandVersion: string;
  logoLight: string | null;
  logoDark: string | null;
  mark: string | null;
  poweredBy: boolean;
  devTools: boolean;
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
 * Sets a theme's variables on one element (CSSOM, so CSP-safe). Used for live
 * previews; the page itself is themed by /brand/theme.css from the server.
 */
export function applyThemeVars(target: HTMLElement, theme: ThemeInput, mode: Mode) {
  for (const [k, v] of Object.entries({ ...sharedVars(theme), ...modeVars(theme, mode) })) target.style.setProperty(`--${k}`, v);
}

/**
 * Points the page at the current theme stylesheet. The server injects it on
 * load; after a brand edit the version changes and this swaps it in place.
 */
export function useBrand() {
  const config = useConfig();
  const version = config.data?.brandVersion;
  const firm = config.data?.firmName;
  useEffect(() => {
    if (!version) return;
    const link = document.querySelector<HTMLLinkElement>('link[href^="/brand/theme.css"]');
    const href = `/brand/theme.css?v=${version}`;
    if (link && !link.href.endsWith(href)) link.href = href;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) icon.href = `/brand/icon.svg?v=${version}`;
  }, [version]);
  useEffect(() => {
    document.title = firm || 'Client portal';
  }, [firm]);
  return config;
}

export type ThemePreference = 'light' | 'dark' | 'system';

export function currentPreference(): ThemePreference {
  const v = document.documentElement.getAttribute('data-theme');
  return v === 'light' || v === 'dark' ? v : 'system';
}

/** Stored in a plain cookie so the server can render the right mode on the next load. */
export function setPreference(p: ThemePreference) {
  const root = document.documentElement;
  if (p === 'system') {
    root.removeAttribute('data-theme');
    document.cookie = 'theme=; Path=/; Max-Age=0; SameSite=Lax; Secure';
  } else {
    root.setAttribute('data-theme', p);
    document.cookie = `theme=${p}; Path=/; Max-Age=${400 * 86_400}; SameSite=Lax; Secure`;
  }
}
