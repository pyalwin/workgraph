/**
 * Manual trigger for the per-ticket PR delivery summary + decisions + anomalies.
 * Runs the generator inline (not via Inngest) so the user gets the result
 * back in the response — useful for the drawer's "Regenerate" button.
 */
import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { generateIssuePrSummary } from '@/lib/sync/issue-pr-summary';

export const dynamic = 'force-dynamic';

async function resolveWorkspaceId(): Promise<string | null> {
  const db = getLibsqlDb();
  // Prefer the workspace tied to whichever github connector is configured —
  // anomaly rows are workspace-scoped and PR summaries write anomalies.
  const cfg = await db
    .prepare(
      `SELECT workspace_id FROM workspace_connector_configs
       WHERE source = 'github' AND status != 'skipped'
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get<{ workspace_id: string }>();
  if (cfg) return cfg.workspace_id;
  // Fallback: any aliased workspace.
  const alias = await db
    .prepare(`SELECT workspace_id FROM workspace_user_aliases LIMIT 1`)
    .get<{ workspace_id: string }>();
  return alias?.workspace_id ?? null;
}

export async function POST(
  _req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params;
  await ensureSchemaAsync();
  const issueItemId = params.id;
  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { ok: false, error: 'No workspace context — install a connector first' },
      { status: 400 },
    );
  }
  const result = await generateIssuePrSummary(workspaceId, issueItemId);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.reason }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    trailCount: result.trailCount,
    decisionCount: result.decisionCount,
    anomalyCount: result.anomalyCount,
    prIntentCount: result.prIntentCount,
    gapStatus: result.gapStatus,
  });
}
