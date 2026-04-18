import { getDb } from '../db';
import type { ChunkInput, WorkItemForChunking } from './util';
import { approxTokens, passesMinimum } from './util';
import { chunkNotion } from './notion';
import { chunkJira } from './jira';
import { chunkSlack } from './slack';
import { chunkGithub } from './github';
import { chunkMeeting } from './meeting';

export type { ChunkInput, ChunkType, WorkItemForChunking } from './util';
export { passesMinimum, approxTokens } from './util';

export function chunkItem(item: WorkItemForChunking): ChunkInput[] {
  switch (item.source) {
    case 'notion':  return chunkNotion(item);
    case 'jira':    return chunkJira(item);
    case 'slack':   return chunkSlack(item);
    case 'github':  return chunkGithub(item);
    case 'meeting': return chunkMeeting(item);
    default:        return chunkGeneric(item);
  }
}

function chunkGeneric(item: WorkItemForChunking): ChunkInput[] {
  const text = [item.title, item.body].filter(Boolean).join('\n\n');
  if (!passesMinimum(text)) return [];
  return [{
    chunk_type: 'generic',
    chunk_text: text,
    position: 0,
    token_count: approxTokens(text),
  }];
}

/**
 * Delete existing chunks for an item and insert fresh ones.
 * Embeddings for old chunks become orphaned and are cleaned up in a separate pass.
 * Returns the inserted chunk IDs.
 */
export function persistChunks(itemId: string, chunks: ChunkInput[]): number[] {
  const db = getDb();
  const ids: number[] = [];

  const insert = db.prepare(
    'INSERT INTO item_chunks (item_id, chunk_type, chunk_text, position, token_count, metadata) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const tx = db.transaction(() => {
    // Clean up stale chunks and their embeddings
    const stale = db.prepare('SELECT id FROM item_chunks WHERE item_id = ?').all(itemId) as { id: number }[];
    if (stale.length > 0) {
      const placeholders = stale.map(() => '?').join(',');
      const staleBigInts = stale.map(s => BigInt(s.id));
      db.prepare(`DELETE FROM vec_chunks_text WHERE chunk_id IN (${placeholders})`).run(...staleBigInts);
      db.prepare(`DELETE FROM chunk_embeddings_meta WHERE chunk_id IN (${placeholders})`).run(...staleBigInts);
      db.prepare('DELETE FROM item_chunks WHERE item_id = ?').run(itemId);
    }

    for (const c of chunks) {
      const res = insert.run(
        itemId,
        c.chunk_type,
        c.chunk_text,
        c.position,
        c.token_count ?? null,
        c.metadata ? JSON.stringify(c.metadata) : null,
      );
      ids.push(Number(res.lastInsertRowid));
    }
  });
  tx();

  return ids;
}

/**
 * Chunk every work_item that doesn't already have chunks (or force-rechunk if requested).
 * Returns aggregate counts.
 */
export function chunkAllPending(opts: { force?: boolean; limit?: number } = {}): { items: number; chunks: number } {
  const db = getDb();
  const limit = opts.limit ?? 100000;
  const force = opts.force ?? false;

  const rows = db.prepare(`
    SELECT wi.id, wi.source, wi.source_id, wi.item_type, wi.title, wi.body, wi.author, wi.url, wi.metadata, wi.created_at
    FROM work_items wi
    ${force ? '' : 'LEFT JOIN item_chunks ic ON ic.item_id = wi.id WHERE ic.id IS NULL'}
    ORDER BY wi.created_at DESC
    LIMIT ?
  `).all(limit) as WorkItemForChunking[];

  let chunks = 0;
  for (const item of rows) {
    const c = chunkItem(item);
    if (c.length === 0) continue;
    persistChunks(item.id, c);
    chunks += c.length;
  }
  return { items: rows.length, chunks };
}
