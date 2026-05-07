/**
 * POST /api/agent/jobs/poll
 *
 * Long-poll for the next queued job in this agent's workspace.
 * Returns one job or null. Body: { wait_ms?: number } (max 25000).
 *
 * Uses SELECT with a retry loop (500ms intervals) as a v1 substitute for
 * SELECT FOR UPDATE SKIP LOCKED, which libSQL (SQLite) does not support.
 * Assignment is serialised by updating status in a single UPDATE statement;
 * the WHERE clause guards against races.
 *
 * Auth: Bearer token.
 */

import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuid } from 'uuid';
import { verifyAgentToken, type AgentIdentity } from '@/lib/agent-auth';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

const MAX_WAIT_MS = 25_000;
const POLL_INTERVAL_MS = 500;

interface JobRow {
  id: string;
  workspace_id: string;
  kind: string;
  status: string;
  params: string;
  attempt: number;
  created_at: string;
}

async function tryAssignJob(identity: AgentIdentity): Promise<JobRow | null> {
  const db = getLibsqlDb();

  // Find the oldest queued job for this workspace.
  const candidate = await db
    .prepare(
      `SELECT id, workspace_id, kind, status, params, attempt, created_at
       FROM agent_jobs
       WHERE status = 'queued' AND workspace_id = ?
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get<JobRow>(identity.workspaceId);

  if (!candidate) return null;

  // Atomically claim it — only succeeds if another worker hasn't grabbed it.
  const result = await db
    .prepare(
      `UPDATE agent_jobs
       SET status = 'assigned', assigned_to = ?, started_at = datetime('now')
       WHERE id = ? AND status = 'queued'`,
    )
    .run(identity.agentId, candidate.id);

  if (result.changes === 0) {
    // Race: another agent snatched it. Return null — caller will retry.
    return null;
  }

  return candidate;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const identity = await verifyAgentToken(req);
  if (!identity) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let waitMs = 0;
  try {
    const body = (await req.json()) as { wait_ms?: number };
    if (typeof body.wait_ms === 'number') {
      waitMs = Math.min(Math.max(0, body.wait_ms), MAX_WAIT_MS);
    }
  } catch {
    // Body is optional
  }

  await ensureSchemaAsync();

  const deadline = Date.now() + waitMs;

  while (true) {
    const job = await tryAssignJob(identity);
    if (job) {
      return NextResponse.json({
        job: {
          id: job.id,
          workspace_id: job.workspace_id,
          kind: job.kind,
          params: JSON.parse(job.params) as unknown,
          attempt: job.attempt,
          created_at: job.created_at,
        },
      });
    }

    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      return NextResponse.json({ job: null });
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
