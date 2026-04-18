import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { getDb } from '../src/lib/db';
import { createLinksForAll } from '../src/lib/crossref';
import { assembleAll } from '../src/lib/workstream/assemble';
import { summarizeAllWorkstreams } from '../src/lib/workstream/summary';
import { extractDecisions } from '../src/lib/decision/extract';
import { summarizeAllDecisions } from '../src/lib/decision/summary';

async function main() {
  const db = getDb();
  const t0 = Date.now();

  console.log('1) Wipe links + workstream summaries + decision summaries (fresh trace)');
  db.exec('DELETE FROM item_links_chunks');
  db.exec('DELETE FROM links');
  db.prepare(`UPDATE workstreams SET narrative = NULL, timeline_events = NULL, generated_at = NULL`).run();
  db.prepare(`UPDATE decisions SET summary = NULL, generated_at = NULL`).run();

  console.log('\n2) Multi-signal crossref (new weights)…');
  const t1 = Date.now();
  const lk = createLinksForAll({});
  console.log(`   items=${lk.items}, links=${lk.links}, ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  console.log('\n3) Link type distribution:');
  console.table(db.prepare(`
    SELECT link_type, COUNT(*) AS c, ROUND(AVG(confidence), 2) AS avg_conf
    FROM links GROUP BY link_type ORDER BY c DESC
  `).all());

  console.log('\n4) Workstream assembly (epic promotion)…');
  const ws = assembleAll();
  console.log(`   workstreams=${ws.workstreams}, items=${ws.items}, seeds=${ws.seeds}, orphans=${ws.orphans}`);

  console.log('\n5) Workstream size distribution:');
  const sizes: Record<string, number> = { '1': 0, '2-5': 0, '6-15': 0, '16-50': 0, '51+': 0 };
  const all = db.prepare(`
    SELECT COUNT(wsi.item_id) AS n FROM workstreams ws
    LEFT JOIN workstream_items wsi ON wsi.workstream_id = ws.id GROUP BY ws.id
  `).all() as { n: number }[];
  for (const r of all) {
    if (r.n <= 1) sizes['1']++;
    else if (r.n <= 5) sizes['2-5']++;
    else if (r.n <= 15) sizes['6-15']++;
    else if (r.n <= 50) sizes['16-50']++;
    else sizes['51+']++;
  }
  console.table(sizes);

  console.log('\n6) Decision extraction (epic-aware)…');
  const dx = extractDecisions();
  console.log(`   decisions=${dx.decisions}, relations=${dx.relations}`);

  console.log('\n7) Workstream narrative summaries (Sonnet)…');
  const wsSum = await summarizeAllWorkstreams({ minItems: 2, concurrency: 2 });
  console.log(`   generated=${wsSum.generated}, failed=${wsSum.failed}`);

  console.log('\n8) Decision structured summaries (Sonnet, ask vs. shipped)…');
  const dSum = await summarizeAllDecisions({ concurrency: 2 });
  console.log(`   generated=${dSum.generated}, failed=${dSum.failed}`);

  console.log(`\nTotal ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

  // Show one decision to verify new format
  const sample = db.prepare(`SELECT id, title, summary FROM decisions WHERE summary IS NOT NULL ORDER BY decided_at DESC LIMIT 1`).get() as any;
  if (sample) {
    console.log(`\n--- SAMPLE: "${sample.title}" ---`);
    const s = JSON.parse(sample.summary);
    console.log(`\nASKED:    ${s.what_was_asked}`);
    console.log(`\nSHIPPED:  ${s.what_was_shipped}`);
    console.log(`\nGAP:      ${s.gap_analysis}`);
    console.log(`\nDiscussion trace: ${s.discussion_trace.length}, Implementation trace: ${s.implementation_trace.length}`);
  }
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
