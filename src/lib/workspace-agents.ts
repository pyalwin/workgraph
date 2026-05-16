import { ensureSchemaAsync } from './db/init-schema-async';
import { getLibsqlDb } from './db/libsql';

/**
 * Paired local-agent install for a user. The agent ships as @workgraph/agent
 * (npm) and connects to the control plane over WebSocket. This module is the
 * status oracle the UI reads to decide whether the install nudge should hide
 * and whether the Local Agent provider card shows "paired" or "not paired".
 *
 * Pairing flow (see /api/agent/pair routes — TODO until the agent npm package
 * ships) writes rows here. For now the table is empty and `getAgentStatusForUser`
 * returns the not-paired branch.
 */

export interface AgentStatus {
  paired: boolean;
  online: boolean;
  agentId?: string;
  hostname?: string;
  platform?: string;
  version?: string;
  lastSeenAt?: string;
}

const ONLINE_THRESHOLD_SEC = 90;

let _initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

export async function getAgentStatusForUser(userId: string): Promise<AgentStatus> {
  await ensureInit();
  // The agent pairs into `agents` (written by /api/agent/pair, heartbeated by
  // /api/agent/heartbeat). The legacy `workspace_agents` table was left as a
  // TODO and is never populated, so the card always read "Not paired" even
  // when a real agent was connected. Resolve via workspace ownership: user →
  // workspace_config (owner) → agents (workspace_id).
  const row = await getLibsqlDb()
    .prepare(
      `SELECT a.id AS agent_id, a.hostname, a.platform, a.version, a.last_seen_at
       FROM agents a
       JOIN workspace_config w ON w.id = a.workspace_id
       WHERE w.auth_user_id = ?
       ORDER BY a.last_seen_at DESC
       LIMIT 1`,
    )
    .get<{
      agent_id: string;
      hostname: string | null;
      platform: string | null;
      version: string | null;
      last_seen_at: string | null;
    }>(userId);

  if (!row) return { paired: false, online: false };

  // SQLite stores UTC like "2026-05-16 13:23:41" with no timezone marker.
  // `Date.parse` on that string interprets it as LOCAL time, which silently
  // breaks "is this fresh?" checks by however many hours the server is
  // offset from UTC. Coerce to a proper ISO-8601 UTC string before parsing.
  const lastSeenMs = row.last_seen_at
    ? Date.parse(row.last_seen_at.replace(' ', 'T') + 'Z')
    : 0;
  const ageSec = lastSeenMs ? (Date.now() - lastSeenMs) / 1000 : Infinity;
  const online = ageSec < ONLINE_THRESHOLD_SEC;

  return {
    paired: true,
    online,
    agentId: row.agent_id,
    hostname: row.hostname ?? undefined,
    platform: row.platform ?? undefined,
    version: row.version ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
  };
}
