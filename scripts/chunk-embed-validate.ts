/**
 * Validation: chunk + embed a sample of real work_items, run a semantic search.
 * Writes to chunks/embeddings tables. Run with: bunx tsx scripts/chunk-embed-validate.ts
 */
import { getDb } from '../src/lib/db';
import { chunkItem, persistChunks } from '../src/lib/chunking';
import { embedChunkIds, searchChunks } from '../src/lib/embeddings/embed';

async function main() {
  const db = getDb();

  // Pick up to 10 items per source for variety
  const rows = db.prepare(`
    SELECT id, source, source_id, item_type, title, body, author, url, metadata, created_at
    FROM work_items
    WHERE id IN (
      SELECT id FROM work_items WHERE source = 'notion' ORDER BY created_at DESC LIMIT 10
    ) OR id IN (
      SELECT id FROM work_items WHERE source = 'jira'   ORDER BY created_at DESC LIMIT 10
    ) OR id IN (
      SELECT id FROM work_items WHERE source = 'slack'  ORDER BY created_at DESC LIMIT 10
    ) OR id IN (
      SELECT id FROM work_items WHERE source = 'github' ORDER BY created_at DESC LIMIT 10
    )
    ORDER BY source, created_at DESC
  `).all() as any[];

  console.log(`Sample size: ${rows.length} items`);

  const allChunkIds: number[] = [];
  const bySource: Record<string, number> = {};
  const byChunkType: Record<string, number> = {};

  for (const item of rows) {
    const chunks = chunkItem(item);
    if (chunks.length === 0) {
      console.log(`  SKIP ${item.source}:${item.item_type} "${(item.title || '').slice(0, 50)}" — below min`);
      continue;
    }
    const ids = await persistChunks(item.id, chunks);
    allChunkIds.push(...ids);
    bySource[item.source] = (bySource[item.source] ?? 0) + chunks.length;
    for (const c of chunks) byChunkType[c.chunk_type] = (byChunkType[c.chunk_type] ?? 0) + 1;
  }

  console.log(`\nChunk counts by source:`, bySource);
  console.log(`Chunk counts by type:  `, byChunkType);
  console.log(`Total chunks: ${allChunkIds.length}\n`);

  console.log(`Embedding ${allChunkIds.length} chunks...`);
  const result = await embedChunkIds(allChunkIds, { concurrency: 4 });
  console.log(`Embed result:`, result);

  const queries = [
    'onboarding login flow passkey',
    'invoice approval workflow',
    'API gateway terraform deployment',
    'customer bug report escalation',
  ];

  for (const q of queries) {
    console.log(`\n🔍 "${q}"`);
    const hits = await searchChunks(q, 5);
    for (const h of hits) {
      const item = db.prepare('SELECT source, title FROM work_items WHERE id = ?').get(h.item_id) as any;
      console.log(`  [${h.distance.toFixed(2)}] ${item?.source ?? '?'}:${h.chunk_type.padEnd(16)} ${(item?.title ?? '').slice(0, 70)}`);
    }
  }
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
