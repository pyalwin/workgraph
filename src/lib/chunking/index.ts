import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import type { ChunkInput, WorkItemForChunking } from './util';
import { approxTokens, passesMinimum } from './util';
import { chunkNotion } from './notion';
import { chunkJira } from './jira';
import { chunkSlack } from './slack';
import { chunkGithub } from './github';
import { chunkMeeting } from './meeting';

export type { ChunkInput, ChunkType, WorkItemForChunking } from './util';
export { passesMinimum, approxTokens } from './util';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

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
export async function persistChunks(itemId: string, chunks: ChunkInput[]): Promise<number[]> {
  await ensureInit();
  const db = getLibsqlDb();
  const ids: number[] = [];

  // Sequential async — original was wrapped in db.transaction(). The cleanup
  // is idempotent on retry (DELETE WHERE item_id = ? + INSERTs); losing
  // atomicity here means a retry might leave duplicate chunks if the run
  // dies mid-INSERT, but the chunk-embed cron's "rechunk on replay" path
  // would just re-replace them.
  const stale = await db
    .prepare('SELECT id FROM item_chunks WHERE item_id = ?')
    .all<{ id: number }>(itemId);
  if (stale.length > 0) {
    const placeholders = stale.map(() => '?').join(',');
    const staleIds = stale.map(s => s.id);
    await db.prepare(`DELETE FROM chunk_vectors WHERE chunk_id IN (${placeholders})`).run(...staleIds);
    await db.prepare(`DELETE FROM chunk_embeddings_meta WHERE chunk_id IN (${placeholders})`).run(...staleIds);
    await db.prepare('DELETE FROM item_chunks WHERE item_id = ?').run(itemId);
  }

  const insertSql = `INSERT INTO item_chunks (item_id, chunk_type, chunk_text, position, token_count, metadata) VALUES (?, ?, ?, ?, ?, ?)`;
  for (const c of chunks) {
    const res = await db.prepare(insertSql).run(
      itemId,
      c.chunk_type,
      c.chunk_text,
      c.position,
      c.token_count ?? null,
      c.metadata ? JSON.stringify(c.metadata) : null,
    );
    ids.push(Number(res.lastInsertRowid));
  }

  return ids;
}

/**
 * Chunk every work_item that doesn't already have chunks (or force-rechunk if requested).
 * Returns aggregate counts.
 */
export async function chunkAllPending(opts: { force?: boolean; limit?: number } = {}): Promise<{ items: number; chunks: number }> {
  await ensureInit();
  const db = getLibsqlDb();
  const limit = opts.limit ?? 100000;
  const force = opts.force ?? false;

  const rows = await db
    .prepare(
      `SELECT wi.id, wi.source, wi.source_id, wi.item_type, wi.title, wi.body, wi.author, wi.url, wi.metadata, wi.created_at
       FROM work_items wi
       ${force ? '' : 'LEFT JOIN item_chunks ic ON ic.item_id = wi.id WHERE ic.id IS NULL'}
       ORDER BY wi.created_at DESC
       LIMIT ?`,
    )
    .all<WorkItemForChunking>(limit);

  let chunks = 0;
  for (const item of rows) {
    const c = chunkItem(item);
    if (c.length === 0) continue;
    await persistChunks(item.id, c);
    chunks += c.length;
  }
  return { items: rows.length, chunks };
}
