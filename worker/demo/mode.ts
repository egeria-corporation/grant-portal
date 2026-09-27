/**
 * Demo mode (PLAN M6, DECISIONS D-077), for a public "try it" deployment.
 * Off unless the `DEMO_MODE` var is "1". When on:
 * - visitors can enter as a demo consultant or a demo client user without
 *   email (POST /api/demo-mode/session), both on fictional data, and both
 *   read-only (spec §14 "a public read-only demo instance");
 * - no email reaches anyone except the Owner's own sign-in mail;
 * - invites are refused, uploads are capped at 2 MiB;
 * - every night the clients and demo accounts are wiped and re-seeded.
 * Never turn it on for a real consultancy: anyone can read what demo users see.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppBindings, AppEnv } from '../env';
import { loadDemo } from '../api/demo';
import { deleteClient } from '../api/data';
import { newId } from '../lib/ids';
import { getSetting } from '../lib/settings';

export const DEMO_CONSULTANT = 'consultant@demo.invalid';
export const DEMO_CLIENT = 'client@demo.invalid';
export const DEMO_MAX_UPLOAD = 2 * 1024 * 1024;

export function demoMode(env: AppEnv): boolean {
  return env.DEMO_MODE === '1' || env.DEMO_MODE === 'true';
}

async function ensureUser(env: AppEnv, email: string, kind: 'staff' | 'client', role: string, name: string): Promise<string> {
  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  if (row) return row.id;
  const id = newId('usr');
  await env.DB.prepare('INSERT INTO users (id, email, name, kind, role, all_clients, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, email, name, kind, role, kind === 'staff' ? 1 : 0, Date.now())
    .run();
  return id;
}

/** The demo accounts and the sample client, created if missing. Null until the portal is claimed. */
export async function ensureDemo(env: AppEnv): Promise<{ consultantId: string; clientUserId: string; clientId: string } | null> {
  const setup = await getSetting(env, 'setup');
  if (!setup?.ownerUserId || setup.status === 'unclaimed') return null;
  const consultantId = await ensureUser(env, DEMO_CONSULTANT, 'staff', 'consultant', 'Demo Consultant');
  const clientUserId = await ensureUser(env, DEMO_CLIENT, 'client', 'client_admin', 'Demo Client');
  const clientId = await loadDemo(env, setup.ownerUserId);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO client_members (client_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)").bind(clientId, clientUserId, Date.now()),
    env.DB.prepare('INSERT OR IGNORE INTO staff_assignments (client_id, user_id, created_at) VALUES (?, ?, ?)').bind(clientId, consultantId, Date.now()),
  ]);
  return { consultantId, clientUserId, clientId };
}

/** Nightly: every client (and its files) goes, demo accounts are signed out, and the sample is re-seeded. */
export async function resetDemo(env: AppEnv): Promise<void> {
  if (!demoMode(env)) return;
  const clients = await env.DB.prepare('SELECT id FROM clients').all<{ id: string }>();
  for (const c of clients.results) await deleteClient(env, c.id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE ?)').bind('%@demo.invalid'),
    env.DB.prepare('DELETE FROM calendar_feeds WHERE user_id IN (SELECT id FROM users WHERE email LIKE ?)').bind('%@demo.invalid'),
    env.DB.prepare('DELETE FROM deliverable_templates'),
  ]);
  await ensureDemo(env);
}

/** Demo accounts can look but not change anything (spec §14). Signing out and switching demo roles still work. */
export const demoReadOnly: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get('auth');
  const method = c.req.method;
  if (
    demoMode(c.env) &&
    auth?.user.email.endsWith('@demo.invalid') &&
    method !== 'GET' &&
    method !== 'HEAD' &&
    !['/auth/signout', '/api/demo-mode/session'].includes(new URL(c.req.url).pathname)
  ) {
    return c.json({ error: 'demo_read_only' }, 403);
  }
  await next();
};
