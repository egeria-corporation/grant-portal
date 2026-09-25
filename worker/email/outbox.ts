/**
 * Local-only email provider for tests and `npm run dev` without a Resend key.
 * Messages are kept in memory (tests) and in KV under `dev:outbox` (dev/E2E,
 * readable at GET /api/dev/outbox). Never selected in production.
 */
import type { EmailMessage, EmailProvider, SendingDomain } from './provider';

export const memoryOutbox: EmailMessage[] = [];

const OUTBOX_KEY = 'dev:outbox';

export class OutboxProvider implements EmailProvider {
  readonly name = 'outbox';
  private static domains = new Map<string, SendingDomain>();

  constructor(private readonly kv?: KVNamespace) {}

  async send(msg: EmailMessage): Promise<{ id: string }> {
    memoryOutbox.push(msg);
    if (this.kv) {
      const existing = JSON.parse((await this.kv.get(OUTBOX_KEY)) ?? '[]') as EmailMessage[];
      existing.push(msg);
      await this.kv.put(OUTBOX_KEY, JSON.stringify(existing.slice(-50)), { expirationTtl: 86_400 });
      console.log(`[dev email] to=${msg.to} subject="${msg.subject}"\n${msg.text}`);
    }
    return { id: `dev_${crypto.randomUUID()}` };
  }

  async createDomain(name: string): Promise<SendingDomain> {
    const domain: SendingDomain = {
      id: `dev_${crypto.randomUUID()}`,
      name,
      status: 'pending',
      records: [
        { record: 'DKIM', type: 'TXT', name: `resend._domainkey.${name}`, value: 'p=DEVKEY', ttl: 'Auto', status: 'pending' },
        { record: 'SPF', type: 'MX', name: `send.${name}`, value: 'feedback-smtp.example.invalid', priority: 10, ttl: 'Auto', status: 'pending' },
        { record: 'SPF', type: 'TXT', name: `send.${name}`, value: 'v=spf1 include:example.invalid ~all', ttl: 'Auto', status: 'pending' },
      ],
    };
    OutboxProvider.domains.set(domain.id, domain);
    return domain;
  }

  async getDomain(id: string): Promise<SendingDomain> {
    const domain = OutboxProvider.domains.get(id);
    if (!domain) throw new Error('unknown domain');
    return domain;
  }

  /** Dev domains verify on the first check so the wizard can be walked end to end. */
  async verifyDomain(id: string): Promise<void> {
    const domain = OutboxProvider.domains.get(id);
    if (domain) OutboxProvider.domains.set(id, { ...domain, status: 'verified', records: domain.records.map((r) => ({ ...r, status: 'verified' })) });
  }
}

export async function readDevOutbox(kv: KVNamespace): Promise<EmailMessage[]> {
  return JSON.parse((await kv.get(OUTBOX_KEY)) ?? '[]') as EmailMessage[];
}
