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
const ALLOWED_RESULT_STATUSES = new Set(['done', 'failed', 'defer']);

// Hard cap on attempts — a chronically rate-limited job shouldn't loop
// forever even with deferrals. After this many defers it's marked failed.
const MAX_ATTEMPTS = 12;
// Floor / ceiling on requested retry_after to prevent agent bugs from
// jamming the queue (under-delay → busy-loop; over-delay → effectively lost).
const MIN_RETRY_SECONDS = 60;            // never sooner than 1 min
const MAX_RETRY_SECONDS = 24 * 60 * 60;  // never later than 24h

interface ResultBody {
  status?: unknown;
  result?: unknown;
  error?: string;
  retry_after_seconds?: unknown;
}

interface JobRow {
  id: string;
  kind: string;
  status: string;
  workspace_id: string;
  params: string;
  attempt: number;
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
    .prepare(`SELECT id, kind, status, workspace_id, params, attempt FROM agent_jobs WHERE id = ?`)
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

  // ── defer branch: reschedule the job for a future poll instead of
  //    marking it terminal. Agent reports this when it hit a rate limit
  //    that needs hours-scale recovery; the agent moves on to other work
  //    rather than holding the process. The handler tells us how long to
  //    wait (provider-policy); we clamp to [MIN, MAX] and cap attempts.
  if (status === 'defer') {
    const requested = Number(body.retry_after_seconds);
    const seconds = Number.isFinite(requested)
      ? Math.min(MAX_RETRY_SECONDS, Math.max(MIN_RETRY_SECONDS, Math.floor(requested)))
      : 3600; // 1h default
    const attempts = (job.attempt ?? 0) + 1;

    if (attempts >= MAX_ATTEMPTS) {
      const errMsg = (typeof body.error === 'string' && body.error)
        ? `${body.error} (max attempts exceeded)`
        : 'max defer attempts exceeded';
      await db
        .prepare(
          `UPDATE agent_jobs
           SET status = 'failed', last_error = ?, attempt = ?, finished_at = datetime('now')
           WHERE id = ?`,
        )
        .run(errMsg, attempts, jobId);
      void inngest
        .send({ name: 'agent/job.failed', data: { job_id: jobId, kind: job.kind, error: errMsg } })
        .catch(() => {});
      return NextResponse.json({ ok: true, status: 'failed_after_defers', attempts });
    }

    const errNote = typeof body.error === 'string' ? body.error.slice(0, 240) : 'rate_limited';
    await db
      .prepare(
        `UPDATE agent_jobs
         SET status = 'queued',
             assigned_to = NULL,
             started_at = NULL,
             attempt = ?,
             next_retry_at = datetime('now', ?),
             last_error = ?
         WHERE id = ?`,
      )
      .run(attempts, `+${seconds} seconds`, errNote, jobId);
    return NextResponse.json({
      ok: true,
      status: 'deferred',
      retry_after_seconds: seconds,
      attempt: attempts,
    });
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

  // Kind-specific result dispatch. Each job kind owns its own write path
  // when the result lands. Keep these blocks small and best-effort — the
  // job is already marked terminal even if the dispatch throws.
  let jobParams: Record<string, unknown> = {};
  try {
    jobParams = JSON.parse(job.params) as Record<string, unknown>;
  } catch {
    /* params is best-effort */
  }

  if (status === 'done' && job.kind === 'gmail.classify') {
    try {
      const { persistGmailClassification } = await import('@/lib/enrichment/gmail');
      const itemId = String(jobParams.item_id || '');
      const classification = resultPayload as {
        category?: unknown;
        topics?: unknown;
        summary?: unknown;
        entities?: unknown;
      } | null;
      if (itemId && classification && typeof classification === 'object') {
        // Re-shape into the strict GmailClassification expected by the
        // persistence layer. Best-effort sanitization mirrors what the
        // inline LLM path does after parsing the model's JSON output.
        const category = typeof classification.category === 'string'
          ? classification.category
          : 'other';
        const topics = Array.isArray(classification.topics)
          ? classification.topics.filter((t): t is string => typeof t === 'string').slice(0, 3)
          : [];
        const summary = typeof classification.summary === 'string' ? classification.summary : '';
        const entities = Array.isArray(classification.entities)
          ? (classification.entities as Array<unknown>).filter(
              (e): e is { kind: 'organization' | 'person' | 'product'; name: string } =>
                typeof e === 'object' && e !== null
                && typeof (e as any).name === 'string'
                && ['organization', 'person', 'product'].includes((e as any).kind),
            ).slice(0, 6)
          : [];
        await persistGmailClassification(job.workspace_id, itemId, {
          category: category as any,
          topics,
          summary,
          entities,
        });
      }
    } catch (err) {
      console.warn('[gmail.classify] persist failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // Inngest event emission. 'agent/job.completed' is needed by the
  // gmailEnrichOnComplete listener to detect end-of-wave and kick off
  // crossref + pipeline rebuild. Older almanac flow only listens on
  // .failed but emitting .completed too is additive.
  const eventName = status === 'failed' ? 'agent/job.failed' : 'agent/job.completed';
  void inngest
    .send({
      name: eventName,
      data: { job_id: jobId, kind: job.kind, params: jobParams },
    })
    .catch(() => {
      /* DB update already succeeded; Inngest is fire-and-forget */
    });

  return NextResponse.json({ ok: true });
}
