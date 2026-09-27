/**
 * Owner security policy (spec §5.9 Security, §7.1): staff email-domain
 * restriction, staff IP allowlist, session lengths, sign-in link lifetime and
 * data retention. Stored in settings `security`; absent fields take defaults,
 * which are the behaviour before the settings existed.
 */
import type { AppEnv } from '../env';
import { ipInList } from './cidr';
import { getSetting, SETTINGS } from './settings';

export type SecurityPolicy = ReturnType<(typeof SETTINGS)['security']['parse']>;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export async function securityPolicy(env: AppEnv): Promise<SecurityPolicy> {
  return (await getSetting(env, 'security')) ?? SETTINGS.security.parse({});
}

export function sessionLimits(p: SecurityPolicy, kind: 'staff' | 'client'): { idleMs: number; absMs: number } {
  return kind === 'staff' ? { idleMs: p.staffIdleHours * HOUR, absMs: p.staffMaxDays * DAY } : { idleMs: p.clientIdleDays * DAY, absMs: p.clientMaxDays * DAY };
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** A domain entry matches itself and its subdomains. */
export function staffEmailAllowed(p: SecurityPolicy, email: string): boolean {
  if (!p.staffEmailDomains.length) return true;
  const d = emailDomain(email);
  return p.staffEmailDomains.some((allowed) => d === allowed || d.endsWith(`.${allowed}`));
}

export function staffIpAllowed(p: SecurityPolicy, ip: string): boolean {
  return !p.staffIpAllowlist.length || ipInList(ip, p.staffIpAllowlist);
}
