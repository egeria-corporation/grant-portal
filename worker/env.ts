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

export type Role = 'owner' | 'consultant' | 'client_admin' | 'client_member';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  kind: 'staff' | 'client';
  role: Role;
  allClients: boolean;
}

export interface AuthSession {
  idHash: string;
  publicId: string;
  createdAt: number;
  stepUpAt: number | null;
  absExpiresAt: number;
}

export interface AuthState {
  user: AuthUser;
  session: AuthSession;
  /** Staff must register a passkey before using the workspace (Owner policy, spec §7.1). */
  needsPasskey: boolean;
}

/** Hono context generics shared by every route module. */
export interface AppBindings {
  Bindings: AppEnv;
  Variables: {
    nonce: string;
    requestId: string;
    /** Set by the session middleware; null when signed out. */
    auth: AuthState | null;
  };
}

export function isDev(env: Pick<AppEnv, 'APP_ENV'>): boolean {
  return import.meta.env.DEV || env.APP_ENV === 'development' || env.APP_ENV === 'test';
}
