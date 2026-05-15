import { v4 as uuid } from 'uuid';
import { getLibsqlDb } from './db/libsql';
import { buildWorkspaceItemFilter } from './active-workspace';

/**
 * Computes a metrics snapshot for a goal scoped to the given workspace.
 *
 * Although this function writes the snapshot row, the read aggregates that
 * feed it must be workspace-scoped — otherwise a goal's totals would leak
 * counts of work_items belonging to connectors not configured in this
 * workspace.
 */
export async function computeMetricsSnapshot(
  workspaceId: string,
  goalId: string,
): Promise<void> {
  const db = getLibsqlDb();
  const today = new Date().toISOString().split('T')[0];
  const filter = await buildWorkspaceItemFilter(workspaceId, 'wi');

  const counts = (await db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN wi.status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN wi.status IN ('open', 'in_progress') THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN wi.status = 'stale' THEN 1 ELSE 0 END) as stale
      FROM item_tags it
      JOIN work_items wi ON wi.id = it.item_id
      WHERE it.tag_id = ? AND ${filter.sql}`,
    )
    .get(goalId, ...filter.params)) as any;

  const linkCount = (await db
    .prepare(
      `SELECT COUNT(*) as c FROM links
       WHERE source_item_id IN (
              SELECT it.item_id FROM item_tags it
              JOIN work_items wi ON wi.id = it.item_id
              WHERE it.tag_id = ? AND ${filter.sql})
          OR target_item_id IN (
              SELECT it.item_id FROM item_tags it
              JOIN work_items wi ON wi.id = it.item_id
              WHERE it.tag_id = ? AND ${filter.sql})`,
    )
    .get(goalId, ...filter.params, goalId, ...filter.params)) as any;

  const velocity = (await db
    .prepare(
      `SELECT COUNT(*) as c FROM work_items wi
       JOIN item_tags it ON it.item_id = wi.id
       WHERE it.tag_id = ? AND wi.status = 'done'
         AND wi.updated_at >= datetime('now', '-7 days')
         AND ${filter.sql}`,
    )
    .get(goalId, ...filter.params)) as any;

  await db
    .prepare(
      `INSERT OR REPLACE INTO metrics_snapshots (id, goal_id, snapshot_date, total_items, done_items, active_items, stale_items, velocity_7d, cross_ref_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      uuid(),
      goalId,
      today,
      counts?.total || 0,
      counts?.done || 0,
      counts?.active || 0,
      counts?.stale || 0,
      velocity?.c || 0,
      linkCount?.c || 0,
    );
}

export async function computeAllMetrics(workspaceId: string): Promise<void> {
  const db = getLibsqlDb();
  const filter = await buildWorkspaceItemFilter(workspaceId, 'wi');
  const goals = await db
    .prepare("SELECT id FROM goals WHERE workspace_id = ? AND status = 'active'")
    .all<{ id: string }>(workspaceId);
  for (const g of goals) {
    await computeMetricsSnapshot(workspaceId, g.id);
  }

  await db
    .prepare(
      `UPDATE goals SET
        item_count = (
          SELECT COUNT(*) FROM item_tags it
          JOIN work_items wi ON wi.id = it.item_id
          WHERE it.tag_id = goals.id AND ${filter.sql}
        ),
        source_count = (
          SELECT COUNT(DISTINCT wi.source) FROM item_tags it
          JOIN work_items wi ON wi.id = it.item_id
          WHERE it.tag_id = goals.id AND ${filter.sql}
        ),
        updated_at = datetime('now')
       WHERE workspace_id = ?`,
    )
    .run(...filter.params, ...filter.params, workspaceId);
}
