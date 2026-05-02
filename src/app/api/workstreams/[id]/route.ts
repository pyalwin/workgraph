import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await ensureSchemaAsync();
  const { id } = await params;
  const db = getLibsqlDb();

  const ws = await db
    .prepare(
      `SELECT id, narrative, timeline_events, earliest_at, latest_at, generated_at
       FROM workstreams WHERE id = ?`,
    )
    .get<any>(id);
  if (!ws) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const items = await db
    .prepare(
      `SELECT
        wi.id, wi.source, wi.source_id, wi.item_type, wi.title, wi.summary, wi.body,
        wi.trace_role, wi.substance, wi.trace_event_at, wi.created_at, wi.url,
        wsi.is_seed, wsi.is_terminal, wsi.role_in_workstream, wsi.event_at
      FROM workstream_items wsi
      JOIN work_items wi ON wi.id = wsi.item_id
      WHERE wsi.workstream_id = ?
      ORDER BY COALESCE(wsi.event_at, wi.created_at) ASC`,
    )
    .all(id);

  return NextResponse.json({
    workstream: {
      id: ws.id,
      narrative: ws.narrative,
      timeline_events: ws.timeline_events ? JSON.parse(ws.timeline_events) : [],
      earliest_at: ws.earliest_at,
      latest_at: ws.latest_at,
      generated_at: ws.generated_at,
    },
    items,
  });
}
