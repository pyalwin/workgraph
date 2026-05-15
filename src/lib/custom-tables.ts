import { randomUUID } from 'crypto';
import { getLibsqlDb } from './db/libsql';
import { listWorkspaceConfigs } from './workspace-config';
import type {
  CustomTableConfig,
  CustomTableColumn,
  CustomTableColumnType,
  WorkspaceConfig,
} from './workspace-config';

const IDENT = /^[a-z][a-z0-9_]*$/;

function assertIdent(value: string, kind: string) {
  if (!IDENT.test(value)) throw new Error(`Invalid ${kind}: ${value}`);
}

function sqlType(type: CustomTableColumnType): string {
  switch (type) {
    case 'integer':
    case 'boolean':
      return 'INTEGER';
    case 'real':
      return 'REAL';
    case 'datetime':
    case 'json':
    case 'text':
    default:
      return 'TEXT';
  }
}

function columnSql(column: CustomTableColumn): string {
  assertIdent(column.name, 'column name');
  const parts = [`"${column.name}"`, sqlType(column.type)];
  if (column.primaryKey) parts.push('PRIMARY KEY');
  if (column.required || column.primaryKey) parts.push('NOT NULL');
  if (column.name === 'created_at' && column.type === 'datetime') {
    parts.push("DEFAULT (datetime('now'))");
  }
  return parts.join(' ');
}

export async function ensureCustomTable(table: CustomTableConfig): Promise<void> {
  assertIdent(table.id, 'table id');
  if (!table.columns.length) throw new Error(`Custom table ${table.id} has no columns`);

  const primaryKeys = table.columns.filter((column) => column.primaryKey);
  if (primaryKeys.length > 1) throw new Error(`Custom table ${table.id} has multiple primary keys`);

  const db = getLibsqlDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS "${table.id}" (
      ${table.columns.map(columnSql).join(',\n      ')}
    );
  `);

  for (const column of table.columns) {
    if (!column.indexed) continue;
    assertIdent(column.name, 'indexed column');
    await db.exec(
      `CREATE INDEX IF NOT EXISTS "idx_${table.id}_${column.name}" ON "${table.id}"("${column.name}")`,
    );
  }
}

export async function ensureCustomTables(tables: CustomTableConfig[]): Promise<void> {
  for (const table of tables) await ensureCustomTable(table);
}

export type CustomRow = Record<string, string | number | boolean | null>;

/**
 * Find the (enabled-first) workspace whose customTables config defines this
 * table id. Returns the workspace config + the matching table config. If no
 * enabled workspace claims the table, falls back to scanning disabled
 * workspaces. Returns null if nothing is found.
 *
 * Used by API routes that operate on a custom table without an explicit
 * workspace_id in the path — the founder preset is currently the only owner
 * of `deals`/`investors`/`candidates`.
 */
export async function resolveWorkspaceForTable(
  tableId: string,
): Promise<{ workspace: WorkspaceConfig; table: CustomTableConfig } | null> {
  if (!IDENT.test(tableId)) return null;
  const workspaces = await listWorkspaceConfigs();
  const sorted = [...workspaces].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  for (const workspace of sorted) {
    const table = (workspace.customTables ?? []).find((t) => t.id === tableId);
    if (table) {
      // Lazy-materialize the SQLite table on first access. Idempotent
      // (CREATE TABLE IF NOT EXISTS) — covers workspaces created before
      // the founder preset's customTables were declared, and any future
      // preset that adds tables to an already-installed workspace.
      await ensureCustomTable(table);
      return { workspace, table };
    }
  }
  return null;
}

function coerceValue(column: CustomTableColumn, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;
  switch (column.type) {
    case 'integer':
      return typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10);
    case 'real':
      return typeof value === 'number' ? value : Number.parseFloat(String(value));
    case 'boolean':
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (value === 1 || value === 0) return value;
      const s = String(value).toLowerCase();
      return s === 'true' || s === '1' || s === 'yes' ? 1 : 0;
    case 'datetime':
    case 'text':
      return String(value);
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    default:
      return String(value);
  }
}

function pkColumn(table: CustomTableConfig): CustomTableColumn {
  const pk = table.columns.find((c) => c.primaryKey);
  if (!pk) throw new Error(`Custom table ${table.id} has no primary key`);
  return pk;
}

function quotedColumns(table: CustomTableConfig): string {
  return table.columns.map((c) => `"${c.name}"`).join(', ');
}

export async function listCustomRows(table: CustomTableConfig): Promise<CustomRow[]> {
  assertIdent(table.id, 'table id');
  const db = getLibsqlDb();
  const orderCol = table.columns.find((c) => c.name === 'last_touch')
    ? 'last_touch'
    : table.columns.find((c) => c.name === 'created_at')
      ? 'created_at'
      : pkColumn(table).name;
  const sql = `SELECT ${quotedColumns(table)} FROM "${table.id}" ORDER BY "${orderCol}" DESC NULLS LAST`;
  const rows = await db.prepare(sql).all<CustomRow>();
  return rows;
}

export async function getCustomRow(
  table: CustomTableConfig,
  id: string,
): Promise<CustomRow | undefined> {
  assertIdent(table.id, 'table id');
  const pk = pkColumn(table);
  const db = getLibsqlDb();
  const sql = `SELECT ${quotedColumns(table)} FROM "${table.id}" WHERE "${pk.name}" = ? LIMIT 1`;
  return db.prepare(sql).get<CustomRow>(id);
}

export async function insertCustomRow(
  table: CustomTableConfig,
  values: Record<string, unknown>,
): Promise<CustomRow> {
  assertIdent(table.id, 'table id');
  const pk = pkColumn(table);
  const now = new Date().toISOString();

  const colsToWrite: CustomTableColumn[] = [];
  const params: unknown[] = [];
  for (const column of table.columns) {
    if (column.name === pk.name) {
      const incoming = values[column.name];
      const id = typeof incoming === 'string' && incoming.trim() ? incoming.trim() : randomUUID();
      colsToWrite.push(column);
      params.push(id);
      continue;
    }
    if (column.name === 'created_at' && !(column.name in values)) {
      colsToWrite.push(column);
      params.push(now);
      continue;
    }
    if (!(column.name in values)) continue;
    const coerced = coerceValue(column, values[column.name]);
    if (coerced === null && column.required) {
      throw new Error(`Column ${column.name} is required`);
    }
    colsToWrite.push(column);
    params.push(coerced as string | number | null);
  }

  // Guarantee required non-pk columns are checked
  for (const column of table.columns) {
    if (column.required && !column.primaryKey && !colsToWrite.includes(column)) {
      throw new Error(`Column ${column.name} is required`);
    }
  }

  const cols = colsToWrite.map((c) => `"${c.name}"`).join(', ');
  const placeholders = colsToWrite.map(() => '?').join(', ');
  const sql = `INSERT INTO "${table.id}" (${cols}) VALUES (${placeholders})`;
  const db = getLibsqlDb();
  await db.prepare(sql).run(...(params as (string | number | null)[]));

  const idIdx = colsToWrite.findIndex((c) => c.primaryKey);
  const insertedId = String(params[idIdx]);
  const row = await getCustomRow(table, insertedId);
  if (!row) throw new Error('Inserted row not found');
  return row;
}

export async function updateCustomRow(
  table: CustomTableConfig,
  id: string,
  values: Record<string, unknown>,
): Promise<CustomRow | undefined> {
  assertIdent(table.id, 'table id');
  const pk = pkColumn(table);

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const column of table.columns) {
    if (column.primaryKey) continue;
    if (!(column.name in values)) continue;
    const coerced = coerceValue(column, values[column.name]);
    if (coerced === null && column.required) {
      throw new Error(`Column ${column.name} is required`);
    }
    sets.push(`"${column.name}" = ?`);
    params.push(coerced as string | number | null);
  }
  if (sets.length === 0) return getCustomRow(table, id);

  const sql = `UPDATE "${table.id}" SET ${sets.join(', ')} WHERE "${pk.name}" = ?`;
  const db = getLibsqlDb();
  await db.prepare(sql).run(...params, id);
  return getCustomRow(table, id);
}

export async function deleteCustomRow(table: CustomTableConfig, id: string): Promise<boolean> {
  assertIdent(table.id, 'table id');
  const pk = pkColumn(table);
  const db = getLibsqlDb();
  const result = await db
    .prepare(`DELETE FROM "${table.id}" WHERE "${pk.name}" = ?`)
    .run(id);
  return result.changes > 0;
}
