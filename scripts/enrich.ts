import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env.local from project root
config({ path: resolve(process.cwd(), '.env.local') });

import { enrichAll } from '../src/lib/sync/enrich';

const force = process.argv.includes('--force');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : undefined;

console.log('Enriching work items with Claude Haiku...');
if (force) console.log('  Force re-enrich: true');
if (limit) console.log(`  Limit: ${limit}`);

enrichAll({ force, limit, concurrency: 5 }).then(result => {
  console.log('\nEnrichment complete:');
  console.log(`  Enriched: ${result.enriched}`);
  console.log(`  Failed: ${result.failed}`);
  console.log(`  Total: ${result.total}`);
}).catch(err => {
  console.error('Enrichment failed:', err.message);
  process.exit(1);
});
