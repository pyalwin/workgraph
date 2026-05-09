/**
 * Removes fixture-derived meeting work_items and their dependents.
 *
 * Targets specifically the source_ids listed in `data/meetings.json` so any
 * real Granola-synced meetings (if present) are preserved. If the fixture
 * file has already been deleted, falls back to deleting all rows where
 * source = 'meeting' (the user explicitly asked for a clean DB and confirmed
 * no real Granola login exists yet).
 *
 * Run with:  bunx tsx scripts/cleanup-fixture-meetings.ts
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.join(process.cwd(), '.env.local') });
loadEnv({ path: path.join(process.cwd(), '.env') });

import { getLibsqlDb } from '../src/lib/db/libsql';
import { ensureSchemaAsync } from '../src/lib/db/init-schema-async';

async function main() {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const fixturePath = path.join(process.cwd(), 'data', 'meetings.json');
  let fixtureIds: string[] | null = null;
  if (existsSync(fixturePath)) {
    try {
      const raw = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Array<{ id?: string }>;
      fixtureIds = raw.map((m) => m.id).filter((id): id is string => typeof id === 'string');
      console.log(`Fixture file present with ${fixtureIds.length} meeting(s).`);
    } catch (err) {
      console.warn(`Could not parse ${fixturePath}, falling back to source='meeting' cleanup:`, err);
    }
  } else {
    console.log(`No fixture file at ${fixturePath}; cleaning all source='meeting' rows.`);
  }

  // Find the work_item.ids to remove.
  let targetIds: string[];
  if (fixtureIds && fixtureIds.length > 0) {
    const placeholders = fixtureIds.map(() => '?').join(',');
    const rows = await db
      .prepare(
        `SELECT id FROM work_items
         WHERE source = 'meeting' AND source_id IN (${placeholders})`,
      )
      .all<{ id: string }>(...fixtureIds);
    targetIds = rows.map((r) => r.id);
  } else {
    const rows = await db
      .prepare(`SELECT id FROM work_items WHERE source = 'meeting'`)
      .all<{ id: string }>();
    targetIds = rows.map((r) => r.id);
  }

  if (targetIds.length === 0) {
    console.log('No fixture meetings found in DB — nothing to clean up.');
    return;
  }

  console.log(`Deleting ${targetIds.length} meeting work_item(s) and dependents...`);

  // Delete dependents first (no ON DELETE CASCADE on most FKs).
  const ph = targetIds.map(() => '?').join(',');
  // Each entry: [sql, params]. Most queries reference targetIds once;
  // `links` references it twice.
  const ops: Array<[string, string[]]> = [
    [`DELETE FROM chunk_embeddings_meta WHERE chunk_id IN (SELECT id FROM item_chunks WHERE item_id IN (${ph}))`, targetIds],
    [`DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM item_chunks WHERE item_id IN (${ph}))`, targetIds],
    [`DELETE FROM item_chunks WHERE item_id IN (${ph})`, targetIds],
    [`DELETE FROM item_tags WHERE item_id IN (${ph})`, targetIds],
    [`DELETE FROM links WHERE source_item_id IN (${ph}) OR target_item_id IN (${ph})`, [...targetIds, ...targetIds]],
    [`DELETE FROM work_item_versions WHERE item_id IN (${ph})`, targetIds],
    [`DELETE FROM entity_mentions WHERE item_id IN (${ph})`, targetIds],
    [`DELETE FROM workstream_items WHERE item_id IN (${ph})`, targetIds],
    [`DELETE FROM decisions WHERE item_id IN (${ph})`, targetIds],
    [`DELETE FROM action_items WHERE source_item_id IN (${ph})`, targetIds],
    [`DELETE FROM work_items WHERE id IN (${ph})`, targetIds],
  ];

  for (const [sql, params] of ops) {
    try {
      const r = await db.prepare(sql).run(...params);
      const tableName = sql.match(/DELETE FROM (\w+)/)?.[1] ?? '?';
      console.log(`  ${tableName}: ${r.changes} row(s) removed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If a referenced table doesn't exist, skip — the schema is forward
      // and some installs may be missing optional tables.
      if (msg.includes('no such table')) continue;
      throw err;
    }
  }

  // Clear sync_log entries for the source.
  const logResult = await db
    .prepare(`DELETE FROM sync_log WHERE source = 'meeting'`)
    .run();
  console.log(`  sync_log: ${logResult.changes} row(s) removed`);

  console.log('Done.');
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
