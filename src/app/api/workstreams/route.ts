import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { initSchema } from '@/lib/schema';

export const dynamic = 'force-dynamic';

export async function GET() {
  initSchema();
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      ws.id, ws.narrative, ws.timeline_events, ws.earliest_at, ws.latest_at, ws.generated_at,
      COUNT(wsi.item_id) AS item_count,
      SUM(wsi.is_seed) AS seed_count,
      SUM(wsi.is_terminal) AS terminal_count,
      GROUP_CONCAT(DISTINCT wi.source) AS sources
    FROM workstreams ws
    LEFT JOIN workstream_items wsi ON wsi.workstream_id = ws.id
    LEFT JOIN work_items wi ON wi.id = wsi.item_id
    GROUP BY ws.id
    ORDER BY ws.latest_at DESC
  `).all() as any[];

  const workstreams = rows.map(r => ({
    id: r.id,
    narrative: r.narrative,
    timeline_events: r.timeline_events ? JSON.parse(r.timeline_events) : [],
    earliest_at: r.earliest_at,
    latest_at: r.latest_at,
    generated_at: r.generated_at,
    item_count: r.item_count,
    seed_count: r.seed_count,
    terminal_count: r.terminal_count,
    sources: r.sources ? r.sources.split(',') : [],
  }));

  return NextResponse.json({ workstreams });
}
