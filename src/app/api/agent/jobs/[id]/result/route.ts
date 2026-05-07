/**
 * POST /api/agent/jobs/:id/result
 *
 * Terminal endpoint. Agent calls this once when the job completes or fails.
 * Body: { status: 'done' | 'failed'; result?: unknown; error?: string }
 *
 * Returns 409 if the job is already terminal.
 *
 * Auth: Bearer token.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAgentToken } from '@/lib/agent-auth';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);
const ALLOWED_RESULT_STATUSES = new Set(['done', 'failed']);

interface ResultBody {
  status?: unknown;
  result?: unknown;
  error?: string;
}

interface JobRow {
  id: string;
  kind: string;
  status: string;
  workspace_id: string;
  params: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const identity = await verifyAgentToken(req);
  if (!identity) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: jobId } = await params;

  let body: ResultBody;
  try {
    body = (await req.json()) as ResultBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const status = body.status;
  if (typeof status !== 'string' || !ALLOWED_RESULT_STATUSES.has(status)) {
    return NextResponse.json(
      { error: 'status must be "done" or "failed"' },
      { status: 400 },
    );
  }

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const job = await db
    .prepare(`SELECT id, kind, status, workspace_id, params FROM agent_jobs WHERE id = ?`)
    .get<JobRow>(jobId);

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  if (job.workspace_id !== identity.workspaceId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (TERMINAL_STATUSES.has(job.status)) {
    return NextResponse.json(
      { error: 'Job is already in a terminal state' },
      { status: 409 },
    );
  }

  const resultPayload = body.result !== undefined ? body.result : body.error !== undefined ? { error: body.error } : null;
  const resultJson = resultPayload !== null ? JSON.stringify(resultPayload) : null;

  await db
    .prepare(
      `UPDATE agent_jobs
       SET status = ?, result = ?, finished_at = datetime('now')
       WHERE id = ?`,
    )
    .run(status, resultJson, jobId);

  // Fire an Inngest event for job failures so downstream functions
  // (e.g. almanac.handleJobFailure) can react without polling.
  if (status === 'failed') {
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(job.params) as Record<string, unknown>;
    } catch {
      // non-critical; params field is best-effort
    }
    // Fire-and-forget — don't block the response on Inngest availability.
    void inngest
      .send({
        name: 'agent/job.failed',
        data: { job_id: jobId, kind: job.kind, params },
      })
      .catch(() => {
        // Swallow Inngest errors — the DB update already succeeded.
      });
  }

  return NextResponse.json({ ok: true });
}
