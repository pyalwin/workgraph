/**
 * POST /api/admin/almanac/sync-all
 *
 * Fires all 6 Almanac pipeline events back-to-back with cumulative delays
 * so they execute in dependency order:
 *
 *    Phase 1   workgraph/almanac.backfill            (immediate)
 *    Phase 1.6 workgraph/almanac.noise-classify      (+ ~5 min)
 *    Phase 2   workgraph/almanac.detect-units        (+ ~6 min)
 *    Phase 3   workgraph/almanac.tickets.match       (+ ~9 min)
 *    Phase 4   workgraph/almanac.narrative.regen     (+ ~10 min)
 *    Phase 7   workgraph/chunk-embed.run             (+ ~12 min)
 *
 * Real wall-clock time depends on agent speed + repo size; the deltas above
 * are heuristics tuned for a small dev install. Each phase no-ops if the
 * prior didn't produce data.
 *
 * Body: { workspaceId?: string; repo?: string; cli?: string; model?: string }
 */
import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import {
  enqueueBackfill,
  enqueueNoiseClassify,
  runDetectUnits,
} from '@/lib/almanac/sync/phase-helpers';

export const dynamic = 'force-dynamic';

interface SyncAllBody {
  workspaceId?: string;
  repo?: string;
  cli?: string;
  model?: string;
}

/**
 * If the caller didn't pass workspaceId, pick the workspace that actually
 * has a configured GitHub connector. Falls back to 'default'. Without this
 * the sync silently no-ops because the cron functions chase the wrong ID.
 */
async function resolveWorkspaceId(explicit: string | undefined): Promise<string> {
  if (explicit) return explicit;
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const row = await db.prepare(
    `SELECT workspace_id FROM workspace_connector_configs
     WHERE source = 'github' AND status IN ('configured', 'connected', 'ok')
     ORDER BY last_sync_completed_at DESC NULLS LAST
     LIMIT 1`,
  ).get<{ workspace_id: string }>();
  return row?.workspace_id ?? 'default';
}

export async function POST(req: Request) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as SyncAllBody;
  const workspaceId = await resolveWorkspaceId(body.workspaceId);
  const repo = body.repo;

  const now = Date.now();

  // Phase 1 enqueue — runs inline so jobs land in agent_jobs immediately,
  // bypassing Inngest event dispatch (which is unreliable in dev when the
  // dev-server / app start in different orders). Phases 1.6 / 2 are kicked
  // off in the background once Phase 1 jobs drain (see /sync-status).
  const phase1 = await enqueueBackfill(workspaceId, { repo });

  // Surface diagnostic info so the UI can show "we're syncing workspace X
  // with N connectors" — the most common failure mode is a workspace
  // mismatch where the agent is paired to one ID but data lives in another.
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const ctx = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM workspace_connector_configs WHERE workspace_id = ?) as connectors,
       (SELECT COUNT(*) FROM workspace_agents WHERE (workspace_id = ? OR workspace_id = 'all') AND status = 'online') as online_agents,
       (SELECT COUNT(*) FROM workspace_agents WHERE workspace_id = ? OR workspace_id = 'all') as paired_agents`,
  ).get<{ connectors: number; online_agents: number; paired_agents: number }>(workspaceId, workspaceId, workspaceId);

  return NextResponse.json({
    ok: true,
    workspaceId,
    workspaceId_resolved_from: body.workspaceId ? 'request' : 'auto-discovery (first github connector)',
    started_at: new Date(now).toISOString(),
    phase1_enqueue: phase1,
    diagnostics: {
      connectors_in_workspace: ctx?.connectors ?? 0,
      paired_agents: ctx?.paired_agents ?? 0,
      online_agents: ctx?.online_agents ?? 0,
      hint:
        (ctx?.online_agents ?? 0) === 0
          ? 'No online agent. Run `workgraph run` in another terminal so the agent picks up jobs.'
          : (ctx?.connectors ?? 0) === 0
            ? `No connectors in workspace '${workspaceId}'. Connect a GitHub repo first.`
            : phase1.reason
              ? `Phase 1: ${phase1.reason}`
              : `Phase 1 enqueued ${phase1.enqueued ?? 0} jobs across ${phase1.repos ?? 0} repos. Watch the agent_jobs counter — Phases 1.6/2/3/4/7 advance automatically as each one drains.`,
    },
  });
}

