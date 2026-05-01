import { NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { ensureCustomTable } from '@/lib/custom-tables';
import {
  addCustomTableToWorkspace,
  seedWorkspaceConfig,
  type CustomTableColumn,
  type CustomTableColumnType,
  type CustomTableConfig,
} from '@/lib/workspace-config';

export const dynamic = 'force-dynamic';

const TYPES = new Set<CustomTableColumnType>(['text', 'integer', 'real', 'datetime', 'json', 'boolean']);
const IDENT = /^[a-z][a-z0-9_]*$/;

function normalizeColumn(input: any): CustomTableColumn {
  const name = String(input.name || '').trim().toLowerCase();
  const type = String(input.type || 'text').trim().toLowerCase() as CustomTableColumnType;
  if (!IDENT.test(name)) throw new Error(`Invalid column name: ${name}`);
  if (!TYPES.has(type)) throw new Error(`Invalid column type: ${type}`);
  return {
    name,
    type,
    required: Boolean(input.required),
    primaryKey: Boolean(input.primaryKey),
    indexed: Boolean(input.indexed),
  };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    initSchema();
    seedWorkspaceConfig();
    const { id: workspaceId } = await params;
    const body = await req.json();

    const tableId = String(body.id || '').trim().toLowerCase();
    const label = String(body.label || body.id || '').trim();
    if (!IDENT.test(tableId)) throw new Error('Table id must be lowercase snake_case and start with a letter');
    if (!label) throw new Error('Table label is required');
    if (!Array.isArray(body.columns) || body.columns.length === 0) {
      throw new Error('At least one column is required');
    }

    const table: CustomTableConfig = {
      id: tableId,
      label,
      module: body.module ? String(body.module) : undefined,
      description: body.description ? String(body.description) : undefined,
      columns: body.columns.map(normalizeColumn),
    };

    ensureCustomTable(table);
    const workspace = addCustomTableToWorkspace(workspaceId, table);
    return NextResponse.json({ ok: true, table, workspace });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }
}
