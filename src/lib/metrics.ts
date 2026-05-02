import { v4 as uuid } from 'uuid';
import { getLibsqlDb } from './db/libsql';

export async function computeMetricsSnapshot(goalId: string): Promise<void> {
  const db = getLibsqlDb();
  const today = new Date().toISOString().split('T')[0];

  const counts = (await db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN wi.status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN wi.status IN ('open', 'in_progress') THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN wi.status = 'stale' THEN 1 ELSE 0 END) as stale
      FROM item_tags it
      JOIN work_items wi ON wi.id = it.item_id
      WHERE it.tag_id = ?`,
    )
    .get(goalId)) as any;

  const linkCount = (await db
    .prepare(
      `SELECT COUNT(*) as c FROM links
       WHERE source_item_id IN (SELECT item_id FROM item_tags WHERE tag_id = ?)
          OR target_item_id IN (SELECT item_id FROM item_tags WHERE tag_id = ?)`,
    )
    .get(goalId, goalId)) as any;

  const velocity = (await db
    .prepare(
      `SELECT COUNT(*) as c FROM work_items wi
       JOIN item_tags it ON it.item_id = wi.id
       WHERE it.tag_id = ? AND wi.status = 'done'
         AND wi.updated_at >= datetime('now', '-7 days')`,
    )
    .get(goalId)) as any;

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

export async function computeAllMetrics(): Promise<void> {
  const db = getLibsqlDb();
  const goals = await db
    .prepare("SELECT id FROM goals WHERE status = 'active'")
    .all<{ id: string }>();
  for (const g of goals) {
    await computeMetricsSnapshot(g.id);
  }

  await db
    .prepare(
      `UPDATE goals SET
        item_count = (SELECT COUNT(*) FROM item_tags WHERE tag_id = goals.id),
        source_count = (SELECT COUNT(DISTINCT wi.source) FROM item_tags it JOIN work_items wi ON wi.id = it.item_id WHERE it.tag_id = goals.id),
        updated_at = datetime('now')`,
    )
    .run();
}
