import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { getCustomRow, resolveWorkspaceForTable } from '@/lib/custom-tables';
import { syncPipelineRowToGraph, type PipelineTable } from '@/lib/pipelines/graph-sync';

const PIPELINE_TABLE_IDS = new Set(['deals', 'investors', 'people']);

export const dynamic = 'force-dynamic';

interface LinkBody {
  source?: unknown;
  source_id?: unknown;
}

/**
 * Reconcile last_touch on the pipeline row against pipeline_links join
 * work_items. Mirrors the logic in `pipelines/persist.ts` but stays inside
 * this API route so manual pin/unpin actions get the same freshness update.
 */
async function reconcileLastTouch(tableId: string, rowId: string): Promise<void> {
  const db = getLibsqlDb();
  const sql = `UPDATE "${tableId}" SET last_touch = (
      SELECT MAX(wi.created_at) FROM pipeline_links pl
      JOIN work_items wi ON wi.source = pl.item_source AND wi.source_id = pl.item_source_id
      WHERE pl.pipeline_table = ? AND pl.pipeline_row_id = "${tableId}".id
    ) WHERE id = ?`;
  try {
    await db.prepare(sql).run(tableId, rowId);
  } catch {
    // last_touch column missing — ignore.
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ table: string; id: string }> },
) {
  await ensureSchemaAsync();
  const { table: tableId, id: rowId } = await params;
  const resolved = await resolveWorkspaceForTable(tableId);
  if (!resolved) {
    return NextResponse.json({ error: 'unknown_table' }, { status: 404 });
  }
  const row = await getCustomRow(resolved.table, rowId);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let body: LinkBody;
  try {
    body = (await req.json()) as LinkBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  const sourceId = typeof body.source_id === 'string' ? body.source_id.trim() : '';
  if (!source || !sourceId) {
    return NextResponse.json({ error: 'source_and_source_id_required' }, { status: 400 });
  }

  const db = getLibsqlDb();
  await db
    .prepare(
      `INSERT OR IGNORE INTO pipeline_links
        (id, workspace_id, pipeline_table, pipeline_row_id, item_source, item_source_id, match_reason, confidence)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', 1.0)`,
    )
    .run(randomUUID(), resolved.workspace.id, tableId, rowId, source, sourceId);

  await reconcileLastTouch(tableId, rowId);
  if (PIPELINE_TABLE_IDS.has(tableId)) {
    await syncPipelineRowToGraph(tableId as PipelineTable, rowId);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ table: string; id: string }> },
) {
  await ensureSchemaAsync();
  const { table: tableId, id: rowId } = await params;
  const resolved = await resolveWorkspaceForTable(tableId);
  if (!resolved) {
    return NextResponse.json({ error: 'unknown_table' }, { status: 404 });
  }

  // DELETE accepts both query params and a JSON body.
  const url = new URL(req.url);
  let source = url.searchParams.get('source') ?? '';
  let sourceId = url.searchParams.get('source_id') ?? '';
  if (!source || !sourceId) {
    try {
      const body = (await req.json()) as LinkBody;
      if (typeof body.source === 'string') source = body.source;
      if (typeof body.source_id === 'string') sourceId = body.source_id;
    } catch {
      // no body — fall through to validation
    }
  }
  source = source.trim();
  sourceId = sourceId.trim();
  if (!source || !sourceId) {
    return NextResponse.json({ error: 'source_and_source_id_required' }, { status: 400 });
  }

  const db = getLibsqlDb();
  const result = await db
    .prepare(
      `DELETE FROM pipeline_links
        WHERE pipeline_table = ?
          AND pipeline_row_id = ?
          AND item_source = ?
          AND item_source_id = ?
          AND match_reason = 'manual'`,
    )
    .run(tableId, rowId, source, sourceId);

  await reconcileLastTouch(tableId, rowId);
  if (PIPELINE_TABLE_IDS.has(tableId)) {
    await syncPipelineRowToGraph(tableId as PipelineTable, rowId);
  }
  return NextResponse.json({ ok: true, removed: result.changes });
}
