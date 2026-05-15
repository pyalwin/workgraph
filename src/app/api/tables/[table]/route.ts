import { NextRequest, NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import {
  insertCustomRow,
  listCustomRows,
  resolveWorkspaceForTable,
} from '@/lib/custom-tables';
import { syncPipelineRowToGraph, type PipelineTable } from '@/lib/pipelines/graph-sync';

const PIPELINE_TABLE_IDS = new Set(['deals', 'investors', 'people']);

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ table: string }> },
) {
  await ensureSchemaAsync();
  const { table: tableId } = await params;
  const resolved = await resolveWorkspaceForTable(tableId);
  if (!resolved) {
    return NextResponse.json({ error: 'unknown_table' }, { status: 404 });
  }
  const rows = await listCustomRows(resolved.table);
  return NextResponse.json({
    table: resolved.table,
    workspace_id: resolved.workspace.id,
    rows,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ table: string }> },
) {
  await ensureSchemaAsync();
  const { table: tableId } = await params;
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
    const row = await insertCustomRow(resolved.table, body ?? {});
    if (PIPELINE_TABLE_IDS.has(tableId) && typeof row.id === 'string') {
      // Pass workspaceId so syncPipelineRowToGraph can backfill matches
      // against existing gmail/gcal/gdrive items as soon as the row's
      // domain/email is set — no manual Rebuild click needed.
      await syncPipelineRowToGraph(tableId as PipelineTable, row.id, {
        workspaceId: resolved.workspace.id,
      });
    }
    return NextResponse.json({ row }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
