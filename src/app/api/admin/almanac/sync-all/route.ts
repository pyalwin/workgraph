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
import { matchTicket, findOrphanTickets } from '@/lib/sync/ticket-code-matcher';
import { regenerateSections } from '@/lib/almanac/section-runner';

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

  // Run every applicable phase inline. Each helper is idempotent + gated
  // by data state, so calling them all on every click is safe — phases
  // whose prerequisites aren't met return { ok:true, enqueued:0 }.
  // This lets a single 'Run sync' click push the pipeline forward
  // regardless of where it's currently stuck.
  const phase1 = await enqueueBackfill(workspaceId, { repo });

  await ensureSchemaAsync();
  const dbForPeek = getLibsqlDb();
  const phase16 = await dbForPeek.prepare(
    `SELECT COUNT(*) AS c FROM code_events
     WHERE workspace_id = ? AND noise_class = 'signal' AND intent IS NULL`,
  ).get<{ c: number }>(workspaceId);
  const queuedOrRunning = await dbForPeek.prepare(
    `SELECT COUNT(*) AS c FROM agent_jobs
     WHERE kind LIKE 'almanac.%' AND status IN ('queued','running')`,
  ).get<{ c: number }>();

  let phase16Result: unknown = null;
  let phase2Result: unknown = null;
  let phase3Result: unknown = null;
  let phase4Result: unknown = null;

  if ((phase16?.c ?? 0) > 0 && (queuedOrRunning?.c ?? 0) === 0) {
    phase16Result = await enqueueNoiseClassify(workspaceId).catch((e) => ({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }));
  }

  // Phase 2 / 3 / 4 — fire only if Phase 1.6 has produced LLM-classified
  // events (intent IS NOT NULL). Phase 2 enqueues an agent job; 3 and 4
  // run server-side immediately.
  const llmDoneRow = await dbForPeek.prepare(
    `SELECT COUNT(*) AS c FROM code_events WHERE workspace_id = ? AND intent IS NOT NULL`,
  ).get<{ c: number }>(workspaceId);

  if ((llmDoneRow?.c ?? 0) > 0) {
    const unitsRow = await dbForPeek.prepare(
      `SELECT COUNT(*) AS c FROM functional_units WHERE workspace_id = ? AND status = 'active'`,
    ).get<{ c: number }>(workspaceId);
    if ((unitsRow?.c ?? 0) === 0) {
      phase2Result = await runDetectUnits(workspaceId).catch((e) => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    } else {
      // Phase 3 — server-side ticket matcher
      phase3Result = await (async () => {
        try {
          const orphans = await findOrphanTickets(workspaceId);
          let matched = 0;
          for (const t of orphans.slice(0, 50)) {
            await matchTicket(workspaceId, t).catch(() => null);
            matched++;
          }
          return { ok: true, orphans: orphans.length, matched };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();

      // Phase 4 — server-side narrative regen for each project_key
      phase4Result = await (async () => {
        try {
          const projects = await dbForPeek.prepare(
            `SELECT DISTINCT project_key FROM functional_units
             WHERE workspace_id = ? AND status = 'active' AND project_key IS NOT NULL`,
          ).all<{ project_key: string }>(workspaceId);
          const summaries: unknown[] = [];
          for (const p of projects) {
            const s = await regenerateSections(workspaceId, p.project_key).catch((e) => ({
              error: e instanceof Error ? e.message : String(e),
            }));
            summaries.push({ project_key: p.project_key, ...(s as object) });
          }
          return { ok: true, projects: summaries };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();
    }
  }

  // Surface diagnostic info so the UI can show "we're syncing workspace X
  // with N connectors" — the most common failure mode is a workspace
  // mismatch where the agent is paired to one ID but data lives in another.
  const ctx = await dbForPeek.prepare(
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
    phase1_6_enqueue: phase16Result,
    phase2_enqueue: phase2Result,
    phase3_match: phase3Result,
    phase4_narrate: phase4Result,
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

