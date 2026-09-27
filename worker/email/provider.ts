/**
 * Email adapter interface (spec §9). Resend is the default implementation;
 * Webhook payloads are verified and parsed in ./webhook.ts.
 */
export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface DnsRecord {
  record?: string;
  type: string;
  name: string;
  value: string;
  priority?: number;
  ttl?: string;
  status?: string;
}

export interface SendingDomain {
  id: string;
  name: string;
  status: 'pending' | 'verified' | 'failed';
  records: DnsRecord[];
}

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<{ id: string }>;
  createDomain(name: string): Promise<SendingDomain>;
  getDomain(id: string): Promise<SendingDomain>;
  verifyDomain(id: string): Promise<void>;
  /** Registers a delivery-events webhook; returns its signing secret (spec §7.6). */
  createWebhook(endpoint: string, events: string[]): Promise<{ id: string; signingSecret: string }>;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super('No email provider is configured (RESEND_API_KEY is not set)');
    this.name = 'EmailNotConfiguredError';
  }
}

export class EmailProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EmailProviderError';
  }
}
