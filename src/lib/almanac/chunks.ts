/**
 * Almanac · RAG chunking (Phase 7 — KAN-49)
 *
 * Slices almanac_sections.markdown into overlapping windows and writes them
 * to item_chunks with chunk_type='almanac_section'. Existing chunks for the
 * same section are replaced atomically on each call.
 *
 * Embedding is intentionally NOT done here for the hot path (section-runner
 * calls rechunkAlmanacSection; the half-hourly embedAllPending cron picks up
 * the fresh chunks). embedAlmanacSection is available for scripts / smoke tests
 * that want immediate results.
 */

import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { embedChunkIds } from '@/lib/embeddings/embed';

// ─── Target window sizes (char-based; ~4 chars/token heuristic) ──────────────
const TARGET_CHARS = 2000;
const OVERLAP_CHARS = 200;
const SINGLE_CHUNK_MAX = 2500;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip :::diagram::: fenced blocks so prose-only text is indexed. */
function stripDiagramBlocks(md: string): string {
  return md.replace(/:::diagram:::[\s\S]*?:::/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Split text into overlapping windows. Returns [] if text is empty. */
function windowChunks(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= SINGLE_CHUNK_MAX) return [trimmed];

  const pieces: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(start + TARGET_CHARS, trimmed.length);
    pieces.push(trimmed.slice(start, end).trim());
    if (end >= trimmed.length) break;
    start = end - OVERLAP_CHARS;
  }
  return pieces.filter(Boolean);
}

// ─── Public API ──────────────────────────────────────────────────────────────

interface AlmanacSectionRow {
  id: string;
  workspace_id: string;
  project_key: string;
  unit_id: string | null;
  kind: string;
  anchor: string;
  title: string;
  markdown: string;
}

export async function rechunkAlmanacSection(
  sectionId: string,
): Promise<{ chunkIds: number[] }> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const row = await db
    .prepare(
      `SELECT id, workspace_id, project_key, unit_id, kind, anchor, title, markdown
       FROM almanac_sections WHERE id = ?`,
    )
    .get<AlmanacSectionRow>(sectionId);

  if (!row) throw new Error(`almanac_sections row not found: ${sectionId}`);

  // 0. Ensure a synthetic work_items row exists for this section so the FK on
  //    item_chunks.item_id (REFERENCES work_items(id)) is satisfied.
  //    source='almanac' is used to distinguish these from real work items.
  await db
    .prepare(
      `INSERT OR IGNORE INTO work_items
         (id, source, source_id, item_type, title, status, created_at, updated_at, synced_at)
       VALUES (?, 'almanac', ?, 'almanac_section', ?, 'active', datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run(sectionId, sectionId, row.title);

  // 1. Collect old chunk ids so we can delete meta rows (no cascade there).
  const oldChunks = await db
    .prepare(
      `SELECT id FROM item_chunks WHERE item_id = ? AND chunk_type = 'almanac_section'`,
    )
    .all<{ id: number }>(sectionId);
  const oldIds = oldChunks.map((c) => c.id);

  if (oldIds.length > 0) {
    const placeholders = oldIds.map(() => '?').join(',');
    await db
      .prepare(`DELETE FROM chunk_embeddings_meta WHERE chunk_id IN (${placeholders})`)
      .run(...oldIds);
  }

  // chunk_vectors has ON DELETE CASCADE from item_chunks, so this covers vectors.
  await db
    .prepare(`DELETE FROM item_chunks WHERE item_id = ? AND chunk_type = 'almanac_section'`)
    .run(sectionId);

  // 2. Chunk the prose.
  const prose = stripDiagramBlocks(row.markdown);
  const pieces = windowChunks(prose);

  if (pieces.length === 0) return { chunkIds: [] };

  // 3. Insert new chunks.
  const insertSql = `
    INSERT INTO item_chunks (item_id, chunk_type, chunk_text, position, metadata, created_at)
    VALUES (?, 'almanac_section', ?, ?, ?, datetime('now'))
  `;
  const newIds: number[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const meta = JSON.stringify({
      section_id: row.id,
      anchor: row.anchor,
      project_key: row.project_key,
      workspace_id: row.workspace_id,
      unit_id: row.unit_id,
      kind: row.kind,
      title: row.title,
    });
    const result = await db.prepare(insertSql).run(sectionId, pieces[i], i, meta);
    if (result.lastInsertRowid !== undefined && result.lastInsertRowid !== null) {
      newIds.push(Number(result.lastInsertRowid));
    }
  }

  return { chunkIds: newIds };
}

export async function embedAlmanacSection(sectionId: string): Promise<void> {
  const { chunkIds } = await rechunkAlmanacSection(sectionId);
  if (chunkIds.length === 0) return;
  await embedChunkIds(chunkIds);
}
