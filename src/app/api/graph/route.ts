import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { initSchema } from '@/lib/schema';

export const dynamic = 'force-dynamic';

export async function GET() {
  initSchema();
  const db = getDb();

  const items = db.prepare(`
    SELECT
      wi.id, wi.title, wi.summary, wi.source, wi.source_id, wi.item_type, wi.status,
      wi.author, wi.url, wi.body, wi.created_at,
      wi.trace_role, wi.substance, wi.trace_event_at,
      (SELECT GROUP_CONCAT(DISTINCT t.name) FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = wi.id AND t.category = 'type') as type_tag,
      (SELECT GROUP_CONCAT(DISTINCT t.name) FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = wi.id AND t.category = 'topic') as topic_tags,
      (SELECT GROUP_CONCAT(DISTINCT g.name) FROM item_tags it JOIN goals g ON g.id = it.tag_id WHERE it.item_id = wi.id) as goal_names,
      (SELECT GROUP_CONCAT(wsi.workstream_id) FROM workstream_items wsi WHERE wsi.item_id = wi.id) as workstream_ids
    FROM work_items wi
    ORDER BY wi.created_at DESC
    LIMIT 300
  `).all();

  const edges = db.prepare(`
    SELECT l.id, l.source_item_id, l.target_item_id, l.link_type, l.confidence
    FROM links l
    WHERE l.source_item_id IN (SELECT id FROM work_items LIMIT 300)
      OR l.target_item_id IN (SELECT id FROM work_items LIMIT 300)
  `).all();

  return NextResponse.json({ nodes: items, edges });
}
