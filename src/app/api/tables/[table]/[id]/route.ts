import { NextRequest, NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import {
  deleteCustomRow,
  getCustomRow,
  resolveWorkspaceForTable,
  updateCustomRow,
} from '@/lib/custom-tables';
import {
  removePipelineRowFromGraph,
  syncPipelineRowToGraph,
  type PipelineTable,
} from '@/lib/pipelines/graph-sync';

const PIPELINE_TABLE_IDS = new Set(['deals', 'investors', 'people']);

export const dynamic = 'force-dynamic';

interface LinkedItemRow {
  link_id: string;
  match_reason: string;
  confidence: number;
  link_created_at: string | null;
  id: string;
  source: string;
  source_id: string;
  item_type: string;
  title: string;
  body: string | null;
  summary: string | null;
  author: string | null;
  status: string | null;
  url: string | null;
  created_at: string;
}

async function loadLinkedItems(tableId: string, rowId: string): Promise<LinkedItemRow[]> {
  const db = getLibsqlDb();
  const sql = `
    SELECT
      pl.id AS link_id,
      pl.match_reason,
      pl.confidence,
      pl.created_at AS link_created_at,
      wi.id, wi.source, wi.source_id, wi.item_type, wi.title, wi.body,
      wi.summary, wi.author, wi.status, wi.url, wi.created_at
    FROM pipeline_links pl
    JOIN work_items wi
      ON wi.source = pl.item_source AND wi.source_id = pl.item_source_id
    WHERE pl.pipeline_table = ? AND pl.pipeline_row_id = ?
    ORDER BY wi.created_at DESC
    LIMIT 200
  `;
  try {
    return await db.prepare(sql).all<LinkedItemRow>(tableId, rowId);
  } catch {
    return [];
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ table: string; id: string }> },
) {
  await ensureSchemaAsync();
  const { table: tableId, id } = await params;
  const resolved = await resolveWorkspaceForTable(tableId);
  if (!resolved) {
    return NextResponse.json({ error: 'unknown_table' }, { status: 404 });
  }
  const row = await getCustomRow(resolved.table, id);
  if (!row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const links = await loadLinkedItems(tableId, id);
  return NextResponse.json({
    table: resolved.table,
    workspace_id: resolved.workspace.id,
    row,
    linked_items: links,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ table: string; id: string }> },
) {
  await ensureSchemaAsync();
  const { table: tableId, id } = await params;
  const resolved = await resolveWorkspaceForTable(tableId);
  if (!resolved) {
    return NextResponse.json({ error: 'unknown_table' }, { status: 404 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  try {
    const row = await updateCustomRow(resolved.table, id, body ?? {});
    if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (PIPELINE_TABLE_IDS.has(tableId)) {
      // Pass workspaceId so changes to match keys (e.g. updating a deal's
      // domain) backfill new pipeline_links against existing items right
      // away — same shape as the create path.
      await syncPipelineRowToGraph(tableId as PipelineTable, id, {
        workspaceId: resolved.workspace.id,
      });
    }
    return NextResponse.json({ row });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ table: string; id: string }> },
) {
  await ensureSchemaAsync();
  const { table: tableId, id } = await params;
  const resolved = await resolveWorkspaceForTable(tableId);
  if (!resolved) {
    return NextResponse.json({ error: 'unknown_table' }, { status: 404 });
  }
  const ok = await deleteCustomRow(resolved.table, id);
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (PIPELINE_TABLE_IDS.has(tableId)) {
    await removePipelineRowFromGraph(tableId as PipelineTable, id);
  }
  return NextResponse.json({ ok: true });
}
