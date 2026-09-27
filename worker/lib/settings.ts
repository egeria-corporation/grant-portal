/**
 * Typed access to the `settings` table (spec §11). Each key has a Zod schema;
 * reads that fail validation fall back to the default rather than throwing, so
 * a bad row can't take the portal down. Secrets inside settings (API keys,
 * Turnstile secret) are stored AES-GCM encrypted with the data key.
 */
import { DENSITIES, HEADINGS, NEUTRALS, RADII } from '@shared/theme/tokens';
import { z } from 'zod';
import { DEFAULT_ORG_ID } from '../db/schema';
import type { AppEnv } from '../env';
import { decryptField, encryptField } from './crypto';
import { dataKeys, getSecret } from './secrets';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const SETTINGS = {
  setup: z.object({
    status: z.enum(['unclaimed', 'claimed', 'complete']),
    ownerUserId: z.string().optional(),
    claimedAt: z.number().optional(),
    completedAt: z.number().optional(),
    /** Wizard steps the Owner has finished or skipped. */
    steps: z.record(z.string(), z.enum(['done', 'skipped'])).default({}),
  }),
  /** One-time setup code printed to the Worker logs (spec §3.3). Hash only. */
  setup_code: z.object({ hash: z.string(), salt: z.string(), attempts: z.number(), createdAt: z.number() }),
  brand: z.object({
    firmName: z.string().max(80),
    shortName: z.string().max(24).optional(),
    accent: hex,
    welcome: z.string().max(280).optional(),
    neutral: z.enum(NEUTRALS).default('neutral'),
    radius: z.enum(RADII).default('soft'),
    density: z.enum(DENSITIES).default('comfortable'),
    heading: z.enum(HEADINGS).default('sans'),
    /** Optional "Powered by" credit, off by default (spec §8.2). */
    poweredBy: z.boolean().default(false),
  }),
  /** Uploaded brand files in R2 (worker/brand/assets.ts). */
  brand_assets: z.partialRecord(
    z.enum(['logo-light', 'logo-dark', 'mark', 'favicon', 'og', 'font-heading']),
    z.object({ key: z.string(), mime: z.string(), size: z.number(), sha256: z.string(), updatedAt: z.number() }),
  ),
  email: z.object({
    fromName: z.string().max(80).optional(),
    fromLocal: z.string().max(64).optional(),
    domain: z.string().max(253).optional(),
    resendDomainId: z.string().optional(),
    status: z.enum(['none', 'pending', 'verified', 'failed']).default('none'),
    records: z
      .array(
        z.object({
          record: z.string().optional(),
          type: z.string(),
          name: z.string(),
          value: z.string(),
          priority: z.number().optional(),
          ttl: z.string().optional(),
          status: z.string().optional(),
        }),
      )
      .default([]),
    checkedAt: z.number().optional(),
  }),
  security: z.object({
    requirePasskeysForStaff: z.boolean().default(false),
  }),
  turnstile: z.object({ siteKey: z.string().max(100), secretEnc: z.string() }),
  opengrants: z.object({ apiKeyEnc: z.string(), savedAt: z.number() }),
  cloudflare: z.object({ apiTokenEnc: z.string(), savedAt: z.number() }),
  domain: z.object({ hostname: z.string().max(253), status: z.enum(['pending', 'active', 'manual']), updatedAt: z.number() }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]>;

export async function getSetting<K extends SettingKey>(env: AppEnv, key: K): Promise<SettingValue<K> | null> {
  const row = await env.DB.prepare('SELECT value_json FROM settings WHERE org_id = ? AND key = ?')
    .bind(DEFAULT_ORG_ID, key)
    .first<{ value_json: string }>();
  if (!row) return null;
  try {
    const parsed = SETTINGS[key].safeParse(JSON.parse(row.value_json));
    return parsed.success ? (parsed.data as SettingValue<K>) : null;
  } catch {
    return null;
  }
}

export function setSettingStmt<K extends SettingKey>(env: AppEnv, key: K, value: SettingValue<K>): D1PreparedStatement {
  const json = JSON.stringify(SETTINGS[key].parse(value));
  return env.DB.prepare(
    `INSERT INTO settings (org_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (org_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).bind(DEFAULT_ORG_ID, key, json, Date.now());
}

export async function setSetting<K extends SettingKey>(env: AppEnv, key: K, value: SettingValue<K>): Promise<void> {
  await setSettingStmt(env, key, value).run();
}

export async function deleteSetting(env: AppEnv, key: SettingKey): Promise<void> {
  await env.DB.prepare('DELETE FROM settings WHERE org_id = ? AND key = ?').bind(DEFAULT_ORG_ID, key).run();
}

export async function encryptSecretSetting(env: AppEnv, key: SettingKey, plaintext: string): Promise<string> {
  return encryptField(await getSecret(env, 'DATA_ENCRYPTION_KEY'), plaintext, `settings:${key}`);
}

export async function decryptSecretSetting(env: AppEnv, key: SettingKey, ciphertext: string): Promise<string | null> {
  try {
    return await decryptField(await dataKeys(env), ciphertext, `settings:${key}`);
  } catch {
    return null;
  }
}

export const DEFAULT_ACCENT = '#5b4fd6';
