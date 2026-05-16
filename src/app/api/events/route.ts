/**
 * GET /api/events?since=<seq>&topics=connector.changed,agent.status,...
 *
 * Server-Sent Events stream of workspace events. Replaces the per-component
 * setInterval polling pattern by letting the client open one persistent
 * connection per page-mount.
 *
 * Auth: WorkOS session (withAuth). Workspace is resolved from the active
 * workspace cookie / owner mapping — clients can't subscribe to someone
 * else's bus.
 *
 * Wire format: one `data: {json}\n\n` per event. `{json}` is
 *   { seq, kind, payload, created_at }
 *
 * The endpoint tails the workspace_events table on a 1.5s interval and
 * flushes any new rows whose seq > the client's last-seen cursor. Closing
 * the EventSource client-side cancels the loop via req.signal.
 *
 * Mode A note: the server still polls the DB. The win over client polling
 * is (a) one connection vs many, (b) local DB tail vs WAN roundtrip, and
 * (c) multiple UI surfaces share one tick per workspace.
 */

import type { NextRequest } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { getActiveWorkspaceId } from '@/lib/active-workspace';

export const dynamic = 'force-dynamic';
// Tell Next to use Node runtime (we use libsql + WorkOS authkit Node SDK).
export const runtime = 'nodejs';

// Tail interval. 1.5s gives ~near-realtime UX while staying cheap. A shorter
// interval would burn DB reads for marginal latency gain.
const TAIL_INTERVAL_MS = 1500;
// Hard cap on the stream lifetime. Vercel will eventually time out the
// function; we close early so clients see a clean end-of-stream and
// reconnect via EventSource's built-in retry rather than discovering a
// dead socket.
const STREAM_MAX_MS = 4 * 60 * 1000; // 4 minutes
// Heartbeat sent as an SSE comment line. Keeps the connection alive
// through proxies and confirms liveness on screens with no events.
const HEARTBEAT_INTERVAL_MS = 25_000;

interface EventRow {
  seq: number;
  kind: string;
  payload: string | null;
  created_at: string;
}

export async function GET(req: NextRequest): Promise<Response> {
  const { user } = await withAuth();
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const workspaceId = await getActiveWorkspaceId();
  await ensureSchemaAsync();

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get('since');
  let cursor = sinceParam ? Number(sinceParam) : 0;
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

  // Optional topic filter. Client may pass ?topics=a,b,c to skip kinds it
  // doesn't care about. Server-side filter avoids waking up screens for
  // events that don't concern them.
  const topicsParam = url.searchParams.get('topics');
  const topics = topicsParam
    ? new Set(topicsParam.split(',').map((t) => t.trim()).filter(Boolean))
    : null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const db = getLibsqlDb();
      let closed = false;
      let tailInterval: ReturnType<typeof setInterval> | null = null;
      let hbInterval: ReturnType<typeof setInterval> | null = null;
      let deadline: ReturnType<typeof setTimeout> | null = null;

      const safeClose = () => {
        if (closed) return;
        closed = true;
        if (tailInterval) clearInterval(tailInterval);
        if (hbInterval) clearInterval(hbInterval);
        if (deadline) clearTimeout(deadline);
        req.signal.removeEventListener('abort', abort);
        try { controller.close(); } catch { /* noop */ }
      };

      const write = (chunk: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          safeClose();
          return false;
        }
      };

      // Initial comment lets clients confirm the connection is up.
      write(`: connected ws=${workspaceId} since=${cursor}\n\n`);

      // Close when the client disconnects (EventSource.close, tab nav, etc).
      const abort = () => safeClose();
      req.signal.addEventListener('abort', abort);

      const startedAt = Date.now();

      const tick = async () => {
        if (closed) return;
        try {
          const rows = (await db
            .prepare(
              `SELECT seq, kind, payload, created_at
               FROM workspace_events
               WHERE workspace_id = ? AND seq > ?
               ORDER BY seq ASC
               LIMIT 200`,
            )
            .all<EventRow>(workspaceId, cursor)) ?? [];

          for (const row of rows) {
            cursor = Math.max(cursor, row.seq);
            if (topics && !topics.has(row.kind)) continue;
            const parsed = row.payload ? safeJsonParse(row.payload) : null;
            const data = JSON.stringify({
              seq: row.seq,
              kind: row.kind,
              payload: parsed,
              created_at: row.created_at,
            });
            if (!write(`data: ${data}\n\n`)) return;
          }
        } catch (err) {
          // DB tail failure — emit one warning line then continue. A
          // transient libsql blip shouldn't kill the stream.
          write(
            `: tail-error ${err instanceof Error ? err.message : String(err)}\n\n`,
          );
        }
      };

      // First tick immediately — clients with a `since` cursor get the
      // missed events before the periodic loop starts.
      await tick();

      tailInterval = setInterval(tick, TAIL_INTERVAL_MS);
      hbInterval = setInterval(() => {
        write(`: heartbeat ${Date.now()}\n\n`);
      }, HEARTBEAT_INTERVAL_MS);
      deadline = setTimeout(() => {
        // Polite end-of-stream. EventSource will auto-reconnect.
        write(`: stream-max reached, reconnect to continue\n\n`);
        safeClose();
      }, STREAM_MAX_MS - (Date.now() - startedAt));
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Vercel needs this to bypass response buffering for streams.
      'x-accel-buffering': 'no',
    },
  });
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
