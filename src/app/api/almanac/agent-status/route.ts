/**
 * GET /api/almanac/agent-status?projectKey=...
 *
 * Reports the readiness of the local agent for almanac generation,
 * scoped to the workspace that owns this project. The Generate form
 * uses this to gate the submit and surface remediation hints.
 *
 * Response shape:
 *   {
 *     paired: boolean,                // any agent paired for this workspace?
 *     online: boolean,                // last_seen_at within ONLINE_WINDOW_S?
 *     agent: {                        // null when paired=false
 *       id, hostname, platform, version,
 *       lastSeenAt,
 *       claudeAvailable, claudeVersion
 *     } | null,
 *     ready: boolean,                 // online AND claudeAvailable
 *     issues: string[]                // human-readable reasons not-ready
 *   }
 *
 * Auth: browser session (withAuth). Workspace ownership is enforced by
 * resolving the workspace from projectKey first.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { resolveAlmanacWorkspaceId } from '@/lib/almanac/workspace-resolver';

export const dynamic = 'force-dynamic';

const ONLINE_WINDOW_S = 90;

interface AgentRow {
  id: string;
  hostname: string | null;
  platform: string | null;
  version: string | null;
  claude_available: number | null;
  claude_version: string | null;
  last_seen_at: string | null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const projectKey = req.nextUrl.searchParams.get('projectKey');
  if (!projectKey) {
    return NextResponse.json({ error: 'projectKey query param is required' }, { status: 400 });
  }

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const workspaceId = await resolveAlmanacWorkspaceId(projectKey);

  // Pick the most-recently-seen agent for the workspace; fall back to the
  // newest paired one if none have heartbeat yet.
  const agent = await db
    .prepare(
      `SELECT id, hostname, platform, version, claude_available, claude_version, last_seen_at
       FROM agents
       WHERE workspace_id = ?
       ORDER BY COALESCE(last_seen_at, paired_at) DESC
       LIMIT 1`,
    )
    .get<AgentRow>(workspaceId);

  if (!agent) {
    return NextResponse.json({
      paired: false,
      online: false,
      agent: null,
      ready: false,
      issues: ['No local agent paired for this workspace.'],
    });
  }

  const online = isOnline(agent.last_seen_at);
  const claudeAvailable = agent.claude_available === 1;
  const ready = online && claudeAvailable;

  const issues: string[] = [];
  if (!online) {
    issues.push('Agent has not checked in recently. Make sure `workgraph run` is running on your machine.');
  }
  if (online && !claudeAvailable) {
    issues.push('Claude CLI is not available on the agent. Install it and run `claude /login`.');
  }

  return NextResponse.json({
    paired: true,
    online,
    ready,
    issues,
    agent: {
      id: agent.id,
      hostname: agent.hostname,
      platform: agent.platform,
      version: agent.version,
      lastSeenAt: agent.last_seen_at,
      claudeAvailable,
      claudeVersion: agent.claude_version,
    },
  });
}

function isOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  // libsql stores as ISO-ish UTC string from datetime('now') — append 'Z' if missing.
  const iso = lastSeenAt.includes('T') ? lastSeenAt : lastSeenAt.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) / 1000 < ONLINE_WINDOW_S;
}
