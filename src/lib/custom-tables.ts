import { getDb } from './db';
import type { CustomTableConfig, CustomTableColumn, CustomTableColumnType } from './workspace-config';

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

export function ensureCustomTable(table: CustomTableConfig) {
  assertIdent(table.id, 'table id');
  if (!table.columns.length) throw new Error(`Custom table ${table.id} has no columns`);

  const primaryKeys = table.columns.filter((column) => column.primaryKey);
  if (primaryKeys.length > 1) throw new Error(`Custom table ${table.id} has multiple primary keys`);

  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS "${table.id}" (
      ${table.columns.map(columnSql).join(',\n      ')}
    );
  `);

  for (const column of table.columns) {
    if (!column.indexed) continue;
    assertIdent(column.name, 'indexed column');
    db.exec(`CREATE INDEX IF NOT EXISTS "idx_${table.id}_${column.name}" ON "${table.id}"("${column.name}")`);
  }
}

export function ensureCustomTables(tables: CustomTableConfig[]) {
  for (const table of tables) ensureCustomTable(table);
}
