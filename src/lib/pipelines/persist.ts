/**
 * Persist pipeline_links for newly-ingested items + reconcile last_touch.
 *
 * Called from the post-ingest hook in connectors/runner.ts and direct-runner.ts
 * for items whose source is gmail / gcal / gdrive AND whose workspace has at
 * least one of the founder pipeline tables enabled.
 *
 * Idempotent: the unique constraint on
 *   (pipeline_table, pipeline_row_id, item_source, item_source_id)
 * makes re-ingest safe; we use INSERT OR IGNORE.
 *
 * Errors here MUST NOT fail the ingest — callers wrap in try/catch.
 */

import { randomUUID } from 'crypto';
import { getLibsqlDb } from '../db/libsql';
import { getWorkspaceConfig } from '../workspace-config';
import { matchItemToPipelineRows, type PipelineTable } from './matching';
import { syncPipelineRowToGraph } from './graph-sync';
import { enrichNewlyIngestedGmail } from '../enrichment/gmail';

const PIPELINE_SOURCES = new Set(['gmail', 'gcal', 'gdrive']);
const PIPELINE_TABLES: ReadonlyArray<PipelineTable> = ['deals', 'investors', 'people'];

interface IngestedItem {
  source: string;
  source_id: string;
  title: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Returns true if the workspace's customTables config includes any of
 * deals/investors/candidates. Cheap config-cache lookup, not a DB sniff
 * per item.
 */
async function workspaceHasPipelineTables(workspaceId: string): Promise<boolean> {
  try {
    const cfg = await getWorkspaceConfig(workspaceId);
    const ids = new Set((cfg.customTables ?? []).map((t) => t.id));
    return PIPELINE_TABLES.some((t) => ids.has(t));
  } catch {
    return false;
  }
}

/**
 * Recompute last_touch = MAX(linked work_items.created_at) for a single
 * (table, rowId). Run once per affected row after pipeline_links INSERTs.
 */
async function reconcileLastTouch(table: PipelineTable, rowId: string): Promise<void> {
  const db = getLibsqlDb();
  // Embedding the table name is safe: PIPELINE_TABLES is a closed allowlist.
  const sql = `UPDATE "${table}" SET last_touch = (
      SELECT MAX(wi.created_at) FROM pipeline_links pl
      JOIN work_items wi ON wi.source = pl.item_source AND wi.source_id = pl.item_source_id
      WHERE pl.pipeline_table = ? AND pl.pipeline_row_id = "${table}".id
    ) WHERE id = ?`;
  try {
    await db.prepare(sql).run(table, rowId);
  } catch {
    // Table missing or column missing — ignore. Matching will have already
    // been a no-op in that case so we shouldn't be here, but be defensive.
  }
}

/**
 * For each gmail/gcal/gdrive item just persisted, run pipeline matching and
 * INSERT OR IGNORE into pipeline_links, then reconcile last_touch on every
 * (table, row) pair that received a link.
 *
 * No-op if the workspace doesn't have any pipeline tables.
 */
export async function persistPipelineLinksForItems(
  workspaceId: string,
  items: IngestedItem[],
): Promise<void> {
  const candidates = items.filter((i) => PIPELINE_SOURCES.has(i.source));
  if (candidates.length === 0) return;

  // Enrich freshly-ingested Gmail items (entity extraction, content
  // classification, summary) in parallel with the pipeline-match work.
  // Fire-and-forget — never blocks pipeline_links persistence.
  enrichNewlyIngestedGmail(
    workspaceId,
    candidates.map((c) => ({ source: c.source, source_id: c.source_id })),
  ).catch(() => {
    /* best-effort, never throw into ingest */
  });

  if (!(await workspaceHasPipelineTables(workspaceId))) return;

  const db = getLibsqlDb();
  const insertSql = `INSERT OR IGNORE INTO pipeline_links
    (id, workspace_id, pipeline_table, pipeline_row_id, item_source, item_source_id, match_reason, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

  // Track (table, rowId) pairs that got a new link so we recompute last_touch
  // exactly once per affected row.
  const touched = new Set<string>();

  for (const item of candidates) {
    let matches;
    try {
      matches = await matchItemToPipelineRows(workspaceId, {
        source: item.source,
        source_id: item.source_id,
        title: item.title,
        metadata: item.metadata ?? {},
      });
    } catch {
      continue;
    }
    if (!matches || matches.length === 0) continue;

    for (const m of matches) {
      try {
        const result = await db
          .prepare(insertSql)
          .run(
            randomUUID(),
            workspaceId,
            m.table,
            m.rowId,
            item.source,
            item.source_id,
            m.reason,
            m.confidence,
          );
        // Always reconcile if a link exists for this (table,row) — re-ingest
        // can change the work_item's created_at via versioning, but the spec
        // says reconcile per affected row. Track even on IGNORE so we keep
        // last_touch fresh when re-ingesting.
        if (result.changes >= 0) {
          touched.add(`${m.table}::${m.rowId}`);
        }
      } catch {
        // pipeline_links missing or other transient — skip this match
      }
    }
  }

  for (const key of touched) {
    const idx = key.indexOf('::');
    if (idx < 0) continue;
    const table = key.slice(0, idx) as PipelineTable;
    const rowId = key.slice(idx + 2);
    await reconcileLastTouch(table, rowId);
    await syncPipelineRowToGraph(table, rowId);
  }
}
