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
import { inngest } from '@/inngest/client';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

interface SyncAllBody {
  workspaceId?: string;
  repo?: string;
  cli?: string;
  model?: string;
}

interface PhaseSpec {
  name: string;
  event: string;
  delaySec: number;
  data: Record<string, unknown>;
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
  const cli = body.cli;
  const model = body.model;

  const baseData = { workspaceId } as Record<string, unknown>;
  if (repo) baseData.repo = repo;
  if (cli) baseData.cli = cli;
  if (model) baseData.model = model;

  const phases: PhaseSpec[] = [
    { name: 'phase1-backfill',          event: 'workgraph/almanac.backfill',         delaySec: 0,    data: baseData },
    { name: 'phase1.6-noise-classify',  event: 'workgraph/almanac.noise-classify',   delaySec: 300,  data: baseData },
    { name: 'phase2-detect-units',      event: 'workgraph/almanac.detect-units',     delaySec: 360,  data: baseData },
    { name: 'phase3-tickets-match',     event: 'workgraph/almanac.tickets.match',    delaySec: 540,  data: baseData },
    { name: 'phase4-narrative-regen',   event: 'workgraph/almanac.narrative.regen',  delaySec: 600,  data: baseData },
    { name: 'phase7-chunk-embed',       event: 'workgraph/chunk-embed.run',          delaySec: 720,  data: {} },
  ];

  const now = Date.now();
  const dispatched: { phase: string; event: string; scheduled_at: string }[] = [];

  for (const p of phases) {
    const ts = now + p.delaySec * 1000;
    try {
      await inngest.send({ name: p.event, data: p.data, ts });
      dispatched.push({
        phase: p.name,
        event: p.event,
        scheduled_at: new Date(ts).toISOString(),
      });
    } catch (err) {
      // Inngest dev server tolerates missing event keys; in prod misconfiguration
      // would surface here. Bail out partial — the user can re-run.
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        {
          error: `Failed to enqueue ${p.event}: ${msg}`,
          dispatched,
        },
        { status: 502 },
      );
    }
  }

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
    dispatched,
    diagnostics: {
      connectors_in_workspace: ctx?.connectors ?? 0,
      paired_agents: ctx?.paired_agents ?? 0,
      online_agents: ctx?.online_agents ?? 0,
      hint:
        (ctx?.online_agents ?? 0) === 0
          ? 'No online agent. Run `workgraph run` in another terminal so the agent picks up jobs.'
          : (ctx?.connectors ?? 0) === 0
            ? `No connectors in workspace '${workspaceId}'. Connect a GitHub repo first.`
            : null,
    },
  });
}
