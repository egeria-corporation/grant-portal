/**
 * Client timeline (spec §5.2): an append-only record of what happened for a
 * client. Rows hold IDs and short labels, never file contents or message text.
 * Writing an event also bumps the client's "last activity" for the client list.
 */
import type { AppEnv } from '../env';
import { newId } from './ids';

export type EventType =
  | 'client.created'
  | 'client.updated'
  | 'client.status_changed'
  | 'client.ein_updated'
  | 'client.ein_revealed'
  | 'client.assignments_changed'
  | 'member.invited'
  | 'member.signed_in'
  | 'file.uploaded'
  | 'file.updated'
  | 'file.deleted'
  | 'request.created'
  | 'request.updated'
  | 'request.item_fulfilled'
  | 'request.item_returned'
  | 'request.completed'
  | 'deliverable.created'
  | 'deliverable.updated'
  | 'deliverable.deleted'
  | 'deliverable.version_added'
  | 'deliverable.approved'
  | 'deliverable.changes_requested'
  | 'message.posted';

export interface EventInput {
  clientId: string;
  actor: string | null;
  type: EventType;
  payload?: Record<string, unknown>;
  at?: number;
}

/** Statements to batch alongside the change they describe. */
export function eventStmts(env: AppEnv, e: EventInput): D1PreparedStatement[] {
  const at = e.at ?? Date.now();
  return [
    env.DB.prepare('INSERT INTO events (id, client_id, actor_user_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      newId('evt'),
      e.clientId,
      e.actor,
      e.type,
      e.payload ? JSON.stringify(e.payload) : null,
      at,
    ),
    env.DB.prepare('UPDATE clients SET last_activity_at = ? WHERE id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)').bind(
      at,
      e.clientId,
      at,
    ),
  ];
}

export async function recordEvent(env: AppEnv, e: EventInput): Promise<void> {
  await env.DB.batch(eventStmts(env, e));
}
