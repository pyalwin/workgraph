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

  const ids = await db
    .prepare('SELECT id FROM work_items WHERE source = ?')
    .all<{ id: string }>(source);
  if (ids.length === 0) return result;

  const idList = ids.map((r) => r.id);
  const chunks: string[][] = [];
  for (let i = 0; i < idList.length; i += 500) chunks.push(idList.slice(i, i + 500));

  // Step 1: collect derived IDs (chunks and links).
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

  // Step 2: delete the join table that references chunks/links.
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

  // Step 3: delete tables that reference work_items directly.
  const childDeletes: Array<{ table: string; counter: keyof CleanupResult }> = [
    { table: 'work_item_versions', counter: 'versionsDeleted' },
    { table: 'item_tags', counter: 'tagsDeleted' },
    { table: 'item_chunks', counter: 'chunksDeleted' },
    { table: 'workstream_items', counter: 'workstreamItemsDeleted' },
    { table: 'decision_items', counter: 'decisionItemsDeleted' },
    { table: 'entity_mentions', counter: 'entityMentionsDeleted' },
  ];
  for (const { table, counter } of childDeletes) {
    if (!(await tableExists(table))) continue;
    for (const chunk of chunks) {
      const placeholders = chunk.map(() => '?').join(',');
      const r = await db
        .prepare(`DELETE FROM ${table} WHERE item_id IN (${placeholders})`)
        .run(...chunk);
      (result[counter] as number) += r.changes;
    }
  }

  // Step 4: links (two FK columns).
  if (await tableExists('links')) {
    for (const chunk of chunks) {
      const placeholders = chunk.map(() => '?').join(',');
      const r = await db
        .prepare(
          `DELETE FROM links WHERE source_item_id IN (${placeholders}) OR target_item_id IN (${placeholders})`,
        )
        .run(...chunk, ...chunk);
      result.linksDeleted += r.changes;
    }
  }

  // Step 5: work_items themselves.
  const r = await db.prepare('DELETE FROM work_items WHERE source = ?').run(source);
  result.itemsDeleted = r.changes;

  // Step 6: clear cached last-sync counters.
  if (await tableExists('workspace_connector_configs')) {
    await db
      .prepare(
        `UPDATE workspace_connector_configs
         SET last_sync_items = 0,
             last_sync_completed_at = NULL,
             last_sync_started_at = NULL,
             last_sync_status = NULL,
             last_sync_error = NULL,
             last_sync_log = NULL,
             updated_at = datetime('now')
         WHERE source = ?`,
      )
      .run(source);
  }

  return result;
}
