import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { initSchema } from '../src/lib/schema';
import { createLinksForAll } from '../src/lib/crossref';
import { computeAllMetrics } from '../src/lib/metrics';
import { enrichAll } from '../src/lib/sync/enrich';
import { extractAllEntities } from '../src/lib/sync/extract-entities';
import { generateAllRecaps } from '../src/lib/sync/recap';
import { chunkAllPending } from '../src/lib/chunking';
import { embedAllPending } from '../src/lib/embeddings/embed';
import { assembleAll } from '../src/lib/workstream/assemble';
import { summarizeAllWorkstreams } from '../src/lib/workstream/summary';
import { extractDecisions } from '../src/lib/decision/extract';
import { summarizeAllDecisions } from '../src/lib/decision/summary';
import { getDb } from '../src/lib/db';
import { seedWorkspaceConfig } from '../src/lib/workspace-config';

const args = new Set(process.argv.slice(2));
const FULL = args.has('--full');
const SKIP_SUMMARIES = args.has('--no-summaries');
const SKIP_EMBED = args.has('--no-embed');
const SKIP_LINKS = args.has('--no-links');

async function run() {
  initSchema();
  await seedWorkspaceConfig();
  const t0 = Date.now();
  console.log(`Processing pipeline${FULL ? ' (FULL)' : ' (incremental)'}...`);

  // Phase 1: Text enrichment (Haiku → trace_role, substance, entities, topics, goals)
  console.log('\n  [1/6] Text enrichment (Haiku)...');
  if (FULL) {
    getDb().prepare('UPDATE work_items SET enriched_at = NULL').run();
  }
  const enr = await enrichAll({ concurrency: 5 });
  console.log(`    enriched=${enr.enriched}, failed=${enr.failed}`);

  // Phase 2: Chunking
  console.log('\n  [2/7] Chunking...');
  const ch = await chunkAllPending({ force: FULL });
  console.log(`    items=${ch.items}, chunks=${ch.chunks}`);

  // Phase 3: Entity extraction (Haiku + tool_use, typed + canonicalized + offsets)
  console.log('\n  [3/7] Entity extraction (Haiku tool_use)...');
  if (FULL) {
    getDb().exec('DELETE FROM entity_mentions');
    // keep entities table — canonical forms are reusable
  }
  const ent = await extractAllEntities({ force: FULL, concurrency: 4 });
  console.log(`    processed=${ent.processed}, mentions=${ent.mentions}, failed=${ent.failed}`);

  // Phase 4: Embeddings (local, Ollama)
  if (!SKIP_EMBED) {
    console.log('\n  [4/7] Embedding chunks (Ollama nomic-embed-text)...');
    const em = await embedAllPending({ concurrency: 4 });
    console.log(`    embedded=${em.embedded}, skipped=${em.skipped}, failed=${em.failed}`);
  } else {
    console.log('\n  [4/7] Embedding SKIPPED (--no-embed)');
  }

  // Phase 5: Multi-signal link detection
  if (!SKIP_LINKS) {
    console.log('\n  [5/7] Link detection (multi-signal)...');
    if (FULL) {
      getDb().exec('DELETE FROM item_links_chunks');
      getDb().exec('DELETE FROM links');
    }
    const lk = await createLinksForAll({});
    console.log(`    items=${lk.items}, links=${lk.links}`);
  } else {
    console.log('\n  [5/7] Links SKIPPED (--no-links)');
  }

  // Phase 6: Workstream assembly
  console.log('\n  [6/7] Workstream assembly...');
  const ws = await assembleAll();
  console.log(`    workstreams=${ws.workstreams}, items-in-ws=${ws.items}, seeds=${ws.seeds}, orphans=${ws.orphans}`);

  // Phase 6: Workstream narrative summaries (Sonnet, paragraph + timeline)
  if (!SKIP_SUMMARIES) {
    console.log('\n  [6/8] Workstream summaries (Sonnet)...');
    const sm = await summarizeAllWorkstreams({ force: FULL, minItems: 2, concurrency: 2 });
    console.log(`    generated=${sm.generated}, skipped=${sm.skipped}, failed=${sm.failed}`);
  } else {
    console.log('\n  [6/8] Summaries SKIPPED (--no-summaries)');
  }

  // Phase 7: Decision extraction (every trace_role='decision' → decision record with bidirectional trace)
  console.log('\n  [7/8] Decision extraction...');
  const dx = await extractDecisions();
  console.log(`    decisions=${dx.decisions}, relations=${dx.relations}`);

  // Phase 8: Structured decision summaries (Sonnet — Context / Decision / Rationale / Outcome / Traceability)
  if (!SKIP_SUMMARIES) {
    console.log('\n  [8/8] Decision structured summaries (Sonnet)...');
    const ds = await summarizeAllDecisions({ force: FULL, concurrency: 2 });
    console.log(`    generated=${ds.generated}, skipped=${ds.skipped}, failed=${ds.failed}`);
  } else {
    console.log('\n  [8/8] Decision summaries SKIPPED (--no-summaries)');
  }

  // Side-channel: metrics + project recaps (kept from prior pipeline)
  console.log('\n  Metrics + project recaps...');
  computeAllMetrics();
  const recap = await generateAllRecaps();
  console.log(`    recaps=${recap.generated}`);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nPipeline complete in ${elapsed}s.`);
}

run().catch(err => {
  console.error('Processing failed:', err.message);
  process.exit(1);
});
