import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../worker/env';
import {
  __resetSecretCache,
  dataKeys,
  MIN_SECRET_LENGTH,
  resolveSecret,
  secretsStatus,
} from '../../worker/lib/secrets';

const base = env as AppEnv;
const withSecrets = (extra: Partial<AppEnv>): AppEnv => ({ ...base, ...extra });

beforeEach(async () => {
  __resetSecretCache();
  await base.DB.prepare("DELETE FROM settings WHERE key LIKE 'sys.generated_secret.%'").run();
});

describe('generated secret fallback', () => {
  it('generates a 256-bit key on first use and reuses it', async () => {
    const first = await resolveSecret(base, 'SESSION_SECRET');
    expect(first.source).toBe('generated');
    expect(first.value).toMatch(/^[0-9a-f]{64}$/);
    __resetSecretCache(); // simulate a new isolate
    const second = await resolveSecret(base, 'SESSION_SECRET');
    expect(second.value).toBe(first.value);
  });

  it('converges on one key when isolates race on first boot', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        __resetSecretCache();
        return (await resolveSecret(base, 'DATA_ENCRYPTION_KEY')).value;
      }),
    );
    expect(new Set(results).size).toBe(1);
    // Losers clean up their KV entries: exactly one key remains stored.
    const stored = await base.KV.list({ prefix: 'sys:genkey:DATA_ENCRYPTION_KEY:' });
    expect(stored.keys).toHaveLength(1);
  });

  it('keeps key material out of D1 (only the winning id is stored)', async () => {
    const { value } = await resolveSecret(base, 'SESSION_SECRET');
    const rows = await base.DB.prepare('SELECT value_json FROM settings').all<{ value_json: string }>();
    for (const row of rows.results) expect(row.value_json).not.toContain(value);
  });

  it('prefers a configured Worker secret', async () => {
    const configured = 'x'.repeat(MIN_SECRET_LENGTH);
    const res = await resolveSecret(withSecrets({ SESSION_SECRET: configured }), 'SESSION_SECRET');
    expect(res).toEqual({ value: configured, source: 'env', weakEnvIgnored: false });
  });

  it('ignores (and reports) a configured secret that is too short', async () => {
    const res = await resolveSecret(withSecrets({ SESSION_SECRET: 'short' }), 'SESSION_SECRET');
    expect(res.source).toBe('generated');
    expect(res.weakEnvIgnored).toBe(true);
  });

  it('keeps the generated data key usable after a Worker secret is added', async () => {
    const generated = (await resolveSecret(base, 'DATA_ENCRYPTION_KEY')).value;
    const configured = 'k'.repeat(40);
    const keys = await dataKeys(withSecrets({ DATA_ENCRYPTION_KEY: configured }));
    expect(keys).toEqual([configured, generated]);
  });

  it('status reports source and a fingerprint, never the key', async () => {
    expect((await secretsStatus(base)).map((s) => s.source)).toEqual(['not_initialised', 'not_initialised']);
    const { value } = await resolveSecret(base, 'SESSION_SECRET');
    const status = await secretsStatus(base);
    expect(status[0]).toMatchObject({ name: 'SESSION_SECRET', source: 'generated' });
    expect(status[0]?.keyId).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(status)).not.toContain(value);
  });
});
