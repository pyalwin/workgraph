import { initSchema } from '../src/lib/schema';
import { getDb } from '../src/lib/db';
import { getLastSyncDate } from '../src/lib/sync/log';

initSchema();

const sources = ['jira', 'slack', 'meeting', 'notion', 'gmail'];
const db = getDb();

console.log('=== Sync Status ===');
for (const source of sources) {
  const lastSync = getLastSyncDate(source);
  const count = (db.prepare('SELECT COUNT(*) as c FROM work_items WHERE source = ?').get(source) as any)?.c || 0;
  console.log(`${source}: ${count} items, last sync: ${lastSync || 'never'}`);
}

const totalItems = (db.prepare('SELECT COUNT(*) as c FROM work_items').get() as any)?.c || 0;
const totalVersions = (db.prepare('SELECT COUNT(*) as c FROM work_item_versions').get() as any)?.c || 0;
const totalLinks = (db.prepare('SELECT COUNT(*) as c FROM links').get() as any)?.c || 0;
console.log(`\nTotals: ${totalItems} items, ${totalVersions} versions, ${totalLinks} cross-references`);
