/**
 * GET /api/admin/almanac/sync-status?workspaceId=default
 *
 * Returns a structured snapshot of every Almanac stage so the UI can render
 * a per-phase progress block for a running sync. All counts are cheap.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

interface CountRow {
  c: number;
}
interface BackfillRow {
  repo: string;
  total_events: number | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
}
interface JobBucket {
  status: string;
  c: number;
}

export async function GET(req: NextRequest) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const workspaceId = req.nextUrl.searchParams.get('workspaceId') ?? 'default';

  // Phase 1 — code_events
  const eventsTotal = await db.prepare(
    `SELECT COUNT(*) AS c FROM code_events WHERE workspace_id = ?`,
  ).get<CountRow>(workspaceId);

  const eventsClassified = await db.prepare(
    `SELECT COUNT(*) AS c FROM code_events
     WHERE workspace_id = ? AND classifier_run_at IS NOT NULL`,
  ).get<CountRow>(workspaceId);

  const eventsSignal = await db.prepare(
    `SELECT COUNT(*) AS c FROM code_events
     WHERE workspace_id = ? AND is_feature_evolution = 1`,
  ).get<CountRow>(workspaceId);

  const eventsUnitAssigned = await db.prepare(
    `SELECT COUNT(*) AS c FROM code_events
     WHERE workspace_id = ? AND functional_unit_id IS NOT NULL`,
  ).get<CountRow>(workspaceId);

  const eventsLinked = await db.prepare(
    `SELECT COUNT(*) AS c FROM code_events
     WHERE workspace_id = ? AND linked_item_id IS NOT NULL`,
  ).get<CountRow>(workspaceId);

  // Backfill state per repo
  const backfillRows = await db.prepare(
    `SELECT repo, total_events, last_run_at, last_status, last_error
     FROM code_events_backfill_state
     ORDER BY last_run_at DESC NULLS LAST
     LIMIT 10`,
  ).all<BackfillRow>();

  // Phase 2 — functional units
  const unitsTotal = await db.prepare(
    `SELECT COUNT(*) AS c FROM functional_units
     WHERE workspace_id = ? AND status = 'active'`,
  ).get<CountRow>(workspaceId);

  const unitsNamed = await db.prepare(
    `SELECT COUNT(*) AS c FROM functional_units
     WHERE workspace_id = ? AND status = 'active'
       AND name IS NOT NULL AND length(name) > 0`,
  ).get<CountRow>(workspaceId);

  // Phase 3 — orphan ticket candidates
  const candidatesTotal = await db.prepare(
    `SELECT COUNT(*) AS c FROM orphan_ticket_candidates`,
  ).get<CountRow>();

  const candidatesAccepted = await db.prepare(
    `SELECT COUNT(*) AS c FROM orphan_ticket_candidates WHERE accepted_at IS NOT NULL`,
  ).get<CountRow>();

  // Phase 4 — almanac_sections
  const sectionsTotal = await db.prepare(
    `SELECT COUNT(*) AS c FROM almanac_sections WHERE workspace_id = ?`,
  ).get<CountRow>(workspaceId);

  const sectionsNarrated = await db.prepare(
    `SELECT COUNT(*) AS c FROM almanac_sections
     WHERE workspace_id = ? AND generated_at IS NOT NULL`,
  ).get<CountRow>(workspaceId);

  // Phase 7 — almanac chunks + embeddings
  const chunksTotal = await db.prepare(
    `SELECT COUNT(*) AS c FROM item_chunks WHERE chunk_type = 'almanac_section'`,
  ).get<CountRow>();

  const chunksEmbedded = await db.prepare(
    `SELECT COUNT(*) AS c FROM chunk_vectors cv
     JOIN item_chunks ic ON ic.id = cv.chunk_id
     WHERE ic.chunk_type = 'almanac_section'`,
  ).get<CountRow>();

  // Agent jobs — current pipeline pulse
  const jobBuckets = await db.prepare(
    `SELECT status, COUNT(*) AS c FROM agent_jobs
     WHERE kind LIKE 'almanac.%'
     GROUP BY status`,
  ).all<JobBucket>();

  return NextResponse.json({
    workspaceId,
    phase1_extract: {
      events_total: eventsTotal?.c ?? 0,
      backfill_repos: backfillRows.map((r) => ({
        repo: r.repo,
        total_events: r.total_events ?? 0,
        last_run_at: r.last_run_at,
        last_status: r.last_status,
        last_error: r.last_error,
      })),
    },
    phase1_6_classify: {
      events_classified: eventsClassified?.c ?? 0,
      events_signal: eventsSignal?.c ?? 0,
    },
    phase2_units: {
      units_total: unitsTotal?.c ?? 0,
      units_named: unitsNamed?.c ?? 0,
      events_unit_assigned: eventsUnitAssigned?.c ?? 0,
    },
    phase3_match: {
      candidates_total: candidatesTotal?.c ?? 0,
      candidates_accepted: candidatesAccepted?.c ?? 0,
      events_linked: eventsLinked?.c ?? 0,
    },
    phase4_narrate: {
      sections_total: sectionsTotal?.c ?? 0,
      sections_narrated: sectionsNarrated?.c ?? 0,
    },
    phase7_rag: {
      chunks_total: chunksTotal?.c ?? 0,
      chunks_embedded: chunksEmbedded?.c ?? 0,
    },
    agent_jobs: {
      by_status: Object.fromEntries(jobBuckets.map((b) => [b.status, b.c])),
    },
  });
}
