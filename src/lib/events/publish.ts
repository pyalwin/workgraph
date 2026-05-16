/**
 * Workspace event bus — publish side.
 *
 * Mutation routes call emitWorkspaceEvent() after they successfully change
 * state. The /api/events SSE handler tails `workspace_events` per
 * workspace_id and streams new rows to subscribed clients. This replaces
 * the per-page setInterval polling pattern (connector-directory was the
 * worst offender at 2.5s).
 *
 * This module is Mode A: rows live in the DB. A future swap to Upstash
 * Redis or Ably can keep the same emit() signature; only the storage
 * underneath changes.
 *
 * NEVER call this on a hot path that runs for every read. The table is
 * append-only and pruned on a sweep, but every event is one INSERT.
 */

import { getLibsqlDb } from '@/lib/db/libsql';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';

export type WorkspaceEventKind =
  | 'connector.changed'
  | 'agent.status'
  | 'almanac.doc.changed'
  | 'chat.thread.changed';

/**
 * Append one event to the bus. Best-effort — if the DB write fails we log
 * and swallow the error rather than break the calling mutation. Clients
 * will fall back to their initial fetch on reconnect.
 */
export async function emitWorkspaceEvent(
  workspaceId: string,
  kind: WorkspaceEventKind,
  payload?: unknown,
): Promise<void> {
  try {
    await ensureSchemaAsync();
    const db = getLibsqlDb();
    const json = payload === undefined ? null : JSON.stringify(payload);
    await db
      .prepare(
        `INSERT INTO workspace_events (workspace_id, kind, payload) VALUES (?, ?, ?)`,
      )
      .run(workspaceId, kind, json);
  } catch (err) {
    // Producer failures must not break the mutation that triggered them.
    console.warn(
      `[workspace-events] emit ${kind} (ws=${workspaceId}) failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
