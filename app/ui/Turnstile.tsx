/**
 * Turnstile widget (spec §7.1). Loaded only when the Owner configured a site
 * key. The script tag carries the page's CSP nonce ('strict-dynamic' also
 * allows it because a trusted script inserts it).
 */
import { useEffect, useRef } from 'react';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce;
    if (nonce) s.nonce = nonce;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')));
    s.onerror = () => reject(new Error('turnstile failed to load'));
    document.head.appendChild(s);
  });
  return loading;
}

export function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (token: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  useEffect(() => {
    cb.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let id: string | undefined;
    let api: TurnstileApi | undefined;
    let cancelled = false;
    loadScript()
      .then((t) => {
        if (cancelled || !ref.current) return;
        api = t;
        id = t.render(ref.current, {
          sitekey: siteKey,
          appearance: 'interaction-only',
          callback: (token: string) => cb.current(token),
          'expired-callback': () => cb.current(null),
          'error-callback': () => cb.current(null),
        });
      })
      .catch(() => cb.current(null));
    return () => {
      cancelled = true;
      if (api && id) api.remove(id);
    };
  }, [siteKey]);

  return <div ref={ref} className="min-h-0" />;
}
