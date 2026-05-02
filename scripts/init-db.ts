import { initSchema } from '../src/lib/schema';
import { getDb } from '../src/lib/db';
import { seedWorkspaceConfig } from '../src/lib/workspace-config';

async function main() {
  console.log('Initializing database...');
  initSchema();
  await seedWorkspaceConfig();

  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  const workspaces = db.prepare('SELECT id, enabled FROM workspace_config ORDER BY id').all() as { id: string; enabled: number }[];

  console.log(`\nTables created: ${tables.map(t => t.name).join(', ')}`);
  console.log(`Workspaces: ${workspaces.map(w => `${w.id}:${w.enabled ? 'enabled' : 'disabled'}`).join(', ')}`);
  console.log('Database ready.');
}

main().catch((err) => {
  console.error('Init failed:', err);
  process.exit(1);
});
