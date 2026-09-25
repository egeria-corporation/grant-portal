import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import worker from '../../worker/index';
import { memoryOutbox } from '../../worker/email/outbox';
import type { AppEnv } from '../../worker/env';
import { randomToken, sha256Hex } from '../../worker/lib/crypto';
import { newId } from '../../worker/lib/ids';

export const ORIGIN = 'https://portal.test';
export const testEnv = env as AppEnv;

/** Calls the Worker's default export the way the edge would. */
export function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(new URL(path, ORIGIN), init));
}

/**
 * A browser-like client: keeps cookies, sends Origin and the double-submit
 * CSRF token on writes, and waits for waitUntil work so emails and session
 * touches have landed before the test looks.
 */
export class Agent {
  cookies = new Map<string, string>();
  ip: string;

  constructor(opts: { ip?: string } = {}) {
    this.ip = opts.ip ?? `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    this.cookies.set('__Host-csrf', 'test-csrf-token');
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async fetch(
    path: string,
    init: { method?: string; json?: unknown; headers?: Record<string, string>; env?: AppEnv; csrf?: boolean } = {},
  ): Promise<Response> {
    const method = init.method ?? (init.json === undefined ? 'GET' : 'POST');
    const headers = new Headers(init.headers);
    headers.set('CF-Connecting-IP', this.ip);
    if (!headers.has('User-Agent')) headers.set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0');
    if (this.cookies.size) headers.set('Cookie', this.cookieHeader());
    if (method !== 'GET' && method !== 'HEAD' && init.csrf !== false) {
      if (!headers.has('Origin')) headers.set('Origin', ORIGIN);
      if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', this.cookies.get('__Host-csrf') ?? '');
    }
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(init.json);
    }
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(new URL(path, ORIGIN), { method, headers, body }), init.env ?? testEnv, ctx);
    await waitOnExecutionContext(ctx);
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq < 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (/max-age=0/i.test(raw) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  post(path: string, json: unknown = {}, init: { env?: AppEnv } = {}) {
    return this.fetch(path, { method: 'POST', json, ...init });
  }
}

export async function resetDb(): Promise<void> {
  memoryOutbox.length = 0;
  const tables = [
    'webauthn_challenges',
    'user_devices',
    'passkeys',
    'sessions',
    'magic_links',
    'client_members',
    'staff_assignments',
    'clients',
    'emails',
    'users',
    'orgs',
  ];
  await testEnv.DB.batch([
    ...tables.map((t) => testEnv.DB.prepare(`DELETE FROM ${t}`)),
    testEnv.DB.prepare("DELETE FROM settings WHERE key NOT LIKE 'sys.%'"),
  ]);
  const keys = await testEnv.KV.list({ prefix: 'rl:' });
  await Promise.all(keys.keys.map((k) => testEnv.KV.delete(k.name)));
}

export type Role = 'owner' | 'consultant' | 'client_admin' | 'client_member';

export async function createUser(role: Role, email = `${role}-${crypto.randomUUID().slice(0, 8)}@example.org`) {
  const id = newId('usr');
  const kind = role === 'owner' || role === 'consultant' ? 'staff' : 'client';
  await testEnv.DB.prepare('INSERT INTO users (id, email, kind, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, email, kind, role, Date.now())
    .run();
  return { id, email, kind, role };
}

export async function createClient(name = 'Acme Org') {
  const id = newId('cli');
  await testEnv.DB.prepare('INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, Date.now()).run();
  return id;
}

export async function addMember(clientId: string, userId: string, role: 'admin' | 'member' = 'admin') {
  await testEnv.DB.prepare('INSERT INTO client_members (client_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
    .bind(clientId, userId, role, Date.now())
    .run();
}

export async function assign(clientId: string, userId: string) {
  await testEnv.DB.prepare('INSERT INTO staff_assignments (client_id, user_id, created_at) VALUES (?, ?, ?)')
    .bind(clientId, userId, Date.now())
    .run();
}

/** Inserts a live session directly and returns an agent carrying its cookie. */
export async function agentFor(userId: string, opts: { stepUp?: boolean; idleMs?: number; absMs?: number } = {}) {
  const raw = randomToken(32);
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO sessions (id_hash, public_id, user_id, created_at, last_seen_at, idle_expires_at, abs_expires_at, step_up_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(raw), newId('ses'), userId, now, now, now + (opts.idleMs ?? 3600_000), now + (opts.absMs ?? 86_400_000), opts.stepUp === false ? null : now)
    .run();
  const agent = new Agent();
  agent.cookies.set('__Host-session', raw);
  return agent;
}

export async function claimAsOwner(email = 'owner@example.org') {
  const owner = await createUser('owner', email);
  await testEnv.DB.prepare(
    "INSERT INTO settings (org_id, key, value_json, updated_at) VALUES ('org_default', 'setup', ?, ?)",
  )
    .bind(JSON.stringify({ status: 'complete', ownerUserId: owner.id, steps: {} }), Date.now())
    .run();
  return owner;
}

export function lastEmailTo(to: string) {
  return [...memoryOutbox].reverse().find((m) => m.to === to);
}

export function tokenFrom(text: string): string {
  const m = /\/auth\/verify\?t=([A-Za-z0-9_-]+)/.exec(text);
  if (!m?.[1]) throw new Error('no link in email');
  return m[1];
}

export function codeFrom(text: string): string {
  const m = /\n(\d{6})\n/.exec(`\n${text}\n`);
  if (!m?.[1]) throw new Error('no code in email');
  return m[1];
}
