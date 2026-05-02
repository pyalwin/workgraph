import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { computeAllMetrics } from '@/lib/metrics';
import { createLinksForAll } from '@/lib/crossref';
import { enrichAll } from '@/lib/sync/enrich';
import { generateAllRecaps } from '@/lib/sync/recap';
import { ingestItems } from '@/lib/sync/ingest';
import { getLibsqlDb } from '@/lib/db/libsql';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import type { WorkItemInput } from '@/lib/sync/types';

async function ingestMeetingsJson(): Promise<{ synced: number; skipped: number }> {
  const jsonPath = path.join(process.cwd(), 'data', 'meetings.json');
  if (!existsSync(jsonPath)) return { synced: 0, skipped: 0 };

  const meetings = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const items: WorkItemInput[] = meetings.map((m: any) => ({
    source: 'meeting',
    source_id: m.id,
    item_type: 'meeting',
    title: m.title || 'Untitled Meeting',
    body: m.summary || null,
    author: m.participants?.[0] || null,
    status: 'completed',
    priority: null,
    url: m.url || null,
    metadata: { participants: m.participants || [] },
    created_at: m.date ? new Date(m.date).toISOString() : new Date().toISOString(),
    updated_at: null,
  }));

  const result = await ingestItems(items);
  return { synced: result.itemsSynced, skipped: result.itemsSkipped };
}

export async function POST() {
  try {
    await ensureSchemaAsync();

    // Phase 1: Ingest local data (meetings.json)
    const meetingsResult = await ingestMeetingsJson();

    // Phase 2: Enrich un-enriched items with Haiku (summary, type, topics, entities, goals)
    const enrichResult = await enrichAll({ concurrency: 5 });

    // Phase 3: Cross-reference and metrics
    await createLinksForAll();
    await computeAllMetrics();

    // Phase 4: Generate project recaps
    await generateAllRecaps();

    const db = getLibsqlDb();
    const totalItemsRow = await db.prepare('SELECT COUNT(*) as c FROM work_items').get<{ c: number }>();
    const totalItems = totalItemsRow?.c ?? 0;
    const totalLinksRow = await db.prepare('SELECT COUNT(*) as c FROM links').get<{ c: number }>();
    const totalLinks = totalLinksRow?.c ?? 0;

    // Per-source breakdown
    const sources = ['jira', 'slack', 'meeting', 'notion', 'gmail'];
    const breakdown: Record<string, number> = {};
    for (const s of sources) {
      const row = await db
        .prepare('SELECT COUNT(*) as c FROM work_items WHERE source = ?')
        .get<{ c: number }>(s);
      breakdown[s] = row?.c ?? 0;
    }

    // Goals classification summary
    const goalStats = await db
      .prepare(
        `SELECT g.name, COUNT(it.item_id) as item_count
         FROM goals g
         LEFT JOIN item_tags it ON it.tag_id = g.id
         WHERE g.status = 'active'
         GROUP BY g.id
         ORDER BY g.sort_order`,
      )
      .all<{ name: string; item_count: number }>();

    return NextResponse.json({
      ok: true,
      message: 'Sync complete',
      totalItems,
      totalLinks,
      meetingsIngested: meetingsResult.synced,
      meetingsSkipped: meetingsResult.skipped,
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
    const sources = ['jira', 'slack', 'meeting', 'notion', 'gmail'];
    const status: Record<string, any> = {};

    for (const source of sources) {
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

    const totalItemsRow = await db.prepare('SELECT COUNT(*) as c FROM work_items').get<{ c: number }>();
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
