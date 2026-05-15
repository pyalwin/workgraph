import { NextRequest, NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { computeAllMetrics } from '@/lib/metrics';
import { createLinksForAll } from '@/lib/crossref';
import { enrichAll } from '@/lib/sync/enrich';
import { generateAllRecaps } from '@/lib/sync/recap';
import { getLibsqlDb } from '@/lib/db/libsql';
import {
  buildWorkspaceItemFilter,
  getActiveWorkspaceId,
  getRequestWorkspaceId,
} from '@/lib/active-workspace';

export async function POST(req: NextRequest) {
  try {
    await ensureSchemaAsync();

    const workspaceId = await getRequestWorkspaceId(req.nextUrl.searchParams);

    // Enrich un-enriched items (summary, type, topics, entities, goals)
    const enrichResult = await enrichAll({ workspaceId, concurrency: 5 });

    // Cross-reference + metrics
    await createLinksForAll();
    await computeAllMetrics(workspaceId);

    // Project recaps
    await generateAllRecaps();

    const db = getLibsqlDb();
    const filter = await buildWorkspaceItemFilter(workspaceId, 'wi');
    const totalItemsRow = await db
      .prepare(`SELECT COUNT(*) as c FROM work_items wi WHERE ${filter.sql}`)
      .get<{ c: number }>(...filter.params);
    const totalItems = totalItemsRow?.c ?? 0;
    const totalLinksRow = await db.prepare('SELECT COUNT(*) as c FROM links').get<{ c: number }>();
    const totalLinks = totalLinksRow?.c ?? 0;

    // Per-source breakdown — only sources configured in this workspace.
    const wsSources = await db
      .prepare(
        'SELECT DISTINCT source FROM workspace_connector_configs WHERE workspace_id = ?',
      )
      .all<{ source: string }>(workspaceId);
    const breakdown: Record<string, number> = {};
    for (const { source } of wsSources) {
      const row = await db
        .prepare('SELECT COUNT(*) as c FROM work_items WHERE source = ?')
        .get<{ c: number }>(source);
      breakdown[source] = row?.c ?? 0;
    }

    // Goals classification summary — counts scoped to this workspace.
    const goalStats = await db
      .prepare(
        `SELECT g.name, COUNT(it.item_id) as item_count
         FROM goals g
         LEFT JOIN item_tags it ON it.tag_id = g.id
         LEFT JOIN work_items wi ON wi.id = it.item_id AND ${filter.sql}
         WHERE g.workspace_id = ? AND g.status = 'active'
         GROUP BY g.id
         ORDER BY g.sort_order`,
      )
      .all<{ name: string; item_count: number }>(...filter.params, workspaceId);

    return NextResponse.json({
      ok: true,
      message: 'Sync complete',
      totalItems,
      totalLinks,
      enriched: enrichResult.enriched,
      enrichFailed: enrichResult.failed,
      breakdown,
      goalStats,
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    await ensureSchemaAsync();
    const db = getLibsqlDb();
    const workspaceId = await getActiveWorkspaceId();

    // Only show status for connectors actually configured in this workspace.
    const wsSources = await db
      .prepare(
        'SELECT DISTINCT source FROM workspace_connector_configs WHERE workspace_id = ?',
      )
      .all<{ source: string }>(workspaceId);
    const status: Record<string, any> = {};

    for (const { source } of wsSources) {
      const countRow = await db
        .prepare('SELECT COUNT(*) as c FROM work_items WHERE source = ?')
        .get<{ c: number }>(source);
      const lastSync = await db
        .prepare(
          "SELECT completed_at FROM sync_log WHERE source = ? AND status = 'success' ORDER BY completed_at DESC LIMIT 1",
        )
        .get<{ completed_at: string }>(source);
      status[source] = { count: countRow?.c ?? 0, lastSync: lastSync?.completed_at || null };
    }

    const filter = await buildWorkspaceItemFilter(workspaceId, 'wi');
    const totalItemsRow = await db
      .prepare(`SELECT COUNT(*) as c FROM work_items wi WHERE ${filter.sql}`)
      .get<{ c: number }>(...filter.params);
    const totalVersionsRow = await db.prepare('SELECT COUNT(*) as c FROM work_item_versions').get<{ c: number }>();
    const totalLinksRow = await db.prepare('SELECT COUNT(*) as c FROM links').get<{ c: number }>();

    return NextResponse.json({
      totalItems: totalItemsRow?.c ?? 0,
      totalVersions: totalVersionsRow?.c ?? 0,
      totalLinks: totalLinksRow?.c ?? 0,
      sources: status,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
