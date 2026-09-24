/**
 * Worker environment: bindings and vars come from wrangler.jsonc (generated
 * into worker-configuration.d.ts by `npm run cf-typegen`); secrets are declared
 * here because they are optional and never present at build time.
 */
export interface Secrets {
  /** Required for email. Sign-in links and client email. */
  RESEND_API_KEY?: string;
  /** Optional; generated on first boot when absent (worker/lib/secrets.ts). */
  SESSION_SECRET?: string;
  /** Optional; generated on first boot when absent (worker/lib/secrets.ts). */
  DATA_ENCRYPTION_KEY?: string;
  /** Optional. Enables funding discovery. */
  OPENGRANTS_API_KEY?: string;
  /** Optional advanced overrides; normally configured in the wizard (DECISIONS D-002). */
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
}

export type AppEnv = Env & Secrets;

/** Hono context generics shared by every route module. */
export interface AppBindings {
  Bindings: AppEnv;
  Variables: {
    nonce: string;
    requestId: string;
  };
}

export function isDev(env: Pick<AppEnv, 'APP_ENV'>): boolean {
  return import.meta.env.DEV || env.APP_ENV === 'development' || env.APP_ENV === 'test';
}
