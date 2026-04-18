import { NextResponse } from 'next/server';
import { initSchema, seedGoals, seedConfig } from '@/lib/schema';
import { computeAllMetrics } from '@/lib/metrics';
import { createLinksForAll } from '@/lib/crossref';
import { enrichAll } from '@/lib/sync/enrich';
import { generateAllRecaps } from '@/lib/sync/recap';
import { ingestItems } from '@/lib/sync/ingest';
import { getDb } from '@/lib/db';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import type { WorkItemInput } from '@/lib/sync/types';

function ingestMeetingsJson(): { synced: number; skipped: number } {
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

  const result = ingestItems(items);
  return { synced: result.itemsSynced, skipped: result.itemsSkipped };
}

export async function POST() {
  try {
    initSchema();
    seedGoals();
    seedConfig();

    // Phase 1: Ingest local data (meetings.json)
    const meetingsResult = ingestMeetingsJson();

    // Phase 2: Enrich un-enriched items with Haiku (summary, type, topics, entities, goals)
    const enrichResult = await enrichAll({ concurrency: 5 });

    // Phase 3: Cross-reference and metrics
    createLinksForAll();
    computeAllMetrics();

    // Phase 4: Generate project recaps
    const recapResult = await generateAllRecaps();

    const db = getDb();
    const totalItems = (db.prepare('SELECT COUNT(*) as c FROM work_items').get() as any)?.c || 0;
    const totalLinks = (db.prepare('SELECT COUNT(*) as c FROM links').get() as any)?.c || 0;

    // Per-source breakdown
    const sources = ['jira', 'slack', 'meeting', 'notion', 'gmail'];
    const breakdown: Record<string, number> = {};
    for (const s of sources) {
      breakdown[s] = (db.prepare('SELECT COUNT(*) as c FROM work_items WHERE source = ?').get(s) as any)?.c || 0;
    }

    // Goals classification summary
    const goalStats = db.prepare(`
      SELECT g.name, COUNT(it.item_id) as item_count
      FROM goals g
      LEFT JOIN item_tags it ON it.tag_id = g.id
      WHERE g.status = 'active'
      GROUP BY g.id
      ORDER BY g.sort_order
    `).all() as { name: string; item_count: number }[];

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
    initSchema();
    const db = getDb();
    const sources = ['jira', 'slack', 'meeting', 'notion', 'gmail'];
    const status: Record<string, any> = {};

    for (const source of sources) {
      const count = (db.prepare('SELECT COUNT(*) as c FROM work_items WHERE source = ?').get(source) as any)?.c || 0;
      const lastSync = db.prepare("SELECT completed_at FROM sync_log WHERE source = ? AND status = 'success' ORDER BY completed_at DESC LIMIT 1").get(source) as any;
      status[source] = { count, lastSync: lastSync?.completed_at || null };
    }

    const totalItems = (db.prepare('SELECT COUNT(*) as c FROM work_items').get() as any)?.c || 0;
    const totalVersions = (db.prepare('SELECT COUNT(*) as c FROM work_item_versions').get() as any)?.c || 0;
    const totalLinks = (db.prepare('SELECT COUNT(*) as c FROM links').get() as any)?.c || 0;

    return NextResponse.json({ totalItems, totalVersions, totalLinks, sources: status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
