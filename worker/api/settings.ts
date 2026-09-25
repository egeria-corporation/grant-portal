/**
 * Owner settings used by the wizard (spec §3.3, §5.9): brand basics, email
 * sender, Cloudflare token, custom domain, OpenGrants key, Turnstile, and
 * security policy. Everything here is Owner-only; security-sensitive changes
 * also need a recent step-up.
 */
import { checkAccent } from '@shared/contrast';
import { Hono } from 'hono';
import { z } from 'zod';
import { authOf, requireOwner, requireStepUp } from '../auth/guards';
import { emailProvider, sender } from '../email';
import { EmailNotConfiguredError, EmailProviderError, type DnsRecord } from '../email/provider';
import type { AppBindings, AppEnv } from '../env';
import { CloudflareApi, CloudflareApiError, workerNameFromHost } from '../integrations/cloudflare';
import { audit } from '../lib/audit';
import { HttpError, parseJson } from '../lib/http';
import {
  decryptSecretSetting,
  DEFAULT_ACCENT,
  deleteSetting,
  encryptSecretSetting,
  getSetting,
  setSetting,
} from '../lib/settings';
import { turnstileConfig } from '../lib/turnstile';

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'hostname');

async function cloudflare(env: AppEnv): Promise<CloudflareApi | null> {
  const stored = await getSetting(env, 'cloudflare');
  if (!stored) return null;
  const token = await decryptSecretSetting(env, 'cloudflare', stored.apiTokenEnc);
  return token ? new CloudflareApi(token) : null;
}

function fqdn(name: string, domain: string): string {
  if (name === '@' || name === '') return domain;
  return name === domain || name.endsWith(`.${domain}`) ? name : `${name}.${domain}`;
}

/** Resend supplies DKIM/SPF/MX; we add a starter DMARC record (spec §7.6). */
function withDmarc(records: DnsRecord[], domain: string): DnsRecord[] {
  if (records.some((r) => /_dmarc/i.test(r.name))) return records;
  return [...records, { record: 'DMARC', type: 'TXT', name: `_dmarc.${domain}`, value: 'v=DMARC1; p=none;', ttl: 'Auto', status: 'recommended' }];
}

function providerError(err: unknown): never {
  if (err instanceof EmailNotConfiguredError) throw new HttpError(503, 'email_not_configured');
  if (err instanceof EmailProviderError) throw new HttpError(422, 'email_provider_error', { message: err.message });
  throw err;
}

export const settingsApi = new Hono<AppBindings>()
  .use('*', requireOwner)

  /** One call for the wizard's final checklist and the Owner notices. */
  .get('/overview', async (c) => {
    const [brand, email, domain, og, cf, ts, security, from] = await Promise.all([
      getSetting(c.env, 'brand'),
      getSetting(c.env, 'email'),
      getSetting(c.env, 'domain'),
      getSetting(c.env, 'opengrants'),
      getSetting(c.env, 'cloudflare'),
      turnstileConfig(c.env),
      getSetting(c.env, 'security'),
      sender(c.env),
    ]);
    return c.json({
      brand: brand ?? { firmName: '', accent: DEFAULT_ACCENT },
      email: { status: email?.status ?? 'none', domain: email?.domain ?? null, from: from.from, verified: from.verified },
      domain: domain ?? null,
      opengrants: { configured: Boolean(c.env.OPENGRANTS_API_KEY) || Boolean(og), source: c.env.OPENGRANTS_API_KEY ? 'env' : og ? 'settings' : null },
      cloudflareToken: Boolean(cf),
      turnstile: { configured: Boolean(ts), source: ts?.source ?? null, siteKey: ts?.siteKey ?? null },
      security: { requirePasskeysForStaff: security?.requirePasskeysForStaff ?? false },
      workerName: workerNameFromHost(new URL(c.req.url).hostname),
    });
  })

  .put('/brand', async (c) => {
    const body = await parseJson(
      c,
      z.object({
        firmName: z.string().trim().min(1).max(80),
        shortName: z.string().trim().max(24).optional(),
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        welcome: z.string().trim().max(280).optional(),
      }),
    );
    const check = checkAccent(body.accent);
    if (!check?.passesAA) throw new HttpError(422, 'accent_contrast', { ratio: check?.ratio ?? 0 });
    await setSetting(c.env, 'brand', { ...body, accent: body.accent.toLowerCase() });
    await c.env.DB.prepare("UPDATE orgs SET name = ? WHERE id = 'org_default'").bind(body.firmName).run();
    await audit(c, { action: 'settings.updated', target: 'brand' });
    return c.json({ ok: true, contrast: check });
  })

  .get('/email', async (c) => {
    const email = await getSetting(c.env, 'email');
    return c.json({ email: email ?? { status: 'none', records: [] }, sender: await sender(c.env) });
  })

  /** Creates (or re-reads) the sending domain in Resend and stores its DNS records. */
  .put('/email', async (c) => {
    const body = await parseJson(
      c,
      z.object({
        fromName: z.string().trim().max(80).optional(),
        fromLocal: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{1,64}$/),
        domain: hostname,
      }),
    );
    const current = await getSetting(c.env, 'email');
    let domainId = current?.domain === body.domain ? current.resendDomainId : undefined;
    let records: DnsRecord[] = current?.domain === body.domain ? (current.records ?? []) : [];
    let status: 'pending' | 'verified' | 'failed' = current?.domain === body.domain && current.status !== 'none' ? current.status : 'pending';
    if (!domainId) {
      try {
        const created = await emailProvider(c.env).createDomain(body.domain);
        domainId = created.id;
        records = created.records.map((r) => ({ ...r, name: fqdn(r.name, body.domain) }));
        status = created.status;
      } catch (err) {
        providerError(err);
      }
    }
    await setSetting(c.env, 'email', {
      fromName: body.fromName,
      fromLocal: body.fromLocal,
      domain: body.domain,
      resendDomainId: domainId,
      status,
      records: withDmarc(records, body.domain),
      checkedAt: Date.now(),
    });
    await audit(c, { action: 'settings.updated', target: 'email' });
    return c.json({ email: await getSetting(c.env, 'email') });
  })

  /** Asks Resend to check DNS now, then reads the result. The SPA polls this. */
  .post('/email/verify', async (c) => {
    const current = await getSetting(c.env, 'email');
    if (!current?.resendDomainId || !current.domain) throw new HttpError(409, 'no_domain');
    try {
      const provider = emailProvider(c.env);
      await provider.verifyDomain(current.resendDomainId);
      const d = await provider.getDomain(current.resendDomainId);
      const records = d.records.map((r) => ({ ...r, name: fqdn(r.name, current.domain ?? '') }));
      await setSetting(c.env, 'email', {
        ...current,
        status: d.status,
        records: withDmarc(records.length ? records : current.records, current.domain),
        checkedAt: Date.now(),
      });
    } catch (err) {
      providerError(err);
    }
    return c.json({ email: await getSetting(c.env, 'email') });
  })

  /** One-click DNS: creates the Resend records in the Cloudflare zone. */
  .post('/email/cloudflare-dns', async (c) => {
    const current = await getSetting(c.env, 'email');
    if (!current?.domain || !current.records.length) throw new HttpError(409, 'no_domain');
    const api = await cloudflare(c.env);
    if (!api) throw new HttpError(409, 'no_cloudflare_token');
    try {
      const zone = await api.findZone(current.domain);
      if (!zone) throw new HttpError(422, 'zone_not_found');
      const results = [];
      for (const record of current.records) {
        results.push({ name: record.name, type: record.type, result: await api.createDnsRecord(zone.id, record) });
      }
      await audit(c, { action: 'settings.updated', target: 'email.dns' });
      return c.json({ zone: zone.name, results });
    } catch (err) {
      if (err instanceof CloudflareApiError) throw new HttpError(422, 'cloudflare_error', { message: err.message });
      throw err;
    }
  })

  .put('/cloudflare-token', async (c) => {
    const body = await parseJson(c, z.object({ token: z.string().trim().min(20).max(200) }));
    if (!(await new CloudflareApi(body.token).verifyToken())) throw new HttpError(422, 'token_invalid');
    await setSetting(c.env, 'cloudflare', {
      apiTokenEnc: await encryptSecretSetting(c.env, 'cloudflare', body.token),
      savedAt: Date.now(),
    });
    await audit(c, { action: 'settings.updated', target: 'cloudflare_token' });
    return c.json({ ok: true });
  })

  .delete('/cloudflare-token', async (c) => {
    await deleteSetting(c.env, 'cloudflare');
    await audit(c, { action: 'settings.updated', target: 'cloudflare_token.removed' });
    return c.json({ ok: true });
  })

  /**
   * Custom domain (spec §3.3 step 4). With a Cloudflare token it's attached
   * automatically; without one, it's recorded and the wizard shows the steps.
   */
  .put('/domain', async (c) => {
    const body = await parseJson(c, z.object({ hostname, service: z.string().regex(/^[a-z0-9-]{1,63}$/).optional() }));
    const api = await cloudflare(c.env);
    let status: 'active' | 'manual' = 'manual';
    if (api) {
      const service = body.service ?? workerNameFromHost(new URL(c.req.url).hostname);
      if (!service) throw new HttpError(422, 'service_required');
      try {
        const zone = await api.findZone(body.hostname);
        if (!zone) throw new HttpError(422, 'zone_not_found');
        await api.attachWorkerDomain({ accountId: zone.accountId, zoneId: zone.id, hostname: body.hostname, service });
        status = 'active';
      } catch (err) {
        if (err instanceof CloudflareApiError) throw new HttpError(422, 'cloudflare_error', { message: err.message });
        throw err;
      }
    }
    await setSetting(c.env, 'domain', { hostname: body.hostname, status, updatedAt: Date.now() });
    await audit(c, { action: 'settings.updated', target: 'domain' });
    return c.json({ domain: await getSetting(c.env, 'domain') });
  })

  /** Stored encrypted (spec §10.3). Not validated here: every call spends the daily request budget. */
  .put('/opengrants', async (c) => {
    const body = await parseJson(c, z.object({ apiKey: z.string().trim().min(8).max(512) }));
    await setSetting(c.env, 'opengrants', {
      apiKeyEnc: await encryptSecretSetting(c.env, 'opengrants', body.apiKey),
      savedAt: Date.now(),
    });
    await audit(c, { action: 'settings.updated', target: 'opengrants' });
    return c.json({ ok: true });
  })

  .delete('/opengrants', async (c) => {
    await deleteSetting(c.env, 'opengrants');
    await audit(c, { action: 'settings.updated', target: 'opengrants.removed' });
    return c.json({ ok: true });
  })

  .put('/turnstile', requireStepUp(), async (c) => {
    const body = await parseJson(
      c,
      z.object({ siteKey: z.string().trim().min(10).max(100), secret: z.string().trim().min(10).max(200) }),
    );
    await setSetting(c.env, 'turnstile', {
      siteKey: body.siteKey,
      secretEnc: await encryptSecretSetting(c.env, 'turnstile', body.secret),
    });
    await audit(c, { action: 'settings.updated', target: 'turnstile' });
    return c.json({ ok: true });
  })

  .delete('/turnstile', requireStepUp(), async (c) => {
    await deleteSetting(c.env, 'turnstile');
    await audit(c, { action: 'settings.updated', target: 'turnstile.removed' });
    return c.json({ ok: true });
  })

  .put('/security', requireStepUp(), async (c) => {
    const body = await parseJson(c, z.object({ requirePasskeysForStaff: z.boolean() }));
    if (body.requirePasskeysForStaff) {
      // Don't let the Owner lock themselves into an enrollment gate by accident.
      const own = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?')
        .bind(authOf(c).user.id)
        .first<{ n: number }>();
      if (!own?.n) throw new HttpError(409, 'register_passkey_first');
    }
    await setSetting(c.env, 'security', body);
    await audit(c, { action: 'settings.updated', target: 'security', meta: body });
    return c.json({ ok: true });
  });
