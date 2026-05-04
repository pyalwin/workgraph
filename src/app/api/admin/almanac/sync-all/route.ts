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

export async function POST(req: Request) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as SyncAllBody;
  const workspaceId = body.workspaceId ?? 'default';
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

  return NextResponse.json({
    ok: true,
    workspaceId,
    started_at: new Date(now).toISOString(),
    dispatched,
  });
}
