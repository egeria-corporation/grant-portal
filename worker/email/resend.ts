/** Resend adapter (https://resend.com/docs/api-reference). Plain fetch, no SDK. */
import type { DnsRecord, EmailMessage, EmailProvider, SendingDomain } from './provider';
import { EmailProviderError } from './provider';

const API = 'https://api.resend.com';

interface ResendDomain {
  id: string;
  name: string;
  status: string;
  records?: DnsRecord[];
}

function mapStatus(status: string): SendingDomain['status'] {
  if (status === 'verified') return 'verified';
  if (status === 'failed' || status === 'temporary_failure') return 'failed';
  return 'pending';
}

export class ResendProvider implements EmailProvider {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `Resend ${method} ${path} failed with ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        // keep the generic message
      }
      throw new EmailProviderError(res.status, message);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async send(msg: EmailMessage): Promise<{ id: string }> {
    const out = await this.call<{ id: string }>('POST', '/emails', {
      from: msg.from,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      reply_to: msg.replyTo,
      headers: msg.headers,
    });
    return { id: out.id };
  }

  async createDomain(name: string): Promise<SendingDomain> {
    const d = await this.call<ResendDomain>('POST', '/domains', { name });
    return { id: d.id, name: d.name, status: mapStatus(d.status), records: d.records ?? [] };
  }

  async getDomain(id: string): Promise<SendingDomain> {
    const d = await this.call<ResendDomain>('GET', `/domains/${encodeURIComponent(id)}`);
    return { id: d.id, name: d.name, status: mapStatus(d.status), records: d.records ?? [] };
  }

  async verifyDomain(id: string): Promise<void> {
    await this.call('POST', `/domains/${encodeURIComponent(id)}/verify`);
  }
}
