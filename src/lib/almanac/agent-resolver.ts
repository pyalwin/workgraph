/**
 * Almanac · agent resolver
 *
 * Picks the agent that should run a workspace's Almanac jobs.
 *
 * In the current Phase 0 pair flow the agent is registered under the
 * synthetic workspace_id `'all'` (see `src/app/api/agent/pair/confirm/route.ts`)
 * because per-workspace pairing isn't yet wired through the UI. Real connectors
 * live under their actual workspace ids (`engineering`, `default`, etc.). To
 * bridge the gap until KAN-50 lands the per-workspace pair flow, callers
 * accept any online agent that is paired either to the requested workspace
 * OR to the global `'all'` slot. Pick the most recently heard-from one.
 */
import { getLibsqlDb } from '@/lib/db/libsql';

interface AgentRow {
  agent_id: string;
}

export async function resolveAgentForWorkspace(workspaceId: string): Promise<string | null> {
  const db = getLibsqlDb();
  const row = await db
    .prepare(
      `SELECT agent_id FROM workspace_agents
       WHERE (workspace_id = ? OR workspace_id = 'all')
         AND status = 'online'
       ORDER BY last_seen_at DESC
       LIMIT 1`,
    )
    .get<AgentRow>(workspaceId);
  return row?.agent_id ?? null;
}
