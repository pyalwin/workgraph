import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';
loadEnv({ path: join('/Users/arun/Documents/Projects/workgraph', '.env.local') });
loadEnv({ path: join('/Users/arun/Documents/Projects/workgraph', '.env') });

async function main() {
  const { ensureSchemaAsync } = await import('/Users/arun/Documents/Projects/workgraph/src/lib/db/init-schema-async');
  const { getConnectorConfigBySource } = await import('/Users/arun/Documents/Projects/workgraph/src/lib/connectors/config-store');
  await ensureSchemaAsync();
  const cfg = await getConnectorConfigBySource('engineering', 'github');
  if (!cfg) return console.log('no cfg');
  const opts = cfg.config.options as any;
  console.log('options keys:', Object.keys(opts ?? {}));
  console.log('options.repos:', JSON.stringify(opts?.repos)?.slice(0, 200));
  console.log('options.discovered.repos[0..2]:', JSON.stringify(opts?.discovered?.repos?.slice(0, 2)));
  const repos = opts?.repos ?? opts?.discovered?.repos ?? [];
  console.log('resolved repos count:', repos.length);
  console.log('first repo type:', typeof repos[0], 'id type:', typeof repos[0]?.id, 'id:', repos[0]?.id);
}
main().catch(console.error);
