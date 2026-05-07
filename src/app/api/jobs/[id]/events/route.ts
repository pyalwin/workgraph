/**
 * GET /api/jobs/:id/events?since=<seq>
 *
 * Server-Sent Events stream of job_events for the given job.
 * Polls the database at ~250ms intervals for new rows after `since`.
 * Stops when the job reaches a terminal status AND all pending events have
 * been sent.
 *
 * Auth: browser session (withAuth from WorkOS authkit).
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

const POLL_INTERVAL_MS = 250;
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

interface EventRow {
  seq: number;
  type: string;
  payload: string;
  created_at: string;
}

interface JobStatusRow {
  status: string;
  workspace_id: string;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse | Response> {
  // Browser-side auth.
  const { user } = await withAuth();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: jobId } = await params;

  const sinceParam = req.nextUrl.searchParams.get('since');
  let since = sinceParam !== null ? parseInt(sinceParam, 10) : -1;
  if (isNaN(since)) since = -1;

  await ensureSchemaAsync();

  // Verify job exists (no workspace ownership check beyond having a valid
  // session; tighten if multi-tenant isolation is needed).
  const db = getLibsqlDb();
  const job = await db
    .prepare(`SELECT status, workspace_id FROM agent_jobs WHERE id = ?`)
    .get<JobStatusRow>(jobId);

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  const abortController = new AbortController();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      function send(data: string) {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          // Stream closed
        }
      }

      try {
        let lastSeq = since;

        while (true) {
          if (abortController.signal.aborted) break;

          const freshDb = getLibsqlDb();

          // Fetch new events since lastSeq.
          const newEvents = await freshDb
            .prepare(
              `SELECT seq, type, payload, created_at
               FROM job_events
               WHERE job_id = ? AND seq > ?
               ORDER BY seq ASC`,
            )
            .all<EventRow>(jobId, lastSeq);

          for (const ev of newEvents) {
            send(
              JSON.stringify({
                seq: ev.seq,
                type: ev.type,
                payload: JSON.parse(ev.payload) as unknown,
                created_at: ev.created_at,
              }),
            );
            lastSeq = ev.seq;
          }

          // Check job terminal status.
          const currentJob = await freshDb
            .prepare(`SELECT status FROM agent_jobs WHERE id = ?`)
            .get<{ status: string }>(jobId);

          if (currentJob && TERMINAL_STATUSES.has(currentJob.status) && newEvents.length === 0) {
            // Terminal and no more events — send a synthetic finish sentinel and close.
            send(JSON.stringify({ type: '_stream_end', status: currentJob.status }));
            break;
          }

          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, POLL_INTERVAL_MS);
            abortController.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          });
        }
      } catch {
        // Client disconnected or aborted — clean up silently.
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  // Attach the request abort signal so closing the tab tears down the loop.
  req.signal.addEventListener('abort', () => {
    abortController.abort();
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
