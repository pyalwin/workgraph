/**
 * Read-only diagnostic: show meeting work_items in the DB.
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.join(process.cwd(), '.env.local') });
loadEnv({ path: path.join(process.cwd(), '.env') });

import { getLibsqlDb } from '../src/lib/db/libsql';
import { ensureSchemaAsync } from '../src/lib/db/init-schema-async';

async function main() {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const sources = await db
    .prepare(`SELECT source, COUNT(*) AS c FROM work_items GROUP BY source ORDER BY c DESC`)
    .all<{ source: string; c: number }>();
  console.log('work_items by source:');
  for (const r of sources) console.log(`  ${r.source}: ${r.c}`);

  const meetings = await db
    .prepare(
      `SELECT id, source, source_id, title, created_at, synced_at
       FROM work_items
       WHERE source = 'meeting' OR item_type = 'meeting'
       ORDER BY synced_at DESC LIMIT 5`,
    )
    .all<{ id: string; source: string; source_id: string; title: string; created_at: string; synced_at: string }>();
  console.log('\nFirst 5 meeting rows:');
  for (const m of meetings) {
    console.log(`  ${m.source} / ${m.source_id} :: ${m.title}  (synced ${m.synced_at})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
