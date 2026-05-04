/**
 * Smoke test for the local libsql-server (Docker) setup.
 *
 * Verifies:
 *   - Schema initialises against http://127.0.0.1:8081
 *   - vector_distance_cos() is available — without this Phase 7 RAG breaks
 *   - All Almanac tables are present after ensureSchemaAsync()
 *
 * Pre-req: `npm run db:up` (or docker compose up -d libsql) is running.
 *
 * Run: `DATABASE_URL=http://127.0.0.1:8081 npx tsx scripts/smoke-libsql-local.ts`
 */
import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';

loadEnv({ path: join(process.cwd(), '.env.local') });
loadEnv({ path: join(process.cwd(), '.env') });

// Force the local URL for this smoke run regardless of what's in .env.local.
process.env.DATABASE_URL = process.env.DATABASE_URL_LOCAL ?? 'http://127.0.0.1:8081';
delete process.env.TURSO_AUTH_TOKEN;

async function main() {
  console.log(`[1/4] connecting to ${process.env.DATABASE_URL}`);
  const { ensureSchemaAsync, _resetSchemaInitForTests } = await import('../src/lib/db/init-schema-async');
  const { getLibsqlDb, _resetLibsqlForTests } = await import('../src/lib/db/libsql');
  _resetLibsqlForTests();
  _resetSchemaInitForTests();

  console.log('[2/4] ensureSchemaAsync — runs full DDL + Phase 1.6 migration');
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // Required Almanac tables — quick sanity that the schema landed.
  const required = [
    'agent_pairings', 'agent_jobs',
    'code_events', 'code_events_backfill_state',
    'file_lifecycle',
    'modules', 'functional_units', 'functional_unit_aliases',
    'orphan_ticket_candidates',
    'almanac_sections',
    'item_chunks', 'chunk_vectors',
  ];
  console.log('[3/4] table presence');
  for (const t of required) {
    const row = await db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
    ).get<{ name: string }>(t);
    if (!row) throw new Error(`missing table: ${t}`);
    console.log(`  ✓ ${t}`);
  }

  console.log('[4/4] vector_distance_cos availability');
  // Build two trivial 4-d vectors and compute cosine distance.
  // libsql stores embeddings as BLOB; vector_distance_cos accepts the JSON
  // helper or raw blob. We use vector('[ ... ]') JSON form which is what
  // libsql-server documents.
  try {
    const row = await db.prepare(
      `SELECT vector_distance_cos(vector('[1.0,0.0,0.0,0.0]'), vector('[0.0,1.0,0.0,0.0]')) AS d`
    ).get<{ d: number }>();
    if (row?.d === undefined) throw new Error('vector_distance_cos returned undefined');
    console.log(`  ✓ vector_distance_cos(orthogonal) = ${row.d}  (expected ~1.0)`);
    if (Math.abs(row.d - 1.0) > 0.001) throw new Error(`unexpected distance: ${row.d}`);
  } catch (err) {
    throw new Error(
      `vector_distance_cos NOT available — Phase 7 RAG vector search will not work.\n` +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  console.log('\nPASS — local libsql-server is fully functional (schema + vector search).');
}

main().catch((err) => {
  console.error('\nFAIL:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
