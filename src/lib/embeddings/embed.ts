import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { embed, TEXT_MODEL, TEXT_DIM, type EmbeddingModel } from './huggingface';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

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
  almanac_section: TEXT_MODEL,
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
  errors: string[];
}

/** Pack a Float32Array into a Uint8Array suitable for INSERT into chunk_vectors.embedding. */
function packVector(vec: number[]): Uint8Array {
  const f32 = new Float32Array(vec);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

export async function embedChunkIds(
  chunkIds: number[],
  opts: { concurrency?: number; force?: boolean } = {},
): Promise<EmbedResult> {
  await ensureInit();
  const db = getLibsqlDb();
  const force = opts.force ?? false;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const result: EmbedResult = { embedded: 0, skipped: 0, failed: 0, errors: [] };
  if (chunkIds.length === 0) return result;

  const getChunkSql = 'SELECT id, item_id, chunk_type, chunk_text FROM item_chunks WHERE id = ?';
  const checkExistingSql = 'SELECT 1 AS hit FROM chunk_embeddings_meta WHERE chunk_id = ? AND model = ?';
  const upsertVecSql = `INSERT INTO chunk_vectors (chunk_id, embedding, dim) VALUES (?, ?, ?)
    ON CONFLICT(chunk_id) DO UPDATE SET embedding = excluded.embedding, dim = excluded.dim, created_at = datetime('now')`;
  const upsertMetaSql = `INSERT INTO chunk_embeddings_meta (chunk_id, model, dim, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(chunk_id, model) DO UPDATE SET dim = excluded.dim, created_at = excluded.created_at`;

  const pending: ChunkRow[] = [];
  for (const id of chunkIds) {
    const row = await db.prepare(getChunkSql).get<ChunkRow>(id);
    if (!row) continue;
    const model = MODEL_BY_CHUNK_TYPE[row.chunk_type] ?? TEXT_MODEL;
    if (!force) {
      const hit = await db.prepare(checkExistingSql).get(row.id, model);
      if (hit) {
        result.skipped++;
        continue;
      }
    }
    pending.push(row);
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

    for (const s of settled) {
      if (s.status !== 'fulfilled') {
        const message = `embed: ${s.reason?.message ?? s.reason}`;
        console.error(`  embed FAIL: ${message}`);
        if (result.errors.length < 10) result.errors.push(message);
        result.failed++;
        continue;
      }
      const { chunk, model, vec } = s.value;
      try {
        const blob = packVector(vec);
        await db.prepare(upsertVecSql).run(chunk.id, blob, vec.length);
        await db.prepare(upsertMetaSql).run(chunk.id, model, vec.length);
        result.embedded++;
      } catch (err: any) {
        const message = `embed-store chunk ${chunk.id}: ${err.message}`;
        console.error(`  embed-store FAIL ${message}`);
        if (result.errors.length < 10) result.errors.push(message);
        result.failed++;
      }
    }
  }

  return result;
}

export async function embedAllPending(
  opts: { limit?: number; concurrency?: number } = {},
): Promise<EmbedResult> {
  await ensureInit();
  const db = getLibsqlDb();
  const limit = opts.limit ?? 5000;
  const rows = await db
    .prepare(
      `SELECT ic.id FROM item_chunks ic
       LEFT JOIN chunk_embeddings_meta m ON m.chunk_id = ic.id
       WHERE m.chunk_id IS NULL
       ORDER BY ic.id ASC
       LIMIT ?`,
    )
    .all<{ id: number }>(limit);
  return embedChunkIds(rows.map(r => r.id), { concurrency: opts.concurrency });
}

export interface ChunkSearchHit {
  chunk_id: number;
  item_id: string;
  chunk_type: string;
  chunk_text: string;
  distance: number;
}

/** Float32Array → unpacked plain array for cosine math when libSQL vector
 *  functions aren't available (file-mode dev without the extension). */
function unpackVector(buf: Uint8Array | ArrayBuffer): Float32Array {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
}

function cosineDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 1;
  // libSQL's vector_distance_cos returns 1 - cosine_similarity; mirror that.
  return 1 - dot / denom;
}

export async function searchChunks(
  query: string,
  k: number = 10,
  opts: { source?: string } = {},
): Promise<ChunkSearchHit[]> {
  await ensureInit();
  const db = getLibsqlDb();
  const qvec = await embed(query, TEXT_MODEL);
  const sourceFilter = opts.source?.trim() || null;

  // Try libSQL native vector_distance_cos first — works on Turso and on
  // newer libsql file mode. Falls back to in-process cosine when the
  // function is unavailable (e.g. older libsql build in dev).
  const queryLiteral = JSON.stringify(qvec);
  try {
    const where = sourceFilter ? 'WHERE wi.source = ?' : '';
    const args = sourceFilter ? [queryLiteral, sourceFilter, k] : [queryLiteral, k];
    const rows = await db
      .prepare(
        `SELECT cv.chunk_id, ic.item_id, ic.chunk_type, ic.chunk_text,
                vector_distance_cos(cv.embedding, vector(?)) AS distance
         FROM chunk_vectors cv
         JOIN item_chunks ic ON ic.id = cv.chunk_id
         JOIN work_items wi ON wi.id = ic.item_id
         ${where}
         ORDER BY distance ASC
         LIMIT ?`,
      )
      .all<{
        chunk_id: number | bigint;
        distance: number;
        item_id: string;
        chunk_type: string;
        chunk_text: string;
      }>(...args);
    return rows.map(r => ({
      chunk_id: Number(r.chunk_id),
      item_id: r.item_id,
      chunk_type: r.chunk_type,
      chunk_text: r.chunk_text,
      distance: r.distance,
    }));
  } catch {
    // Fallback: load all vectors and cosine-rank in process. Bounded by
    // chunk_vectors row count; fine for dev installs (<10k items).
    const rows = await db
      .prepare(
        `SELECT cv.chunk_id, cv.embedding, ic.item_id, ic.chunk_type, ic.chunk_text
         FROM chunk_vectors cv
         JOIN item_chunks ic ON ic.id = cv.chunk_id
         JOIN work_items wi ON wi.id = ic.item_id
         ${sourceFilter ? 'WHERE wi.source = ?' : ''}`,
      )
      .all<{
        chunk_id: number | bigint;
        embedding: Uint8Array | ArrayBuffer;
        item_id: string;
        chunk_type: string;
        chunk_text: string;
      }>(...(sourceFilter ? [sourceFilter] : []));
    const q = new Float32Array(qvec);
    const scored = rows.map((r) => ({
      chunk_id: Number(r.chunk_id),
      item_id: r.item_id,
      chunk_type: r.chunk_type,
      chunk_text: r.chunk_text,
      distance: cosineDistance(q, unpackVector(r.embedding)),
    }));
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, k);
  }
}

/**
 * Semantic similarity between two chunks via stored vectors. Returns a
 * cosine score in [0, 1] where 1 is identical (1 - cosine_distance).
 */
export async function similarity(chunkIdA: number, chunkIdB: number): Promise<number | null> {
  await ensureInit();
  const db = getLibsqlDb();
  const a = await db
    .prepare(`SELECT embedding FROM chunk_vectors WHERE chunk_id = ?`)
    .get<{ embedding: Uint8Array | ArrayBuffer }>(chunkIdA);
  const b = await db
    .prepare(`SELECT embedding FROM chunk_vectors WHERE chunk_id = ?`)
    .get<{ embedding: Uint8Array | ArrayBuffer }>(chunkIdB);
  if (!a?.embedding || !b?.embedding) return null;
  const va = unpackVector(a.embedding);
  const vb = unpackVector(b.embedding);
  return 1 - cosineDistance(va, vb);
}
