import { getDb } from '../db';
import { embed, TEXT_MODEL, type EmbeddingModel } from './ollama';

export const MODEL_BY_CHUNK_TYPE: Record<string, EmbeddingModel> = {
  notion_section: TEXT_MODEL,
  notion_summary: TEXT_MODEL,
  jira_body: TEXT_MODEL,
  jira_comment: TEXT_MODEL,
  slack_message: TEXT_MODEL,
  slack_thread_agg: TEXT_MODEL,
  pr_desc: TEXT_MODEL,
  pr_diff_summary: TEXT_MODEL,
  commit: TEXT_MODEL,
  meeting_note: TEXT_MODEL,
  // pr_patch → CODE_MODEL once a suitable Ollama code embedder is pulled
};

interface ChunkRow {
  id: number;
  item_id: string;
  chunk_type: string;
  chunk_text: string;
}

export interface EmbedResult {
  embedded: number;
  skipped: number;
  failed: number;
}

export async function embedChunkIds(
  chunkIds: number[],
  opts: { concurrency?: number; force?: boolean } = {},
): Promise<EmbedResult> {
  const db = getDb();
  const force = opts.force ?? false;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const result: EmbedResult = { embedded: 0, skipped: 0, failed: 0 };
  if (chunkIds.length === 0) return result;

  const getChunk = db.prepare(
    'SELECT id, item_id, chunk_type, chunk_text FROM item_chunks WHERE id = ?',
  );
  const checkExisting = db.prepare(
    'SELECT 1 FROM chunk_embeddings_meta WHERE chunk_id = ? AND model = ?',
  );
  const deleteVec = db.prepare('DELETE FROM vec_chunks_text WHERE chunk_id = ?');
  const insertVec = db.prepare(
    'INSERT INTO vec_chunks_text(chunk_id, embedding) VALUES (?, ?)',
  );
  const upsertMeta = db.prepare(`
    INSERT INTO chunk_embeddings_meta (chunk_id, model, dim, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(chunk_id, model) DO UPDATE
      SET dim = excluded.dim, created_at = excluded.created_at
  `);

  const pending: ChunkRow[] = [];
  for (const id of chunkIds) {
    const row = getChunk.get(id) as ChunkRow | undefined;
    if (!row) continue;
    const model = MODEL_BY_CHUNK_TYPE[row.chunk_type] ?? TEXT_MODEL;
    if (!force && checkExisting.get(row.id, model)) {
      result.skipped++;
    } else {
      pending.push(row);
    }
  }

  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async c => {
        const model = MODEL_BY_CHUNK_TYPE[c.chunk_type] ?? TEXT_MODEL;
        const vec = await embed(c.chunk_text, model);
        return { chunk: c, model, vec };
      }),
    );

    const persist = db.transaction(() => {
      for (const s of settled) {
        if (s.status !== 'fulfilled') {
          console.error(`  embed FAIL: ${s.reason?.message ?? s.reason}`);
          result.failed++;
          continue;
        }
        const { chunk, model, vec } = s.value;
        try {
          const idBig = BigInt(chunk.id);
          deleteVec.run(idBig);
          insertVec.run(idBig, JSON.stringify(vec));
          upsertMeta.run(idBig, model, vec.length);
          result.embedded++;
        } catch (err: any) {
          console.error(`  embed-store FAIL chunk ${chunk.id}: ${err.message}`);
          result.failed++;
        }
      }
    });
    persist();
  }

  return result;
}

export async function embedAllPending(
  opts: { limit?: number; concurrency?: number } = {},
): Promise<EmbedResult> {
  const db = getDb();
  const limit = opts.limit ?? 5000;
  const rows = db.prepare(`
    SELECT ic.id FROM item_chunks ic
    LEFT JOIN chunk_embeddings_meta m ON m.chunk_id = ic.id
    WHERE m.chunk_id IS NULL
    ORDER BY ic.id ASC
    LIMIT ?
  `).all(limit) as { id: number }[];
  return embedChunkIds(rows.map(r => r.id), { concurrency: opts.concurrency });
}

export interface ChunkSearchHit {
  chunk_id: number;
  item_id: string;
  chunk_type: string;
  chunk_text: string;
  distance: number;
}

export async function searchChunks(query: string, k: number = 10): Promise<ChunkSearchHit[]> {
  const db = getDb();
  const qvec = await embed(query, TEXT_MODEL);
  const rows = db.prepare(`
    SELECT v.chunk_id, v.distance, ic.item_id, ic.chunk_type, ic.chunk_text
    FROM vec_chunks_text v
    JOIN item_chunks ic ON ic.id = v.chunk_id
    WHERE v.embedding MATCH ? AND v.k = ?
    ORDER BY v.distance ASC
  `).all(JSON.stringify(qvec), k) as Array<{
    chunk_id: number | bigint;
    distance: number;
    item_id: string;
    chunk_type: string;
    chunk_text: string;
  }>;
  return rows.map(r => ({
    chunk_id: Number(r.chunk_id),
    item_id: r.item_id,
    chunk_type: r.chunk_type,
    chunk_text: r.chunk_text,
    distance: r.distance,
  }));
}

/**
 * Semantic similarity between two chunks via vec0 distance — returns cosine-like
 * score in [0, 1] where 1 is identical. sqlite-vec returns L2 distance by default;
 * we normalize via 1/(1+d) for a bounded score.
 */
export async function similarity(chunkIdA: number, chunkIdB: number): Promise<number | null> {
  const db = getDb();
  // Fetch both vectors
  const row = db.prepare(`
    SELECT
      (SELECT embedding FROM vec_chunks_text WHERE chunk_id = ?) AS a,
      (SELECT embedding FROM vec_chunks_text WHERE chunk_id = ?) AS b
  `).get(BigInt(chunkIdA), BigInt(chunkIdB)) as { a?: Buffer; b?: Buffer } | undefined;
  if (!row?.a || !row?.b) return null;
  // Decode and compute cosine
  const a = new Float32Array(row.a.buffer, row.a.byteOffset, row.a.byteLength / 4);
  const b = new Float32Array(row.b.buffer, row.b.byteOffset, row.b.byteLength / 4);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
