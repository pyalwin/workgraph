import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { initSchema } from '@/lib/schema';

interface VersionRow {
  id: string;
  item_id: string;
  changed_fields: string;
  snapshot: string;
  changed_at: string;
}

interface LinkedItemRow {
  link_id: string;
  link_type: string;
  confidence: number;
  linked_item_id: string;
  title: string;
  body: string | null;
  source: string;
  source_id: string;
  item_type: string;
  author: string | null;
  status: string | null;
  url: string | null;
  created_at: string;
}

interface GoalRow {
  name: string;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    initSchema();
    const { id } = await params;
    const db = getDb();

    const item = db.prepare(`
      SELECT id, source, source_id, item_type, title, body, summary, author, status,
             priority, url, metadata, created_at, updated_at,
             trace_role, substance, trace_event_at, enriched_at
      FROM work_items WHERE id = ?
    `).get(id);

    if (!item) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Version history
    const versions = db.prepare(`
      SELECT id, item_id, changed_fields, snapshot, changed_at
      FROM work_item_versions
      WHERE item_id = ?
      ORDER BY changed_at DESC
    `).all(id) as VersionRow[];

    // Linked items with full details for the decision trail, sorted chronologically
    const linkedItems = db.prepare(`
      SELECT l.id as link_id, l.link_type, l.confidence,
        CASE WHEN l.source_item_id = ? THEN l.target_item_id ELSE l.source_item_id END as linked_item_id,
        wi.title, wi.body, wi.source, wi.source_id, wi.item_type, wi.author,
        wi.status, wi.url, wi.created_at
      FROM links l
      JOIN work_items wi ON wi.id = CASE WHEN l.source_item_id = ? THEN l.target_item_id ELSE l.source_item_id END
      WHERE l.source_item_id = ? OR l.target_item_id = ?
      ORDER BY wi.created_at ASC
    `).all(id, id, id, id) as LinkedItemRow[];

    // Goal tags
    const goals = db.prepare(`
      SELECT g.name FROM item_tags it JOIN goals g ON g.id = it.tag_id WHERE it.item_id = ?
    `).all(id) as GoalRow[];

    // Workstream memberships
    const workstreams = db.prepare(`
      SELECT ws.id, ws.narrative, ws.timeline_events, ws.earliest_at, ws.latest_at,
             wsi.is_seed, wsi.is_terminal, wsi.role_in_workstream
      FROM workstream_items wsi
      JOIN workstreams ws ON ws.id = wsi.workstream_id
      WHERE wsi.item_id = ?
      ORDER BY ws.latest_at DESC
    `).all(id).map((w: any) => ({
      ...w,
      timeline_events: w.timeline_events ? JSON.parse(w.timeline_events) : [],
    }));

    return NextResponse.json({ item, versions, linkedItems, goals, workstreams });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
