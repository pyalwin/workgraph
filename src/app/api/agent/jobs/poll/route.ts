import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { verifyAgentRequest } from '@/lib/agent-auth';

export const dynamic = 'force-dynamic';

// Capped at 25 s — stays well under Vercel's serverless-function timeout.
const MAX_WAIT_MS = 25_000;
const POLL_INTERVAL_MS = 1_000;

interface PollBody {
  wait_ms?: number;
}

interface JobRow {
  id: string;
  kind: string;
  params: string;
  attempt: number;
}

async function tryClaimJob(agentId: string): Promise<JobRow | null> {
  const db = getLibsqlDb();

  // SELECT the oldest queued job for this agent, then UPDATE with a
  // status='queued' guard. If another concurrent poller claimed it first,
  // changes === 0 and we skip — no double-dispatch.
  const candidate = await db
    .prepare(
      `SELECT id, kind, params, attempt
       FROM agent_jobs
       WHERE agent_id = ? AND status = 'queued'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get<JobRow>(agentId);

  if (!candidate) return null;

  const updated = await db
    .prepare(
      `UPDATE agent_jobs
       SET status = 'running',
           started_at = datetime('now'),
           attempt = attempt + 1
       WHERE id = ? AND status = 'queued'`,
    )
    .run(candidate.id);

  // changes === 0 means a concurrent poller already claimed it; treat as no-job
  // so this poller continues waiting rather than returning a stale row.
  if (updated.changes === 0) return null;

  // Re-fetch to get the incremented attempt value.
  const claimed = await db
    .prepare(
      `SELECT id, kind, params, attempt
       FROM agent_jobs
       WHERE id = ?
       LIMIT 1`,
    )
    .get<JobRow>(candidate.id);

  return claimed ?? null;
}

async function bumpHeartbeat(agentId: string): Promise<void> {
  await getLibsqlDb()
    .prepare(
      `UPDATE workspace_agents
       SET last_seen_at = datetime('now'),
           status = 'online'
       WHERE agent_id = ?`,
    )
    .run(agentId);
}

export async function POST(req: Request) {
  await ensureSchemaAsync();

  const identity = await verifyAgentRequest(req);
  if (!identity) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body: PollBody = await req.json().catch(() => ({}));
  const waitMs = Math.min(body.wait_ms ?? MAX_WAIT_MS, MAX_WAIT_MS);
  const deadline = Date.now() + waitMs;

  // Bump heartbeat immediately — saves the agent a separate round-trip.
  await bumpHeartbeat(identity.agentId);

  // Long-poll loop: retry every second until a job is available or time runs out.
  while (true) {
    const job = await tryClaimJob(identity.agentId);
    if (job) {
      return NextResponse.json({
        job: {
          id: job.id,
          kind: job.kind,
          params: JSON.parse(job.params) as unknown,
          attempt: job.attempt,
        },
      });
    }

    if (Date.now() >= deadline) break;
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return NextResponse.json({ job: null });
}
