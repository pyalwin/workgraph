import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { initSchema, seedGoals } from '../src/lib/schema';
import { createLinksForAll } from '../src/lib/crossref';
import { computeAllMetrics } from '../src/lib/metrics';
import { enrichAll } from '../src/lib/sync/enrich';
import { generateAllRecaps } from '../src/lib/sync/recap';

initSchema();
seedGoals();

async function run() {
  console.log('Processing pipeline...');

  console.log('\n  Phase 2: Enriching with Haiku...');
  const enrichResult = await enrichAll({ concurrency: 5 });
  console.log(`  Enriched: ${enrichResult.enriched}, Failed: ${enrichResult.failed}`);

  console.log('\n  Phase 3: Cross-referencing...');
  createLinksForAll();

  console.log('  Computing metrics...');
  computeAllMetrics();

  console.log('\n  Phase 4: Generating project recaps...');
  const recapResult = await generateAllRecaps();
  console.log(`  Generated: ${recapResult.generated} recaps`);

  console.log('\nProcessing complete.');
}

run().catch(err => {
  console.error('Processing failed:', err.message);
  process.exit(1);
});
