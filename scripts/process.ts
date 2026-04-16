import { initSchema, seedGoals } from '../src/lib/schema';
import { reclassifyAll } from '../src/lib/classify';
import { createLinksForAll } from '../src/lib/crossref';
import { computeAllMetrics } from '../src/lib/metrics';

initSchema();
seedGoals();

console.log('Phase 3: Processing...');

console.log('  Classifying items to goals...');
reclassifyAll();

console.log('  Creating cross-reference links...');
createLinksForAll();

console.log('  Computing metrics snapshots...');
computeAllMetrics();

console.log('Processing complete.');
