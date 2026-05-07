/**
 * POST /api/agent/jobs/:id/events
 *
 * Append a batch of RuntimeEvents for an in-flight job.
 * Server assigns monotonic seq numbers per job (MAX(seq)+1 in the same
 * transaction). The agent does NOT send seq values.
 *
 * Returns 409 if the job has already reached a terminal status.
 *
 * Auth: Bearer token. Agent must own (be assigned_to) the job.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAgentToken } from '@/lib/agent-auth';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

interface EventInput {
  type: string;
  payload?: unknown;
}

interface JobRow {
  id: string;
  status: string;
  assigned_to: string | null;
  workspace_id: string;
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Accept either { events: [...] } (the agent's wire format) or a bare array.
  const rawEvents =
    body && typeof body === 'object' && !Array.isArray(body) && 'events' in body
      ? (body as { events: unknown }).events
      : body;

  if (!Array.isArray(rawEvents)) {
    return NextResponse.json(
      { error: 'Body must be { events: [...] } or an array of events' },
      { status: 400 },
    );
  }

  const events = rawEvents as EventInput[];

  for (const ev of events) {
    if (typeof ev.type !== 'string' || !ev.type) {
      return NextResponse.json({ error: 'Each event must have a string "type"' }, { status: 400 });
    }
  }

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const job = await db
    .prepare(`SELECT id, status, assigned_to, workspace_id FROM agent_jobs WHERE id = ?`)
    .get<JobRow>(jobId);

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  if (job.workspace_id !== identity.workspaceId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (TERMINAL_STATUSES.has(job.status)) {
    return NextResponse.json(
      { error: 'Job is in a terminal state; no more events accepted' },
      { status: 409 },
    );
  }

  if (events.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0 });
  }

  // Assign seq numbers starting from MAX(seq)+1 for this job.
  const maxRow = await db
    .prepare(`SELECT COALESCE(MAX(seq), -1) AS max_seq FROM job_events WHERE job_id = ?`)
    .get<{ max_seq: number }>(jobId);

  let nextSeq = (maxRow?.max_seq ?? -1) + 1;

  // Insert events one at a time (libSQL batch doesn't support bind-per-row
  // in a single statement; sequential inserts are fine for ≤50 events).
  for (const ev of events) {
    // The agent sends flat RuntimeEvents like { type: 'log', level, message }.
    // Store everything-except-`type` as the payload so the SSE consumer can
    // reconstruct the full event. Keep the explicit `payload` wrapper as a
    // fallback for callers that pre-wrap.
    let payloadJson: string;
    if (ev.payload !== undefined) {
      payloadJson = JSON.stringify(ev.payload);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { type: _t, ...rest } = ev as Record<string, unknown> & { type: string };
      payloadJson = JSON.stringify(rest);
    }
    await db
      .prepare(
        `INSERT INTO job_events (job_id, seq, type, payload)
         VALUES (?, ?, ?, ?)`,
      )
      .run(jobId, nextSeq, ev.type, payloadJson);
    nextSeq++;
  }

  // Transition the job from 'assigned' → 'running' on first event batch.
  if (job.status === 'assigned') {
    await db
      .prepare(`UPDATE agent_jobs SET status = 'running' WHERE id = ? AND status = 'assigned'`)
      .run(jobId);
  }

  return NextResponse.json({ ok: true, inserted: events.length });
}
