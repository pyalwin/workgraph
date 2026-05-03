/**
 * POST /api/admin/kick-pipeline
 *
 * Runs the post-sync chain inline so the user can test the full flow
 * without waiting for crons. Steps:
 *
 *   1. chunk pending work_items
 *   2. embed pending chunks
 *   3. enrich orphan PRs (functional_summary from diff)
 *   4. run unmatched PR matcher (auto-attach + populate review candidates)
 *   5. fire workgraph/anomalies.scan event (long-running, async)
 *
 * Steps 1-4 run inline because they're cheap and the user wants results
 * back. Step 5 fires an event because the anomaly scan iterates every
 * workspace+project, which is slower; the user gets a "queued" signal
 * and the scan completes in the background.
 *
 * Body: optional { skip_anomalies?: boolean } — skips step 5 for the
 * impatient.
 *
 * Auth: relies on existing session middleware. No additional gating
 * here — the action is destructive only in the sense of "burns API
 * tokens" which is acceptable for an authenticated user.
 */
import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { chunkAllPending } from '@/lib/chunking';
import { embedAllPending } from '@/lib/embeddings/embed';
import { enrichOrphanPrIntents } from '@/lib/sync/orphan-pr-enrich';
import { runUnmatchedPrMatcher } from '@/lib/sync/unmatched-pr-matcher';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';
// Steps 1-4 can take a couple minutes on a backfill; embedding a few
// thousand chunks is the longest leg. Bump the runtime ceiling.
export const maxDuration = 300;

interface Body {
  skip_anomalies?: unknown;
}

export async function POST(req: Request) {
  await ensureSchemaAsync();

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // empty body is fine
  }
  const skipAnomalies = body.skip_anomalies === true;

  const startedAt = Date.now();
  const result: {
    chunked: { items: number; chunks: number } | null;
    embedded: { embedded: number; skipped: number; failed: number; errors?: string[] } | null;
    enriched: { scanned: number; enriched: number; failed: number } | null;
    matcher: {
      scanned: number;
      matched: number;
      reviewable: number;
      moved_issue_ids: number;
    } | null;
    anomaly_scan: 'queued' | 'skipped' | null;
    duration_ms: number;
    errors: string[];
  } = {
    chunked: null,
    embedded: null,
    enriched: null,
    matcher: null,
    anomaly_scan: null,
    duration_ms: 0,
    errors: [],
  };

  // Step 1 — chunk
  try {
    result.chunked = await chunkAllPending({ force: false });
  } catch (err) {
    result.errors.push(`chunk: ${(err as Error).message}`);
  }

  // Step 2 — embed
  try {
    const r = await embedAllPending({ concurrency: 4 });
    result.embedded = { embedded: r.embedded, skipped: r.skipped, failed: r.failed, errors: r.errors };
    if (r.errors.length > 0) result.errors.push(...r.errors.slice(0, 3).map((e) => `embed: ${e}`));
  } catch (err) {
    result.errors.push(`embed: ${(err as Error).message}`);
  }

  // Step 3 — orphan PR intent enrichment
  try {
    const r = await enrichOrphanPrIntents({ limit: 100, concurrency: 4 });
    result.enriched = { scanned: r.scanned, enriched: r.enriched, failed: r.failed };
    if (r.errors.length > 0) result.errors.push(...r.errors.slice(0, 3).map((e) => `enrich: ${e}`));
  } catch (err) {
    result.errors.push(`enrich: ${(err as Error).message}`);
  }

  // Step 4 — matcher (auto-attach + write review candidates)
  try {
    const r = await runUnmatchedPrMatcher();
    result.matcher = {
      scanned: r.scanned,
      matched: r.matched,
      reviewable: r.reviewable,
      moved_issue_ids: r.movedIssueIds.length,
    };
    if (r.errors.length > 0) result.errors.push(...r.errors.slice(0, 3).map((e) => `matcher: ${e}`));
  } catch (err) {
    result.errors.push(`matcher: ${(err as Error).message}`);
  }

  // Step 5 — anomaly scan (queue, don't block)
  if (skipAnomalies) {
    result.anomaly_scan = 'skipped';
  } else {
    try {
      await inngest.send({
        name: 'workgraph/anomalies.scan',
        data: { triggered_by: 'admin_kick_pipeline' },
      });
      result.anomaly_scan = 'queued';
    } catch (err) {
      result.errors.push(`anomaly_scan: ${(err as Error).message}`);
    }
  }

  result.duration_ms = Date.now() - startedAt;
  return NextResponse.json({ ok: result.errors.length === 0, ...result });
}
