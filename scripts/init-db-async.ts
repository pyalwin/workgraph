#!/usr/bin/env tsx
/**
 * Async schema bootstrap — runs the libSQL init against whatever
 * DATABASE_URL points at. Use this for Turso (where the legacy sync init
 * can't reach). Idempotent — safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=libsql://<db>.turso.io \
 *   TURSO_AUTH_TOKEN=<token> \
 *   bun scripts/init-db-async.ts
 *
 * For local dev (file:./data/workgraph.db) the legacy `bun scripts/init-db.ts`
 * still works and creates the FULL schema; this async script only creates the
 * subset of tables that have been migrated to the async path. As more tables
 * migrate, port their DDL into src/lib/db/init-schema-async.ts.
 */

import { ensureSchemaAsync, _resetSchemaInitForTests } from '../src/lib/db/init-schema-async';
import { getLibsqlDb, isCloudUrl } from '../src/lib/db/libsql';

async function main() {
  const url = process.env.DATABASE_URL ?? 'file:./data/workgraph.db';
  const cloud = isCloudUrl(url);
  console.log(`[init-db-async] Target: ${url} (${cloud ? 'cloud / Turso' : 'local file'})`);
  if (cloud && !process.env.TURSO_AUTH_TOKEN) {
    console.warn('[init-db-async] WARNING: cloud URL detected but TURSO_AUTH_TOKEN is unset.');
  }

  _resetSchemaInitForTests(); // force a real run
  await ensureSchemaAsync();

  const db = getLibsqlDb();
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all<{ name: string }>();
  console.log(`[init-db-async] Tables present: ${tables.map((t) => t.name).join(', ')}`);
  console.log('[init-db-async] Async schema ready.');
}

main().catch((err) => {
  console.error('[init-db-async] Failed:', err);
  process.exit(1);
});
