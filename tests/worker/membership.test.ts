/**
 * Revoking client access (DECISIONS D-081): removing a client user or changing
 * their role, revoking pending client invites, and archived clients being
 * closed to their users. The old gap: nothing deleted a membership, so a
 * departed employee could sign back in by email and keep full access, even
 * after the client was archived.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../worker/lib/ids';
import { setSetting } from '../../worker/lib/settings';
import { addMember, Agent, agentFor, assign, claimAsOwner, createClient, createUser, lastEmailTo, resetDb, testEnv, tokenFrom } from './helpers';

let clientA: string;
let clientB: string;
let ids: { owner: string; cons: string; adminA: string; memberA: string; adminB: string };
let emails: { memberA: string };

beforeEach(async () => {
  await resetDb();
  const owner = await claimAsOwner();
  await setSetting(testEnv, 'email', { status: 'verified', domain: 'firm.example', fromLocal: 'portal', records: [] });
  clientA = await createClient('A');
  clientB = await createClient('B');
  const cons = await createUser('consultant');
  await assign(clientA, cons.id);
  const adminA = await createUser('client_admin');
  const memberA = await createUser('client_member', 'leaver@clienta.org');
  const adminB = await createUser('client_admin');
  await addMember(clientA, adminA.id, 'admin');
  await addMember(clientA, memberA.id, 'member');
  await addMember(clientB, adminB.id, 'admin');
  ids = { owner: owner.id, cons: cons.id, adminA: adminA.id, memberA: memberA.id, adminB: adminB.id };
  emails = { memberA: memberA.email };
});

const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

async function signInByEmail(email: string): Promise<Agent> {
  const agent = new Agent();
  expect((await agent.post('/auth/magic/request', { email })).status).toBe(202);
  const res = await agent.post('/auth/link/consume', { token: tokenFrom(lastEmailTo(email)?.text ?? '') });
  expect(res.status).toBe(200);
  return agent;
}

async function audits(action: string) {
  return (await testEnv.DB.prepare('SELECT actor_user_id, target, meta_json FROM audit_log WHERE action = ?').bind(action).all<{ actor_user_id: string; target: string; meta_json: string }>()).results;
}

describe('removing a client user', () => {
  it('ends their access at once, and signing back in by email does not restore it', async () => {
    const leaver = await agentFor(ids.memberA);
    expect((await leaver.fetch(`/api/clients/${clientA}`)).status).toBe(200);
    // Things that would keep telling them about the client.
    const feed = await json<{ url: string }>(leaver.post('/api/calendar-feeds', { clientId: clientA }));
    await testEnv.DB.prepare("INSERT INTO notifications (id, user_id, client_id, kind, delivery, created_at) VALUES (?, ?, ?, 'message', 'digest', ?)")
      .bind(newId('ntf'), ids.memberA, clientA, Date.now())
      .run();

    const res = await (await agentFor(ids.cons)).fetch(`/api/clients/${clientA}/members/${ids.memberA}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: 1 });

    // The session they had is gone.
    expect((await leaver.fetch(`/api/clients/${clientA}`)).status).toBe(401);
    // Signing in again by email works (the account stays) but reaches nothing of client A.
    const again = await signInByEmail(emails.memberA);
    expect((await again.fetch(`/api/clients/${clientA}`)).status).toBe(404);
    expect((await json<{ clients: unknown[] }>(again.fetch('/api/portal/home'))).clients).toEqual([]);
    // The calendar feed is revoked, queued digest items are dropped.
    expect((await new Agent().fetch(new URL(feed.url).pathname)).status).toBe(404);
    const pending = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND client_id = ?').bind(ids.memberA, clientA).first<{ n: number }>();
    expect(pending?.n).toBe(0);

    const [entry] = await audits('client.member_removed');
    expect(entry).toMatchObject({ actor_user_id: ids.cons, target: ids.memberA });
    const timeline = await json<{ events: { type: string }[] }>((await agentFor(ids.cons)).fetch(`/api/clients/${clientA}/timeline`));
    expect(timeline.events.map((e) => e.type)).toContain('member.removed');
  });

  it('kills a pending invite to that client, so an old link in their inbox can’t bring them back', async () => {
    // An invite sent before they joined by another route is still live in their inbox.
    const owner = await agentFor(ids.owner);
    await testEnv.DB.prepare('DELETE FROM client_members WHERE user_id = ?').bind(ids.memberA).run();
    expect((await owner.post(`/api/clients/${clientA}/invites`, { email: emails.memberA, role: 'admin', delivery: 'email' })).status).toBe(201);
    const token = tokenFrom(lastEmailTo(emails.memberA)?.text ?? '');
    await addMember(clientA, ids.memberA, 'member');

    expect((await owner.fetch(`/api/clients/${clientA}/members/${ids.memberA}`, { method: 'DELETE' })).status).toBe(200);
    const res = await new Agent().post('/auth/link/consume', { token });
    expect(res.status).toBe(410);
    const back = await testEnv.DB.prepare('SELECT 1 AS ok FROM client_members WHERE client_id = ? AND user_id = ?').bind(clientA, ids.memberA).first();
    expect(back).toBeNull();
  });

  it('client admins manage their own client’s users, but never themselves; members manage nobody', async () => {
    const adminA = await agentFor(ids.adminA);
    const member = await agentFor(ids.memberA);
    expect((await member.fetch(`/api/clients/${clientA}/members/${ids.adminA}`, { method: 'DELETE' })).status).toBe(404);
    expect((await member.fetch(`/api/clients/${clientA}/members/${ids.adminA}`, { method: 'PATCH', json: { role: 'member' } })).status).toBe(404);

    const self = await adminA.fetch(`/api/clients/${clientA}/members/${ids.adminA}`, { method: 'PATCH', json: { role: 'member' } });
    expect(await self.json()).toEqual({ error: 'cannot_change_self' });
    const selfRemove = await adminA.fetch(`/api/clients/${clientA}/members/${ids.adminA}`, { method: 'DELETE' });
    expect(await selfRemove.json()).toEqual({ error: 'cannot_remove_self' });

    // Promote, which signs them out so their next session starts with the new role.
    const promoted = await adminA.fetch(`/api/clients/${clientA}/members/${ids.memberA}`, { method: 'PATCH', json: { role: 'admin' } });
    expect(await promoted.json()).toMatchObject({ ok: true, revoked: 1 });
    expect((await member.fetch(`/api/clients/${clientA}`)).status).toBe(401);
    const row = await testEnv.DB.prepare('SELECT role FROM client_members WHERE client_id = ? AND user_id = ?').bind(clientA, ids.memberA).first<{ role: string }>();
    expect(row?.role).toBe('admin');
    expect(await audits('client.member_role_changed')).toHaveLength(1);

    // Demote and remove.
    expect((await adminA.fetch(`/api/clients/${clientA}/members/${ids.memberA}`, { method: 'PATCH', json: { role: 'member' } })).status).toBe(200);
    expect((await adminA.fetch(`/api/clients/${clientA}/members/${ids.memberA}`, { method: 'DELETE' })).status).toBe(200);
    // Nothing in client B.
    expect((await adminA.fetch(`/api/clients/${clientB}/members/${ids.adminB}`, { method: 'DELETE' })).status).toBe(404);
    expect((await adminA.fetch(`/api/clients/${clientA}/members/${ids.adminB}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('a demoted admin loses admin actions on their very next request', async () => {
    const adminA = await agentFor(ids.adminA);
    // Their session is revoked; even a fresh one only has member rights.
    await (await agentFor(ids.owner)).fetch(`/api/clients/${clientA}/members/${ids.adminA}`, { method: 'PATCH', json: { role: 'member' } });
    expect((await adminA.fetch(`/api/clients/${clientA}/invites`)).status).toBe(401);
    const fresh = await agentFor(ids.adminA);
    expect((await fresh.fetch(`/api/clients/${clientA}/invites`)).status).toBe(404);
    expect((await fresh.post(`/api/clients/${clientA}/invites`, { email: 'x@example.org', role: 'member', delivery: 'email' })).status).toBe(404);
  });
});

describe('pending client invites', () => {
  it('are listed for staff and client admins, and revoking one kills its link', async () => {
    const owner = await agentFor(ids.owner);
    const out = await json<{ link: string }>(owner.post(`/api/clients/${clientA}/invites`, { email: 'new@clienta.org', role: 'admin', delivery: 'link' }));
    const token = new URL(out.link).searchParams.get('t') ?? '';

    const adminA = await agentFor(ids.adminA);
    const list = await json<{ invites: { id: string; email: string; role: string }[] }>(adminA.fetch(`/api/clients/${clientA}/invites`));
    expect(list.invites).toEqual([expect.objectContaining({ email: 'new@clienta.org', role: 'admin' })]);
    expect((await (await agentFor(ids.memberA)).fetch(`/api/clients/${clientA}/invites`)).status).toBe(404);
    expect((await (await agentFor(ids.adminB)).fetch(`/api/clients/${clientA}/invites`)).status).toBe(404);

    const inviteId = list.invites[0]?.id ?? '';
    expect((await adminA.fetch(`/api/clients/${clientA}/invites/${inviteId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await adminA.fetch(`/api/clients/${clientA}/invites/${inviteId}`, { method: 'DELETE' })).status).toBe(404);
    expect((await new Agent().post('/auth/link/peek', { token })).status).toBe(410);
    expect((await new Agent().post('/auth/link/consume', { token })).status).toBe(410);
    expect((await json<{ invites: unknown[] }>(adminA.fetch(`/api/clients/${clientA}/invites`))).invites).toEqual([]);
    expect(await audits('invite.revoked')).toHaveLength(1);
  });

  it('team invites can’t be revoked through a client', async () => {
    const owner = await agentFor(ids.owner);
    await owner.post('/api/team/invites', { email: 'writer@firm.example', delivery: 'link' });
    const team = await testEnv.DB.prepare("SELECT id FROM magic_links WHERE invite_role = 'consultant'").first<{ id: string }>();
    expect((await owner.fetch(`/api/clients/${clientA}/invites/${team?.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('archived clients', () => {
  it('are closed to their users, stay open to staff, and reopen when un-archived', async () => {
    const member = await agentFor(ids.memberA);
    await testEnv.DB.prepare("INSERT INTO deliverables (id, client_id, title, side, status, due_at, created_at) VALUES (?, ?, 'Narrative', 'consultant', 'in_progress', ?, ?)")
      .bind(newId('dlv'), clientA, Date.now() + 7 * 86_400_000, Date.now())
      .run();
    const feed = await json<{ url: string }>(member.post('/api/calendar-feeds', { clientId: clientA }));
    expect(await (await new Agent().fetch(new URL(feed.url).pathname)).text()).toContain('BEGIN:VEVENT');
    const cons = await agentFor(ids.cons);
    expect((await cons.fetch(`/api/clients/${clientA}`, { method: 'PATCH', json: { status: 'archived' } })).status).toBe(200);

    expect((await member.fetch(`/api/clients/${clientA}`)).status).toBe(404);
    expect((await member.fetch(`/api/clients/${clientA}/files`)).status).toBe(404);
    expect((await (await agentFor(ids.adminA)).fetch(`/api/clients/${clientA}/members`)).status).toBe(404);
    // Signing in again by email doesn't help.
    const again = await signInByEmail(emails.memberA);
    expect((await again.fetch(`/api/clients/${clientA}/overview`)).status).toBe(404);
    // Their calendar feed goes quiet.
    const ics = await (await new Agent().fetch(new URL(feed.url).pathname)).text();
    expect(ics).not.toContain('BEGIN:VEVENT');

    // Staff still reach it, can't invite anyone into it, and can un-archive it.
    expect((await cons.fetch(`/api/clients/${clientA}`)).status).toBe(200);
    const invite = await cons.post(`/api/clients/${clientA}/invites`, { email: 'new@clienta.org', role: 'member', delivery: 'link' });
    expect(await invite.json()).toEqual({ error: 'client_archived' });
    expect((await cons.fetch(`/api/clients/${clientA}`, { method: 'PATCH', json: { status: 'active' } })).status).toBe(200);
    expect((await again.fetch(`/api/clients/${clientA}`)).status).toBe(200);
  });

  it('keep file downloads from their users', async () => {
    const fileId = newId('fil');
    const now = Date.now();
    await testEnv.DB.prepare(
      `INSERT INTO files (id, client_id, r2_key, filename, mime, size, upload_status, shared_with_client, uploaded_by, created_at, completed_at)
       VALUES (?, ?, ?, 'budget.pdf', 'application/pdf', 9, 'complete', 1, ?, ?, ?)`,
    )
      .bind(fileId, clientA, `clients/${clientA}/${fileId}`, ids.owner, now, now)
      .run();
    await testEnv.FILES.put(`clients/${clientA}/${fileId}`, '%PDF-1.4\n');
    const member = await agentFor(ids.memberA);
    expect((await member.fetch(`/f/${fileId}`)).status).toBe(200);
    await testEnv.DB.prepare("UPDATE clients SET status = 'archived', archived_at = ? WHERE id = ?").bind(now, clientA).run();
    expect((await member.fetch(`/f/${fileId}`)).status).toBe(404);
    expect((await (await agentFor(ids.cons)).fetch(`/f/${fileId}`)).status).toBe(200);
  });
});
