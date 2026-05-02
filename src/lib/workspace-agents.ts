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
  const row = await getLibsqlDb()
    .prepare(
      `SELECT agent_id, hostname, platform, version, last_seen_at, status
       FROM workspace_agents
       WHERE user_id = ?
       ORDER BY last_seen_at DESC
       LIMIT 1`,
    )
    .get<{
      agent_id: string;
      hostname: string | null;
      platform: string | null;
      version: string | null;
      last_seen_at: string | null;
      status: string;
    }>(userId);

  if (!row) return { paired: false, online: false };

  const lastSeenMs = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
  const ageSec = lastSeenMs ? (Date.now() - lastSeenMs) / 1000 : Infinity;
  const online = row.status === 'online' && ageSec < ONLINE_THRESHOLD_SEC;

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
