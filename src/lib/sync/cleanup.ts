import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';

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
  sharedWith: string[];
}

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

export async function getSourceDataStats(
  source: string,
  currentWorkspaceId?: string,
): Promise<SourceDataStats> {
  await ensureInit();
  const db = getLibsqlDb();
  const row = await db
    .prepare(
      `SELECT
        COUNT(*) AS itemCount,
        MIN(synced_at) AS oldestSyncedAt,
        MAX(synced_at) AS newestSyncedAt
      FROM work_items
      WHERE source = ?`,
    )
    .get<{ itemCount: number; oldestSyncedAt: string | null; newestSyncedAt: string | null }>(source);

  let sharedWith: string[] = [];
  if (currentWorkspaceId) {
    const others = await db
      .prepare(
        `SELECT DISTINCT workspace_id FROM workspace_connector_configs
         WHERE source = ? AND workspace_id != ? AND status != 'skipped'`,
      )
      .all<{ workspace_id: string }>(source, currentWorkspaceId);
    sharedWith = others.map((r) => r.workspace_id);
  }

  return {
    source,
    itemCount: row?.itemCount ?? 0,
    oldestSyncedAt: row?.oldestSyncedAt ?? null,
    newestSyncedAt: row?.newestSyncedAt ?? null,
    sharedWith,
  };
}

export async function cleanupSourceData(source: string): Promise<CleanupResult> {
  await ensureInit();
  const db = getLibsqlDb();

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

  const tableExists = async (name: string): Promise<boolean> => {
    const r = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get<{ name: string }>(name);
    return Boolean(r);
  };

  // Disable FK constraints so deletes don't cascade-order-depend on FK graph
  await db.exec('PRAGMA foreign_keys = OFF');

  try {
    const ids = await db
      .prepare('SELECT id FROM work_items WHERE source = ?')
      .all<{ id: string }>(source);
    if (ids.length === 0) { await db.exec('PRAGMA foreign_keys = ON'); return result; }

    const idList = ids.map((r) => r.id);
    const chunks: string[][] = [];
    for (let i = 0; i < idList.length; i += 500) chunks.push(idList.slice(i, i + 500));

    // Collect derived IDs for cleanup
    const chunkIds: number[] = [];
    const linkIds: string[] = [];
    if (await tableExists('item_chunks')) {
      for (const chunk of chunks) {
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await db
          .prepare(`SELECT id FROM item_chunks WHERE item_id IN (${placeholders})`)
          .all<{ id: number }>(...chunk);
        for (const r of rows) chunkIds.push(r.id);
      }
    }
    if (await tableExists('links')) {
      for (const chunk of chunks) {
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await db
          .prepare(
            `SELECT id FROM links WHERE source_item_id IN (${placeholders}) OR target_item_id IN (${placeholders})`,
          )
          .all<{ id: string }>(...chunk, ...chunk);
        for (const r of rows) linkIds.push(r.id);
      }
    }

    // Delete join table referencing chunks/links
    if ((await tableExists('item_links_chunks')) && (chunkIds.length || linkIds.length)) {
      const splitter = <T>(arr: T[]): T[][] => {
        const out: T[][] = [];
        for (let i = 0; i < arr.length; i += 500) out.push(arr.slice(i, i + 500));
        return out;
      };
      for (const c of splitter(chunkIds)) {
        const ph = c.map(() => '?').join(',');
        await db
          .prepare(
            `DELETE FROM item_links_chunks WHERE source_chunk_id IN (${ph}) OR target_chunk_id IN (${ph})`,
          )
          .run(...c, ...c);
      }
      for (const c of splitter(linkIds)) {
        const ph = c.map(() => '?').join(',');
        await db.prepare(`DELETE FROM item_links_chunks WHERE link_id IN (${ph})`).run(...c);
      }
    }

    // Delete all child tables
    const childTables = [
      'work_item_versions', 'item_tags', 'item_chunks', 'workstream_items',
      'decision_items', 'entity_mentions', 'orphan_pr_candidates', 'issue_trails',
      'chunk_embeddings_meta', 'links', 'anomalies', 'ai_task_backends',
      'chat_messages', 'chat_threads', 'goals', 'metrics_snapshots',
      'schema_migrations', 'sync_log', 'tags', 'decisions',
    ];
    for (const table of childTables) {
      if (!(await tableExists(table))) continue;
      for (const chunk of chunks) {
        const placeholders = chunk.map(() => '?').join(',');
        let sql = `DELETE FROM ${table} WHERE item_id IN (${placeholders})`;
        if (table === 'orphan_pr_candidates') sql = `DELETE FROM ${table} WHERE candidate_item_id IN (${placeholders})`;
        else if (table === 'issue_trails') sql = `DELETE FROM ${table} WHERE issue_item_id IN (${placeholders})`;
        const r = await db.prepare(sql).run(...chunk);
        if (table === 'item_chunks') result.chunksDeleted += r.changes;
      }
    }

    // Delete chunk_vectors directly (FK via chunk_id → item_chunks.id)
    if (await tableExists('chunk_vectors') && chunkIds.length > 0) {
      for (const c of chunkIds) {
        await db.prepare('DELETE FROM chunk_vectors WHERE chunk_id = ?').run(c);
      }
    }

    // Finally delete work_items
    const r = await db.prepare('DELETE FROM work_items WHERE source = ?').run(source);
    result.itemsDeleted = r.changes;
  } finally {
    await db.exec('PRAGMA foreign_keys = ON');
  }

  // Clear sync stats
  if (await tableExists('workspace_connector_configs')) {
    await db
      .prepare(
        `UPDATE workspace_connector_configs
         SET last_sync_items = 0, last_sync_completed_at = NULL,
             last_sync_started_at = NULL, last_sync_status = NULL,
             last_sync_error = NULL, last_sync_log = NULL,
             updated_at = datetime('now')
         WHERE source = ?`,
      )
      .run(source);
  }

  return result;
}
