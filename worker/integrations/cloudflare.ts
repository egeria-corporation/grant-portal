/**
 * Optional Cloudflare API calls for the wizard (spec §3.3 steps 3–4): create
 * the email DNS records and attach a custom domain. Needs a scoped API token
 * the Owner pastes in (Zone → DNS → Edit, Account → Workers Scripts → Edit);
 * it is stored encrypted and can be removed at any time.
 */
import type { DnsRecord } from '../email/provider';

const API = 'https://api.cloudflare.com/client/v4';

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

export class CloudflareApiError extends Error {
  constructor(
    readonly codes: number[],
    message: string,
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

export interface Zone {
  id: string;
  name: string;
  accountId: string;
}

export class CloudflareApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: CfEnvelope<T>;
    try {
      parsed = (await res.json()) as CfEnvelope<T>;
    } catch {
      throw new CloudflareApiError([], `Cloudflare API ${method} ${path} returned ${res.status}`);
    }
    if (!res.ok || !parsed.success) {
      const errors = parsed.errors ?? [];
      throw new CloudflareApiError(
        errors.map((e) => e.code),
        errors.map((e) => e.message).join('; ') || `Cloudflare API returned ${res.status}`,
      );
    }
    return parsed.result;
  }

  async verifyToken(): Promise<boolean> {
    try {
      const out = await this.call<{ status: string }>('GET', '/user/tokens/verify');
      return out.status === 'active';
    } catch {
      return false;
    }
  }

  /** Finds the zone that hosts `hostname` by trying each parent domain. */
  async findZone(hostname: string): Promise<Zone | null> {
    const labels = hostname.toLowerCase().split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      const name = labels.slice(i).join('.');
      const zones = await this.call<{ id: string; name: string; account: { id: string } }[]>(
        'GET',
        `/zones?name=${encodeURIComponent(name)}`,
      );
      const zone = zones[0];
      if (zone) return { id: zone.id, name: zone.name, accountId: zone.account.id };
    }
    return null;
  }

  /** Creates a DNS record; an identical existing record counts as success. */
  async createDnsRecord(zoneId: string, record: DnsRecord): Promise<'created' | 'exists'> {
    try {
      await this.call('POST', `/zones/${encodeURIComponent(zoneId)}/dns_records`, {
        type: record.type,
        name: record.name,
        content: record.value,
        ttl: 1,
        proxied: false,
        ...(record.priority !== undefined ? { priority: record.priority } : {}),
      });
      return 'created';
    } catch (err) {
      // 81057/81058: an identical record already exists.
      if (err instanceof CloudflareApiError && err.codes.some((c) => c === 81057 || c === 81058)) return 'exists';
      throw err;
    }
  }

  async attachWorkerDomain(p: { accountId: string; zoneId: string; hostname: string; service: string }): Promise<void> {
    await this.call('PUT', `/accounts/${encodeURIComponent(p.accountId)}/workers/domains`, {
      environment: 'production',
      hostname: p.hostname,
      service: p.service,
      zone_id: p.zoneId,
    });
  }
}

/** `my-portal.acme.workers.dev` → `my-portal`; null for any other host. */
export function workerNameFromHost(hostname: string): string | null {
  const m = /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/i.exec(hostname);
  return m?.[1] ?? null;
}
