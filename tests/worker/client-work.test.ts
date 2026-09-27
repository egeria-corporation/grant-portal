/**
 * The M3 client workflow end to end at the API level: profile and EIN,
 * document requests, deliverables with versions and approvals, templates,
 * messages with attachments, the timeline, Today and the portal overview.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addMember, agentFor, assign, claimAsOwner, createClient, createUser, resetDb, testEnv, type Agent } from './helpers';
import { uploadFile } from './files.test';

const PDF = new TextEncoder().encode('%PDF-1.7\n%%EOF\n');
const DAY = 86_400_000;

let clientId: string;
let owner: Agent;
let cons: Agent;
let admin: Agent;
let member: Agent;
let ids: { owner: string; cons: string; admin: string; member: string };

beforeEach(async () => {
  await resetDb();
  const o = await claimAsOwner();
  clientId = await createClient('Acme');
  const c = await createUser('consultant');
  await assign(clientId, c.id);
  const a = await createUser('client_admin');
  const m = await createUser('client_member');
  await addMember(clientId, a.id, 'admin');
  await addMember(clientId, m.id, 'member');
  ids = { owner: o.id, cons: c.id, admin: a.id, member: m.id };
  owner = await agentFor(o.id);
  cons = await agentFor(c.id);
  admin = await agentFor(a.id);
  member = await agentFor(m.id);
});

const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

describe('client profile', () => {
  it('staff edit everything; client admins only org basics, and only when allowed', async () => {
    const r = await cons.fetch(`/api/clients/${clientId}`, {
      method: 'PATCH',
      json: { status: 'active', mission: 'Feed people', focusTags: ['food'], fundingGoals: { targetAmount: 50000, timeline: '2027', types: ['foundation'] } },
    });
    expect(r.status).toBe(200);
    expect((await admin.fetch(`/api/clients/${clientId}`, { method: 'PATCH', json: { mission: 'x' } })).status).toBe(409);
    await cons.fetch(`/api/clients/${clientId}`, { method: 'PATCH', json: { clientCanEdit: true } });
    expect((await admin.fetch(`/api/clients/${clientId}`, { method: 'PATCH', json: { mission: 'Feed more people' } })).status).toBe(200);
    // Not a field client admins may touch, even when editing is on.
    expect((await admin.fetch(`/api/clients/${clientId}`, { method: 'PATCH', json: { status: 'archived' } })).status).toBe(422);
    expect((await member.fetch(`/api/clients/${clientId}`, { method: 'PATCH', json: { mission: 'y' } })).status).toBe(404);

    const seen = await json<{ client: Record<string, unknown> }>(admin.fetch(`/api/clients/${clientId}`));
    expect(seen.client.mission).toBe('Feed more people');
    expect(seen.client).not.toHaveProperty('fundingGoals');
    expect(seen.client).not.toHaveProperty('einLast4');
  });

  it('stores the EIN encrypted, shows the last four, and logs every reveal behind step-up', async () => {
    expect((await cons.fetch(`/api/clients/${clientId}/ein`, { method: 'PUT', json: { ein: '12-3456789' } })).status).toBe(200);
    const row = await testEnv.DB.prepare('SELECT ein_enc, ein_last4 FROM clients WHERE id = ?').bind(clientId).first<{ ein_enc: string; ein_last4: string }>();
    expect(row?.ein_last4).toBe('6789');
    expect(row?.ein_enc).toMatch(/^v1\./);
    expect(row?.ein_enc).not.toContain('3456789');

    const stale = await agentFor(ids.cons, { stepUp: false });
    expect((await stale.post(`/api/clients/${clientId}/ein/reveal`)).status).toBe(403);
    const revealed = await json<{ ein: string }>(cons.post(`/api/clients/${clientId}/ein/reveal`));
    expect(revealed.ein).toBe('12-3456789');
    const audit = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'client.ein_revealed'").first<{ n: number }>();
    expect(audit?.n).toBe(1);
    expect((await cons.fetch(`/api/clients/${clientId}/ein`, { method: 'PUT', json: { ein: '1234' } })).status).toBe(422);
  });

  it('the Owner assigns consultants; the list follows assignments', async () => {
    const other = await createUser('consultant');
    const agent = await agentFor(other.id);
    expect((await json<{ clients: unknown[] }>(agent.fetch('/api/clients'))).clients).toHaveLength(0);
    expect((await owner.fetch(`/api/clients/${clientId}/assignments`, { method: 'PUT', json: { userIds: [other.id] } })).status).toBe(200);
    expect((await json<{ clients: unknown[] }>(agent.fetch('/api/clients'))).clients).toHaveLength(1);
    // The previous consultant lost access.
    expect((await cons.fetch(`/api/clients/${clientId}`)).status).toBe(404);
    // Only consultants can be assigned.
    expect((await owner.fetch(`/api/clients/${clientId}/assignments`, { method: 'PUT', json: { userIds: [ids.admin] } })).status).toBe(422);
  });

  it('archived clients leave the default list', async () => {
    await owner.fetch(`/api/clients/${clientId}`, { method: 'PATCH', json: { status: 'archived' } });
    expect((await json<{ clients: unknown[] }>(owner.fetch('/api/clients'))).clients).toHaveLength(0);
    expect((await json<{ clients: unknown[] }>(owner.fetch('/api/clients?archived=1'))).clients).toHaveLength(1);
  });
});

describe('document requests', () => {
  it('a request becomes a checklist; uploads fulfil it; staff can send an item back', async () => {
    const created = await cons.post(`/api/clients/${clientId}/requests`, {
      title: 'Grant documents',
      dueAt: Date.now() + 7 * DAY,
      items: [{ label: 'Form 990' }, { label: 'W-9' }, { label: 'Logo', required: false }],
    });
    expect(created.status).toBe(201);
    const { requests } = await json<{ requests: { id: string; status: string; reminders: unknown; items: { id: string; label: string }[] }[] }>(
      member.fetch(`/api/clients/${clientId}/requests`),
    );
    const req = requests[0];
    expect(req?.reminders).toEqual({ beforeDays: [3], onDue: true, afterDays: [2] });
    expect(req?.items.map((i) => i.label)).toEqual(['Form 990', 'W-9', 'Logo']);

    for (const item of req?.items.slice(0, 2) ?? []) {
      const up = await uploadFile(member, clientId, `${item.label}.pdf`, PDF);
      expect((await member.fetch(`/api/clients/${clientId}/requests/${req?.id}/items/${item.id}/file`, { method: 'PUT', json: { fileId: up.id } })).status).toBe(200);
    }
    const after = await json<{ requests: { status: string; items: { file: { filename: string } | null }[] }[] }>(owner.fetch(`/api/clients/${clientId}/requests`));
    expect(after.requests[0]?.status).toBe('complete');
    expect(after.requests[0]?.items[0]?.file?.filename).toBe('Form 990.pdf');

    // Clients can't send items back; staff can, which reopens the request.
    const first = req?.items[0]?.id;
    expect((await member.fetch(`/api/clients/${clientId}/requests/${req?.id}/items/${first}/file`, { method: 'DELETE' })).status).toBe(404);
    expect((await cons.fetch(`/api/clients/${clientId}/requests/${req?.id}/items/${first}/file`, { method: 'DELETE' })).status).toBe(200);
    const reopened = await json<{ requests: { status: string }[] }>(owner.fetch(`/api/clients/${clientId}/requests`));
    expect(reopened.requests[0]?.status).toBe('open');

    const types = await testEnv.DB.prepare('SELECT type FROM events WHERE client_id = ? ORDER BY created_at').bind(clientId).all<{ type: string }>();
    expect(types.results.map((t) => t.type)).toEqual(
      expect.arrayContaining(['request.created', 'request.item_fulfilled', 'request.completed', 'request.item_returned']),
    );
  });

  it('cancelled requests disappear for clients and refuse uploads', async () => {
    const { id } = await json<{ id: string }>(cons.post(`/api/clients/${clientId}/requests`, { title: 'x', items: [{ label: 'A' }] }));
    await cons.fetch(`/api/clients/${clientId}/requests/${id}`, { method: 'PATCH', json: { status: 'cancelled' } });
    expect((await json<{ requests: unknown[] }>(member.fetch(`/api/clients/${clientId}/requests`))).requests).toHaveLength(0);
    const { requests } = await json<{ requests: { items: { id: string }[] }[] }>(owner.fetch(`/api/clients/${clientId}/requests`));
    const up = await uploadFile(member, clientId, 'a.pdf', PDF);
    const r = await member.fetch(`/api/clients/${clientId}/requests/${id}/items/${requests[0]?.items[0]?.id}/file`, { method: 'PUT', json: { fileId: up.id } });
    expect(r.status).toBe(409);
  });
});

describe('deliverables', () => {
  async function draft() {
    const { id } = await json<{ id: string }>(cons.post(`/api/clients/${clientId}/deliverables`, { title: 'Budget narrative', side: 'consultant', dueAt: Date.now() + 5 * DAY }));
    const up = await uploadFile(cons, clientId, 'narrative-v1.pdf', PDF);
    const v = await cons.post(`/api/clients/${clientId}/deliverables/${id}/versions`, { fileId: up.id, note: 'First draft' });
    expect(v.status).toBe(201);
    return { id, version: (await v.json()) as { id: string; version: number } };
  }

  it('consultant drafts, client requests changes, v2, client approves; every version is kept', async () => {
    const { id, version } = await draft();
    // The consultant can't approve their own work; clients can't add versions to it.
    expect((await cons.post(`/api/clients/${clientId}/deliverables/${id}/versions/${version.id}/decision`, { decision: 'approved' })).status).toBe(403);
    expect((await admin.post(`/api/clients/${clientId}/deliverables/${id}/versions`, { url: 'https://example.org/x' })).status).toBe(403);
    // Changes need a comment.
    expect((await admin.post(`/api/clients/${clientId}/deliverables/${id}/versions/${version.id}/decision`, { decision: 'changes' })).status).toBe(422);
    expect(
      (await admin.post(`/api/clients/${clientId}/deliverables/${id}/versions/${version.id}/decision`, { decision: 'changes', comment: 'Add the Q3 numbers' })).status,
    ).toBe(200);
    expect((await member.post(`/api/clients/${clientId}/deliverables/${id}/versions/${version.id}/decision`, { decision: 'approved' })).status).toBe(409);

    const v2 = await json<{ id: string; version: number }>(cons.post(`/api/clients/${clientId}/deliverables/${id}/versions`, { url: 'https://docs.example.org/v2' }));
    expect(v2.version).toBe(2);
    // Deciding on an old version is refused.
    expect((await admin.post(`/api/clients/${clientId}/deliverables/${id}/versions/${version.id}/decision`, { decision: 'approved' })).status).toBe(409);
    expect((await member.post(`/api/clients/${clientId}/deliverables/${id}/versions/${v2.id}/decision`, { decision: 'approved' })).status).toBe(200);

    const detail = await json<{ deliverable: { status: string }; versions: { version: number; decisions: { decision: string; comment: string | null }[] }[] }>(
      admin.fetch(`/api/clients/${clientId}/deliverables/${id}`),
    );
    expect(detail.deliverable.status).toBe('approved');
    expect(detail.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(detail.versions[1]?.decisions[0]).toMatchObject({ decision: 'changes', comment: 'Add the Q3 numbers' });
  });

  it('client-side deliverables: the client uploads, staff decide', async () => {
    const { id } = await json<{ id: string }>(cons.post(`/api/clients/${clientId}/deliverables`, { title: 'Signed board list', side: 'client' }));
    const up = await uploadFile(admin, clientId, 'board.pdf', PDF);
    const v = await json<{ id: string }>(admin.post(`/api/clients/${clientId}/deliverables/${id}/versions`, { fileId: up.id }));
    expect((await admin.post(`/api/clients/${clientId}/deliverables/${id}/versions/${v.id}/decision`, { decision: 'approved' })).status).toBe(403);
    expect((await cons.post(`/api/clients/${clientId}/deliverables/${id}/versions/${v.id}/decision`, { decision: 'approved' })).status).toBe(200);
  });

  it('a draft for the client must be a file the client can see', async () => {
    const { id } = await json<{ id: string }>(cons.post(`/api/clients/${clientId}/deliverables`, { title: 'x', side: 'consultant' }));
    const internal = await uploadFile(cons, clientId, 'internal.pdf', PDF, { shared: false });
    expect((await cons.post(`/api/clients/${clientId}/deliverables/${id}/versions`, { fileId: internal.id })).status).toBe(409);
    expect((await cons.post(`/api/clients/${clientId}/deliverables/${id}/versions`, { url: 'http://insecure.example.org' })).status).toBe(422);
    expect((await cons.post(`/api/clients/${clientId}/deliverables/${id}/versions`, { url: 'javascript:alert(1)' })).status).toBe(422);
  });

  it('files used by a deliverable version cannot be deleted', async () => {
    const { id } = await json<{ id: string }>(cons.post(`/api/clients/${clientId}/deliverables`, { title: 'x', side: 'consultant' }));
    const up = await uploadFile(cons, clientId, 'v1.pdf', PDF);
    await cons.post(`/api/clients/${clientId}/deliverables/${id}/versions`, { fileId: up.id });
    expect((await owner.fetch(`/api/clients/${clientId}/files/${up.id}`, { method: 'DELETE' })).status).toBe(409);
  });

  it('templates create deliverables with due dates relative to an anchor', async () => {
    const tpl = await json<{ id: string }>(
      owner.post('/api/templates', {
        name: 'Federal application',
        items: [
          { title: 'Budget narrative', side: 'consultant', offsetDays: -14 },
          { title: 'Letters of support', side: 'client', offsetDays: -21 },
          { title: 'Submit', side: 'consultant', offsetDays: 0 },
        ],
      }),
    );
    const anchor = Date.UTC(2027, 2, 31);
    const made = await json<{ ids: string[] }>(cons.post(`/api/clients/${clientId}/deliverables/from-template`, { templateId: tpl.id, anchorAt: anchor }));
    expect(made.ids).toHaveLength(3);
    const list = await json<{ deliverables: { title: string; dueAt: number; side: string }[] }>(member.fetch(`/api/clients/${clientId}/deliverables`));
    expect(list.deliverables.map((d) => [d.title, (d.dueAt - anchor) / DAY, d.side])).toEqual([
      ['Letters of support', -21, 'client'],
      ['Budget narrative', -14, 'consultant'],
      ['Submit', 0, 'consultant'],
    ]);
  });

  it('assignees must belong to the client', async () => {
    const stranger = await createUser('client_admin');
    expect((await cons.post(`/api/clients/${clientId}/deliverables`, { title: 'x', side: 'client', assigneeUserId: stranger.id })).status).toBe(422);
    expect((await cons.post(`/api/clients/${clientId}/deliverables`, { title: 'x', side: 'client', assigneeUserId: ids.member })).status).toBe(201);
  });
});

describe('messages', () => {
  it('a shared thread with attachments and unread counts on both sides', async () => {
    const up = await uploadFile(admin, clientId, 'question.pdf', PDF);
    expect((await admin.post(`/api/clients/${clientId}/messages`, { body: 'Is this the right 990?', attachments: [up.id] })).status).toBe(201);
    const overview = await json<{ unreadMessages: number }>(cons.fetch(`/api/clients/${clientId}/overview`));
    expect(overview.unreadMessages).toBe(1);
    const today = await json<{ messages: { preview: string }[]; uploads: unknown[] }>(cons.fetch('/api/today'));
    expect(today.messages[0]?.preview).toBe('Is this the right 990?');
    expect(today.uploads).toHaveLength(1);

    const thread = await json<{ messages: { body: string; attachments: { filename: string }[]; mine: boolean }[] }>(cons.fetch(`/api/clients/${clientId}/messages`));
    expect(thread.messages[0]).toMatchObject({ body: 'Is this the right 990?', mine: false });
    expect(thread.messages[0]?.attachments[0]?.filename).toBe('question.pdf');
    await cons.post(`/api/clients/${clientId}/messages/read`, {});
    expect((await json<{ unreadMessages: number }>(cons.fetch(`/api/clients/${clientId}/overview`))).unreadMessages).toBe(0);

    await cons.post(`/api/clients/${clientId}/messages`, { body: 'Yes, <b>thanks</b>' });
    const forMember = await json<{ unreadMessages: number; latestFromConsultant: { body: string } }>(member.fetch(`/api/clients/${clientId}/overview`));
    expect(forMember.unreadMessages).toBe(2);
    // Stored and returned as text; the UI never renders it as HTML.
    expect(forMember.latestFromConsultant.body).toBe('Yes, <b>thanks</b>');
  });

  it('deliverable threads are separate', async () => {
    const { id } = await json<{ id: string }>(cons.post(`/api/clients/${clientId}/deliverables`, { title: 'x', side: 'consultant' }));
    await admin.post(`/api/clients/${clientId}/messages`, { body: 'On the draft', thread: id });
    expect((await json<{ messages: unknown[] }>(cons.fetch(`/api/clients/${clientId}/messages`))).messages).toHaveLength(0);
    expect((await json<{ messages: unknown[] }>(cons.fetch(`/api/clients/${clientId}/messages?thread=${id}`))).messages).toHaveLength(1);
    expect((await cons.fetch(`/api/clients/${clientId}/messages?thread=nope`)).status).toBe(404);
  });
});

describe('timeline, Today and the portal', () => {
  it('records activity with actors and no content', async () => {
    await admin.post(`/api/clients/${clientId}/messages`, { body: 'secret plans' });
    const { events } = await json<{ events: { type: string; actor: { kind: string }; payload: Record<string, unknown> }[] }>(
      cons.fetch(`/api/clients/${clientId}/timeline`),
    );
    expect(events[0]).toMatchObject({ type: 'message.posted', actor: { kind: 'client' } });
    expect(JSON.stringify(events)).not.toContain('secret plans');
  });

  it('Today lists what is due soon and which clients need attention', async () => {
    await cons.post(`/api/clients/${clientId}/requests`, { title: 'Overdue docs', dueAt: Date.now() - DAY, items: [{ label: 'A' }] });
    await cons.post(`/api/clients/${clientId}/deliverables`, { title: 'Due soon', side: 'consultant', dueAt: Date.now() + 2 * DAY });
    await cons.post(`/api/clients/${clientId}/deliverables`, { title: 'Far away', side: 'consultant', dueAt: Date.now() + 30 * DAY });
    const today = await json<{ deadlines: { title: string }[]; needsAttention: { id: string; overdueRequests: number }[] }>(cons.fetch('/api/today'));
    expect(today.deadlines.map((d) => d.title)).toEqual(['Overdue docs', 'Due soon']);
    expect(today.needsAttention[0]).toMatchObject({ id: clientId, overdueRequests: 1 });
    // An unassigned consultant sees nothing.
    const other = await agentFor((await createUser('consultant')).id);
    expect((await json<{ deadlines: unknown[] }>(other.fetch('/api/today'))).deadlines).toHaveLength(0);
  });

  it('the portal home counts what the client needs to do', async () => {
    await cons.post(`/api/clients/${clientId}/requests`, { title: 'Docs', items: [{ label: 'A' }, { label: 'B' }] });
    const { id } = await json<{ id: string }>(cons.post(`/api/clients/${clientId}/deliverables`, { title: 'Draft', side: 'consultant' }));
    await cons.post(`/api/clients/${clientId}/deliverables/${id}/versions`, { url: 'https://docs.example.org/1' });
    const home = await json<{ clients: { id: string; openItems: number; awaitingYou: number }[] }>(member.fetch('/api/portal/home'));
    expect(home.clients[0]).toMatchObject({ id: clientId, openItems: 2, awaitingYou: 1 });
    const overview = await json<{ openItems: unknown[]; awaitingDecision: { title: string }[] }>(member.fetch(`/api/clients/${clientId}/overview`));
    expect(overview.openItems).toHaveLength(2);
    expect(overview.awaitingDecision[0]?.title).toBe('Draft');
  });

  it('client admins invite colleagues by email only; members cannot invite', async () => {
    expect((await member.post(`/api/clients/${clientId}/invites`, { email: 'x@example.org', role: 'member', delivery: 'email' })).status).toBe(404);
    const link = await admin.post(`/api/clients/${clientId}/invites`, { email: 'x@example.org', role: 'member', delivery: 'link' });
    expect(link.status).toBe(403);
    const members = await json<{ members: { activeSessions?: number }[] }>(member.fetch(`/api/clients/${clientId}/members`));
    expect(members.members).toHaveLength(2);
    expect(members.members[0]?.activeSessions).toBeUndefined();
  });
});
