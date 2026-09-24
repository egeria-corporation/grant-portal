/**
 * SESSION_SECRET / DATA_ENCRYPTION_KEY with a first-boot fallback (spec §3.2, §7.5).
 *
 * A Worker secret always wins. When it is absent, a key is generated once and
 * stored in KV. KV has no compare-and-set and is eventually consistent, so D1
 * arbitrates which generated key is canonical (INSERT OR IGNORE = first writer
 * wins). Key material stays in KV; D1 holds only the winning key id.
 * See docs/DECISIONS.md D-003.
 */
import { DEFAULT_ORG_ID } from '../db/schema';
import type { AppEnv } from '../env';
import { keyId, randomBytes, toHex } from './crypto';

export type GeneratedSecretName = 'SESSION_SECRET' | 'DATA_ENCRYPTION_KEY';
export const GENERATED_SECRET_NAMES: readonly GeneratedSecretName[] = ['SESSION_SECRET', 'DATA_ENCRYPTION_KEY'];

/** Minimum length for a configured secret. Shorter values are ignored and reported. */
export const MIN_SECRET_LENGTH = 32;

export type SecretSource = 'env' | 'generated';

export interface ResolvedSecret {
  value: string;
  source: SecretSource;
  /** A Worker secret was set but was too short, so it was not used. */
  weakEnvIgnored: boolean;
}

export class SecretUnavailableError extends Error {
  constructor(name: string) {
    super(`${name} is still being initialised; retry shortly`);
    this.name = 'SecretUnavailableError';
  }
}

const settingKey = (name: GeneratedSecretName) => `sys.generated_secret.${name}`;
const kvKey = (name: GeneratedSecretName, id: string) => `sys:genkey:${name}:${id}`;

// Per-isolate cache. Keyed by name; generated keys never change once chosen.
const cache = new Map<GeneratedSecretName, string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readWinningId(env: AppEnv, name: GeneratedSecretName): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value_json FROM settings WHERE org_id = ? AND key = ?')
    .bind(DEFAULT_ORG_ID, settingKey(name))
    .first<{ value_json: string }>();
  if (!row) return null;
  const parsed = JSON.parse(row.value_json) as { id?: unknown };
  return typeof parsed.id === 'string' ? parsed.id : null;
}

async function loadOrCreateGenerated(env: AppEnv, name: GeneratedSecretName): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;

  let winner = await readWinningId(env, name);

  if (!winner) {
    const mine = { id: toHex(randomBytes(16)), value: toHex(randomBytes(32)) };
    // Write key material first so the winner's key is always retrievable.
    await env.KV.put(kvKey(name, mine.id), mine.value);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO settings (org_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)',
    )
      .bind(DEFAULT_ORG_ID, settingKey(name), JSON.stringify({ id: mine.id, createdAt: Date.now() }), Date.now())
      .run();
    winner = await readWinningId(env, name);
    if (!winner) throw new Error(`Failed to record generated ${name}`);
    if (winner === mine.id) {
      console.warn(
        `[setup] ${name} was not set, so a key was generated and stored in KV. ` +
          'Move it to a Worker secret (Settings shows how).',
      );
      cache.set(name, mine.value);
      return mine.value;
    }
    // Lost the race: discard our key, use the winner's.
    await env.KV.delete(kvKey(name, mine.id)).catch(() => undefined);
  }

  // KV reads can lag a write made in another location by up to ~60s.
  for (let attempt = 0; attempt < 5; attempt++) {
    const value = await env.KV.get(kvKey(name, winner));
    if (value) {
      cache.set(name, value);
      return value;
    }
    await sleep(200 * (attempt + 1));
  }
  throw new SecretUnavailableError(name);
}

export async function resolveSecret(env: AppEnv, name: GeneratedSecretName): Promise<ResolvedSecret> {
  const configured = env[name];
  if (configured && configured.length >= MIN_SECRET_LENGTH) {
    return { value: configured, source: 'env', weakEnvIgnored: false };
  }
  const value = await loadOrCreateGenerated(env, name);
  return { value, source: 'generated', weakEnvIgnored: Boolean(configured) };
}

export async function getSecret(env: AppEnv, name: GeneratedSecretName): Promise<string> {
  return (await resolveSecret(env, name)).value;
}

/**
 * All keys that may have encrypted existing data: the configured secret and,
 * if one was ever generated, the generated key. Lets an Owner move a generated
 * key into a Worker secret (or rotate) without orphaning ciphertext.
 */
export async function dataKeys(env: AppEnv): Promise<string[]> {
  const keys: string[] = [];
  const configured = env.DATA_ENCRYPTION_KEY;
  if (configured && configured.length >= MIN_SECRET_LENGTH) keys.push(configured);
  const winner = await readWinningId(env, 'DATA_ENCRYPTION_KEY');
  if (winner) {
    const generated = cache.get('DATA_ENCRYPTION_KEY') ?? (await env.KV.get(kvKey('DATA_ENCRYPTION_KEY', winner)));
    if (generated && !keys.includes(generated)) keys.push(generated);
  }
  return keys;
}

export interface SecretStatus {
  name: GeneratedSecretName;
  source: SecretSource | 'not_initialised';
  weakEnvIgnored: boolean;
  /** Short fingerprint so the Owner can confirm a moved key matches. Never the key. */
  keyId: string | null;
}

/** For the Owner banner. Does not create keys. */
export async function secretsStatus(env: AppEnv): Promise<SecretStatus[]> {
  return Promise.all(
    GENERATED_SECRET_NAMES.map(async (name): Promise<SecretStatus> => {
      const configured = env[name];
      if (configured && configured.length >= MIN_SECRET_LENGTH) {
        return { name, source: 'env', weakEnvIgnored: false, keyId: await keyId(configured) };
      }
      const winner = await readWinningId(env, name);
      const value = winner ? (cache.get(name) ?? (await env.KV.get(kvKey(name, winner)))) : null;
      return {
        name,
        source: winner ? 'generated' : 'not_initialised',
        weakEnvIgnored: Boolean(configured),
        keyId: value ? await keyId(value) : null,
      };
    }),
  );
}

/** Test hook: forget cached keys between isolated test cases. */
export function __resetSecretCache(): void {
  cache.clear();
}
