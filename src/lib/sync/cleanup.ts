import { getDb } from '../db';
import { initSchema } from '../schema';

export interface CleanupResult {
  source: string;
  itemsDeleted: number;
  versionsDeleted: number;
  tagsDeleted: number;
  linksDeleted: number;
  chunksDeleted: number;
  workstreamItemsDeleted: number;
  decisionItemsDeleted: number;
  entityMentionsDeleted: number;
}

export interface SourceDataStats {
  source: string;
  itemCount: number;
  oldestSyncedAt: string | null;
  newestSyncedAt: string | null;
  // Other workspaces that have this same source installed — they share the
  // synced data because work_items is global per source. Empty when only the
  // current workspace uses it.
  sharedWith: string[];
}

export function getSourceDataStats(source: string, currentWorkspaceId?: string): SourceDataStats {
  initSchema();
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) AS itemCount,
      MIN(synced_at) AS oldestSyncedAt,
      MAX(synced_at) AS newestSyncedAt
    FROM work_items
    WHERE source = ?
  `).get(source) as { itemCount: number; oldestSyncedAt: string | null; newestSyncedAt: string | null };

  let sharedWith: string[] = [];
  if (currentWorkspaceId) {
    const others = db.prepare(`
      SELECT DISTINCT workspace_id FROM workspace_connector_configs
      WHERE source = ? AND workspace_id != ? AND status != 'skipped'
    `).all(source, currentWorkspaceId) as { workspace_id: string }[];
    sharedWith = others.map((r) => r.workspace_id);
  }

  return {
    source,
    itemCount: row.itemCount ?? 0,
    oldestSyncedAt: row.oldestSyncedAt,
    newestSyncedAt: row.newestSyncedAt,
    sharedWith,
  };
}

/**
 * Hard-deletes all synced data for a single source. Child tables (versions,
 * tags, links, chunks, workstream/decision/entity joins) are cleared first to
 * respect foreign keys, then work_items rows are removed.
 *
 * NOTE: source data is global (not partitioned by workspace), so two
 * workspaces sharing the same source share data. Cleanup affects everything
 * tagged with that source.
 */
export function cleanupSourceData(source: string): CleanupResult {
  initSchema();
  const db = getDb();

  const result: CleanupResult = {
    source,
    itemsDeleted: 0,
    versionsDeleted: 0,
    tagsDeleted: 0,
    linksDeleted: 0,
    chunksDeleted: 0,
    workstreamItemsDeleted: 0,
    decisionItemsDeleted: 0,
    entityMentionsDeleted: 0,
  };

  const tableExists = (name: string): boolean => {
    const r = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name) as { name: string } | undefined;
    return Boolean(r);
  };

  const tx = db.transaction(() => {
    const ids = db.prepare('SELECT id FROM work_items WHERE source = ?')
      .all(source) as { id: string }[];
    if (ids.length === 0) return;

    const idList = ids.map((r) => r.id);
    const chunks: string[][] = [];
    for (let i = 0; i < idList.length; i += 500) chunks.push(idList.slice(i, i + 500));

    // Step 1: collect derived IDs (chunks and links) that join tables reference.
    const chunkIds: number[] = [];
    const linkIds: string[] = [];
    if (tableExists('item_chunks')) {
      for (const chunk of chunks) {
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db.prepare(`SELECT id FROM item_chunks WHERE item_id IN (${placeholders})`).all(...chunk) as { id: number }[];
        for (const r of rows) chunkIds.push(r.id);
      }
    }
    if (tableExists('links')) {
      for (const chunk of chunks) {
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db.prepare(
          `SELECT id FROM links WHERE source_item_id IN (${placeholders}) OR target_item_id IN (${placeholders})`,
        ).all(...chunk, ...chunk) as { id: string }[];
        for (const r of rows) linkIds.push(r.id);
      }
    }

    // Step 2: delete the join table that references chunks/links.
    if (tableExists('item_links_chunks') && (chunkIds.length || linkIds.length)) {
      const splitter = (arr: (string | number)[]) => {
        const out: (string | number)[][] = [];
        for (let i = 0; i < arr.length; i += 500) out.push(arr.slice(i, i + 500));
        return out;
      };
      for (const c of splitter(chunkIds)) {
        const ph = c.map(() => '?').join(',');
        db.prepare(`DELETE FROM item_links_chunks WHERE source_chunk_id IN (${ph}) OR target_chunk_id IN (${ph})`).run(...c, ...c);
      }
      for (const c of splitter(linkIds)) {
        const ph = c.map(() => '?').join(',');
        db.prepare(`DELETE FROM item_links_chunks WHERE link_id IN (${ph})`).run(...c);
      }
    }

    // Step 3: delete tables that reference work_items directly.
    const childDeletes: Array<{ table: string; counter: keyof CleanupResult }> = [
      { table: 'work_item_versions',  counter: 'versionsDeleted' },
      { table: 'item_tags',           counter: 'tagsDeleted' },
      { table: 'item_chunks',         counter: 'chunksDeleted' },
      { table: 'workstream_items',    counter: 'workstreamItemsDeleted' },
      { table: 'decision_items',      counter: 'decisionItemsDeleted' },
      { table: 'entity_mentions',     counter: 'entityMentionsDeleted' },
    ];
    for (const { table, counter } of childDeletes) {
      if (!tableExists(table)) continue;
      for (const chunk of chunks) {
        const placeholders = chunk.map(() => '?').join(',');
        const r = db.prepare(`DELETE FROM ${table} WHERE item_id IN (${placeholders})`).run(...chunk);
        (result[counter] as number) += r.changes;
      }
    }

    // Step 4: links (two FK columns).
    if (tableExists('links')) {
      for (const chunk of chunks) {
        const placeholders = chunk.map(() => '?').join(',');
        const r = db.prepare(
          `DELETE FROM links WHERE source_item_id IN (${placeholders}) OR target_item_id IN (${placeholders})`,
        ).run(...chunk, ...chunk);
        result.linksDeleted += r.changes;
      }
    }

    // Step 5: work_items themselves.
    const r = db.prepare('DELETE FROM work_items WHERE source = ?').run(source);
    result.itemsDeleted = r.changes;
  });

  tx();
  return result;
}
