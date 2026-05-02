/**
 * Full-pipeline validation:
 *   - chunk all items
 *   - embed pending chunks (local, fast)
 *   - run multi-signal crossref on a subset
 *   - dump the resulting links
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { getDb } from '../src/lib/db';
import { chunkAllPending } from '../src/lib/chunking';
import { embedAllPending } from '../src/lib/embeddings/embed';
import { createLinksForAll } from '../src/lib/crossref';

async function main() {
  const db = getDb();

  console.log('1) Chunking all pending items…');
  const chunkResult = await chunkAllPending({});
  console.log(`   items=${chunkResult.items}, chunks=${chunkResult.chunks}`);

  console.log('2) Embedding pending chunks (local ollama)…');
  const embedResult = await embedAllPending({ concurrency: 4 });
  console.log(`   embedded=${embedResult.embedded}, skipped=${embedResult.skipped}, failed=${embedResult.failed}`);

  console.log('3) Clearing existing links (v1 recompute)…');
  db.exec('DELETE FROM item_links_chunks');
  db.exec('DELETE FROM links');

  console.log('4) Running multi-signal crossref on 50 most recent items…');
  const start = Date.now();
  const cr = await createLinksForAll({ limit: 50 });
  console.log(`   items=${cr.items}, links=${cr.links}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s`);

  console.log('\n5) Link distribution:');
  const linkTypes = db.prepare(`
    SELECT link_type, COUNT(*) AS c, ROUND(AVG(confidence), 2) AS avg_conf
    FROM links GROUP BY link_type ORDER BY c DESC
  `).all();
  console.table(linkTypes);

  console.log('\n6) Sample high-confidence cross-source links:');
  const samples = db.prepare(`
    SELECT
      wa.source AS src_a, substr(wa.title, 1, 50) AS title_a,
      wb.source AS src_b, substr(wb.title, 1, 50) AS title_b,
      l.link_type, ROUND(l.confidence, 2) AS conf
    FROM links l
    JOIN work_items wa ON wa.id = l.source_item_id
    JOIN work_items wb ON wb.id = l.target_item_id
    WHERE wa.source != wb.source AND l.confidence >= 0.7
    ORDER BY l.confidence DESC
    LIMIT 10
  `).all();
  for (const r of samples as any[]) {
    console.log(`   [${r.conf}] ${r.src_a.padEnd(7)} ${r.title_a.padEnd(52)} ⇄ ${r.src_b.padEnd(7)} ${r.title_b.padEnd(52)} (${r.link_type})`);
  }

  console.log('\n7) Chunk evidence sample (which chunks contributed):');
  const evidence = db.prepare(`
    SELECT l.id AS link_id, l.link_type, ilc.signal, ROUND(ilc.score, 2) AS score,
           substr(ic_s.chunk_text, 1, 60) AS src_chunk,
           substr(ic_t.chunk_text, 1, 60) AS tgt_chunk
    FROM item_links_chunks ilc
    JOIN links l ON l.id = ilc.link_id
    LEFT JOIN item_chunks ic_s ON ic_s.id = ilc.source_chunk_id
    LEFT JOIN item_chunks ic_t ON ic_t.id = ilc.target_chunk_id
    WHERE ilc.signal = 'embedding'
    ORDER BY ilc.score DESC
    LIMIT 5
  `).all();
  for (const r of evidence as any[]) {
    console.log(`   [${r.score}] ${r.signal} link=${r.link_type}`);
    console.log(`     src: "${r.src_chunk || '(no chunk)'}…"`);
    console.log(`     tgt: "${r.tgt_chunk || '(no chunk)'}…"`);
  }
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
