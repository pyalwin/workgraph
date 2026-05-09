import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: path.join(process.cwd(), '.env.local') });
loadEnv({ path: path.join(process.cwd(), '.env') });

import { ensureSchemaAsync } from '../src/lib/db/init-schema-async';
import { getLibsqlDb } from '../src/lib/db/libsql';

async function main() {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const cols = await db.prepare(`PRAGMA table_info(project_summaries)`).all<{ name: string; type: string }>();
  console.log('project_summaries columns:');
  for (const c of cols) console.log(' ', c.name, c.type);
  const ps = await db
    .prepare(`SELECT project_key, name, created_via FROM project_summaries`)
    .all<{ project_key: string; name: string; created_via: string | null }>();
  console.log('rows:', ps);
}

main().catch((e) => { console.error(e); process.exit(1); });
