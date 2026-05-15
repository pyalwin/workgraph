/**
 * Materialize pipeline_links as graph edges.
 *
 * The graph viz at /api/graph reads from `links` (between work_items), not
 * `pipeline_links` (between work_items and custom-table rows). To make a
 * deal/investor/candidate show up as a hub in the graph, we mirror each
 * pipeline row as a synthetic work_items row (source='pipeline',
 * source_id='<table>:<rowId>') and write one `links` row per pipeline_link.
 *
 * Reconciliation runs in two places:
 *   - After a pipeline row is created/updated/deleted via the /api/tables
 *     routes — keeps the synthetic work_item in sync with row state.
 *   - After pipeline_links INSERTs (auto-match in persist.ts and manual
 *     pin/unpin in the links route) — keeps the `links` edges in sync.
 *
 * A one-time backfill (syncAllPipelineRows) seeds graph state for workspaces
 * that already have pipeline data from before this materialization landed.
 */
import { randomUUID } from 'crypto';
import { getLibsqlDb } from '../db/libsql';
import { listWorkspaceConfigs } from '../workspace-config';
import { persistPipelineLinksForItems } from './persist';

export type PipelineTable = 'deals' | 'investors' | 'people';
const PIPELINE_TABLES: ReadonlyArray<PipelineTable> = ['deals', 'investors', 'people'];
const LINK_TYPE = 'pipeline_match';

function syntheticSourceId(table: PipelineTable, rowId: string): string {
  return `${table}:${rowId}`;
}

function displayNameFor(table: PipelineTable, row: Record<string, unknown>): string {
  if (table === 'investors') return String(row.firm ?? row.name ?? 'Investor');
  return String(row.name ?? 'Untitled');
}

function itemTypeFor(table: PipelineTable): string {
  if (table === 'deals') return 'deal';
  if (table === 'investors') return 'investor';
  return 'person'; // people table — broader than candidates; covers team/advisor/etc.
}

async function loadRow(
  table: PipelineTable,
  rowId: string,
): Promise<Record<string, unknown> | null> {
  const db = getLibsqlDb();
  try {
    return (await db
      .prepare(`SELECT * FROM "${table}" WHERE id = ?`)
      .get<Record<string, unknown>>(rowId)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Upsert the synthetic work_items row for a pipeline row. Returns its id.
 */
async function upsertSyntheticItem(
  table: PipelineTable,
  rowId: string,
  row: Record<string, unknown>,
): Promise<string> {
  const db = getLibsqlDb();
  const sourceId = syntheticSourceId(table, rowId);
  const title = displayNameFor(table, row);
  const itemType = itemTypeFor(table);
  const stage = typeof row.stage === 'string' ? row.stage : null;
  const url = `/tables/${table}/${rowId}`;
  const body = typeof row.notes === 'string' ? row.notes : null;

  // metadata = everything that isn't title/notes/id, JSON-encoded
  const meta: Record<string, unknown> = { table };
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id' || k === 'notes' || v === null || v === undefined) continue;
    meta[k] = v;
  }
  const metadata = JSON.stringify(meta);

  const existing = await db
    .prepare(`SELECT id FROM work_items WHERE source = 'pipeline' AND source_id = ?`)
    .get<{ id: string }>(sourceId);

  if (existing) {
    await db
      .prepare(
        `UPDATE work_items
         SET title = ?, item_type = ?, status = ?, body = ?, url = ?, metadata = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(title, itemType, stage, body, url, metadata, existing.id);
    return existing.id;
  }

  const id = randomUUID();
  await db
    .prepare(
      `INSERT INTO work_items
        (id, source, source_id, item_type, title, body, status, url, metadata, created_at, updated_at)
       VALUES (?, 'pipeline', ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, sourceId, itemType, title, body, stage, url, metadata);
  return id;
}

/**
 * For a given pipeline row, ensure the `links` table has exactly one
 * pipeline_match edge from each linked work_item to the synthetic item,
 * and no stale ones.
 */
async function reconcileLinkEdges(
  table: PipelineTable,
  rowId: string,
  syntheticId: string,
): Promise<void> {
  const db = getLibsqlDb();

  // Desired set: work_item ids from pipeline_links join work_items.
  const desired = await db
    .prepare(
      `SELECT wi.id AS item_id, pl.confidence AS confidence
       FROM pipeline_links pl
       JOIN work_items wi
         ON wi.source = pl.item_source AND wi.source_id = pl.item_source_id
       WHERE pl.pipeline_table = ? AND pl.pipeline_row_id = ?`,
    )
    .all<{ item_id: string; confidence: number }>(table, rowId);

  const desiredIds = new Set(desired.map((d) => d.item_id));

  // Existing pipeline_match edges that target this synthetic.
  const existing = await db
    .prepare(
      `SELECT id, source_item_id FROM links
       WHERE target_item_id = ? AND link_type = ?`,
    )
    .all<{ id: string; source_item_id: string }>(syntheticId, LINK_TYPE);

  const existingByItem = new Map(existing.map((e) => [e.source_item_id, e.id]));

  // Insert missing edges
  for (const { item_id, confidence } of desired) {
    if (existingByItem.has(item_id)) continue;
    await db
      .prepare(
        `INSERT INTO links (id, source_item_id, target_item_id, link_type, confidence)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), item_id, syntheticId, LINK_TYPE, confidence ?? 0.7);
  }

  // Delete stale edges
  for (const [itemId, linkId] of existingByItem) {
    if (desiredIds.has(itemId)) continue;
    await db.prepare(`DELETE FROM links WHERE id = ?`).run(linkId);
  }
}

/**
 * Upsert the synthetic work_item AND reconcile its incoming pipeline_match
 * edges. Call after any change to a pipeline row OR its pipeline_links.
 * Idempotent and cheap (only the rows for this single pipeline row).
 *
 * Errors are swallowed — graph materialization is best-effort and must
 * never fail the upstream API call.
 */
export async function syncPipelineRowToGraph(
  table: PipelineTable,
  rowId: string,
  opts: { workspaceId?: string; backfillMatches?: boolean } = {},
): Promise<void> {
  try {
    const row = await loadRow(table, rowId);
    if (!row) {
      // Row was deleted between the caller's action and our sync — clean up
      // any stale synthetic.
      await removePipelineRowFromGraph(table, rowId);
      return;
    }
    const syntheticId = await upsertSyntheticItem(table, rowId, row);

    // Backfill: if the caller set backfillMatches (default true on
    // create/update from the table API), scan existing gmail/gcal/gdrive
    // work_items whose participants/attendees/owners reference this row's
    // match key (domain for deals, partner_email for investors, email for
    // candidates). New matches become pipeline_links rows so the edge
    // reconciliation below picks them up.
    const shouldBackfill = opts.backfillMatches !== false;
    if (shouldBackfill && opts.workspaceId) {
      try {
        await backfillMatchesForRow(opts.workspaceId, table, rowId, row);
      } catch {
        /* best-effort — graph reconciliation still runs */
      }
    }

    await reconcileLinkEdges(table, rowId, syntheticId);
  } catch {
    // best-effort
  }
}

/**
 * For a single pipeline row, scan existing gmail/gcal/gdrive work_items
 * whose participants/attendees/owners reference its match key and insert
 * any new pipeline_links. Cheap because the LIKE filter on metadata pre-
 * filters candidates before the per-item matcher runs.
 */
async function backfillMatchesForRow(
  workspaceId: string,
  table: PipelineTable,
  rowId: string,
  row: Record<string, unknown>,
): Promise<void> {
  // Determine the match key(s). Each table type matches on different fields.
  const keys: string[] = [];
  if (table === 'deals' && typeof row.domain === 'string' && row.domain.trim()) {
    keys.push(row.domain.trim().toLowerCase());
  } else if (table === 'investors' && typeof row.partner_email === 'string' && row.partner_email.trim()) {
    keys.push(row.partner_email.trim().toLowerCase());
  } else if (table === 'people' && typeof row.email === 'string' && row.email.trim()) {
    keys.push(row.email.trim().toLowerCase());
  }
  // Deals also match by their `name` against gdrive file titles, so include
  // it as a secondary scan key for completeness.
  if (table === 'deals' && typeof row.name === 'string' && row.name.trim()) {
    keys.push(row.name.trim().toLowerCase());
  }
  if (keys.length === 0) return;

  const db = getLibsqlDb();
  const seen = new Set<string>();
  for (const key of keys) {
    // LIKE on metadata cheaply narrows candidates by substring. Per-item
    // matching still runs (above) for actual confirmation.
    const candidates = await db
      .prepare(
        `SELECT id, source, source_id, title, metadata
         FROM work_items
         WHERE source IN ('gmail', 'gcal', 'gdrive')
           AND (LOWER(metadata) LIKE '%' || ? || '%' OR LOWER(title) LIKE '%' || ? || '%')`,
      )
      .all<{
        id: string;
        source: string;
        source_id: string;
        title: string;
        metadata: string | null;
      }>(key, key);
    for (const c of candidates) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
    }
  }

  if (seen.size === 0) return;

  // Lazy-load matching + persistence to avoid circular imports at module
  // load (graph-sync ← persist ← graph-sync was the prior pattern).
  const { matchItemToPipelineRows } = await import('./matching');
  const { randomUUID } = await import('crypto');
  const insertSql = `INSERT OR IGNORE INTO pipeline_links
    (id, workspace_id, pipeline_table, pipeline_row_id, item_source, item_source_id, match_reason, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

  // Fetch the full work_item rows we still need (we have ids in `seen`, but
  // we also need title + metadata for the matcher).
  const placeholders = Array.from(seen).map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT id, source, source_id, title, metadata FROM work_items
       WHERE id IN (${placeholders})`,
    )
    .all<{ id: string; source: string; source_id: string; title: string; metadata: string | null }>(
      ...Array.from(seen),
    );

  let inserted = 0;
  for (const wi of rows) {
    let meta: Record<string, unknown> = {};
    try {
      meta = wi.metadata ? (JSON.parse(wi.metadata) as Record<string, unknown>) : {};
    } catch {
      meta = {};
    }
    const matches = await matchItemToPipelineRows(workspaceId, {
      source: wi.source,
      source_id: wi.source_id,
      title: wi.title,
      metadata: meta,
    });
    // Only persist matches that point at THIS row — backfill is row-scoped,
    // and we don't want to accidentally write rows for unrelated pipeline
    // entries that the matcher might also surface.
    for (const m of matches) {
      if (m.table !== table || m.rowId !== rowId) continue;
      try {
        await db
          .prepare(insertSql)
          .run(
            randomUUID(),
            workspaceId,
            m.table,
            m.rowId,
            wi.source,
            wi.source_id,
            m.reason,
            m.confidence,
          );
        inserted += 1;
      } catch {
        /* best-effort per insert */
      }
    }
  }

  if (inserted > 0) {
    console.log(`[pipelines] backfilled ${inserted} matches for ${table}:${rowId} (scanned ${rows.length})`);
  }
}

/**
 * Delete the synthetic work_item for a pipeline row AND its incoming edges.
 * Call when the pipeline row itself is deleted.
 */
export async function removePipelineRowFromGraph(
  table: PipelineTable,
  rowId: string,
): Promise<void> {
  try {
    const db = getLibsqlDb();
    const sourceId = syntheticSourceId(table, rowId);
    const existing = await db
      .prepare(`SELECT id FROM work_items WHERE source = 'pipeline' AND source_id = ?`)
      .get<{ id: string }>(sourceId);
    if (!existing) return;
    await db
      .prepare(`DELETE FROM links WHERE source_item_id = ? OR target_item_id = ?`)
      .run(existing.id, existing.id);
    await db.prepare(`DELETE FROM work_items WHERE id = ?`).run(existing.id);
  } catch {
    // best-effort
  }
}

/**
 * Sync helper for callers that have a (table, rowId) pair from a string key
 * like the touched-set in persist.ts.
 */
export async function syncManyPipelineRows(
  pairs: Iterable<{ table: PipelineTable; rowId: string }>,
): Promise<void> {
  for (const { table, rowId } of pairs) {
    await syncPipelineRowToGraph(table, rowId);
  }
}

/**
 * Backfill: walk every row in deals/investors/candidates and sync each.
 * Idempotent — safe to run repeatedly.
 */
export async function syncAllPipelineRows(): Promise<{
  scanned: number;
  synced: number;
}> {
  const db = getLibsqlDb();
  let scanned = 0;
  let synced = 0;
  for (const table of PIPELINE_TABLES) {
    let rows: Array<{ id: string }> = [];
    try {
      rows = await db.prepare(`SELECT id FROM "${table}"`).all<{ id: string }>();
    } catch {
      continue; // table doesn't exist in this workspace
    }
    scanned += rows.length;
    for (const r of rows) {
      await syncPipelineRowToGraph(table, r.id);
      synced += 1;
    }
  }
  return { scanned, synced };
}

/**
 * Full pipeline rebuild for the founder workspace(s):
 *
 *   1. Re-run matching against every already-ingested gmail/gcal/gdrive
 *      work_item (matching normally only runs at ingest time, so items
 *      synced before pipeline rows existed have no links).
 *   2. Materialize synthetic work_items + `links` edges for every row in
 *      deals/investors/candidates.
 *
 * Returns counts useful for UI feedback. Idempotent.
 */
export async function rebuildPipelineMatchesAndGraph(): Promise<{
  itemsMatched: number;
  scanned: number;
  synced: number;
}> {
  const db = getLibsqlDb();

  // 1. Load existing gmail/gcal/gdrive items.
  let items: Array<{
    source: string;
    source_id: string;
    title: string;
    metadata: string | null;
  }> = [];
  try {
    items = await db
      .prepare(
        `SELECT source, source_id, title, metadata
         FROM work_items
         WHERE source IN ('gmail', 'gcal', 'gdrive')`,
      )
      .all<{ source: string; source_id: string; title: string; metadata: string | null }>();
  } catch {
    items = [];
  }

  const parsed = items.map((i) => {
    let metadata: Record<string, unknown> | null = null;
    if (i.metadata) {
      try {
        metadata = JSON.parse(i.metadata) as Record<string, unknown>;
      } catch {
        metadata = null;
      }
    }
    return { source: i.source, source_id: i.source_id, title: i.title, metadata };
  });

  // 2. Re-run matching per workspace that owns the founder pipeline tables.
  if (parsed.length > 0) {
    const workspaces = await listWorkspaceConfigs();
    for (const ws of workspaces) {
      const hasPipelineTables = (ws.customTables ?? []).some((t) =>
        PIPELINE_TABLES.includes(t.id as PipelineTable),
      );
      if (!hasPipelineTables) continue;
      try {
        await persistPipelineLinksForItems(ws.id, parsed);
      } catch {
        // best-effort
      }
    }
  }

  // 3. Materialize synthetic items + edges from the (now-fresh) pipeline_links.
  const graph = await syncAllPipelineRows();
  return { itemsMatched: parsed.length, ...graph };
}
