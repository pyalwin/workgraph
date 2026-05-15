import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import {
  buildWorkspaceItemFilter,
  getActiveWorkspaceId,
} from '@/lib/active-workspace';
import { TrackerSection } from './tracker';
import { DashboardHero } from './dashboard-hero';
import { ActivityFeed } from './activity-feed';

export const dynamic = 'force-dynamic';

interface Snapshot {
  totalItems: number;
  totalDecisions: number;
  lastSyncedAt: string | null;
  openActionItems: number;
  openAnomalies: number;
}

interface ActivityRow {
  id: string;
  source_id: string;
  title: string;
  source: string;
  status: string | null;
  url: string | null;
  updated_at: string | null;
}

async function gatherSnapshot(): Promise<{ snapshot: Snapshot; activity: ActivityRow[] }> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  try {
    const workspaceId = await getActiveWorkspaceId();
    const filter = await buildWorkspaceItemFilter(workspaceId, 'wi');

    const totalItemsRow = await db
      .prepare(`SELECT COUNT(*) AS c FROM work_items wi WHERE ${filter.sql}`)
      .get<{ c: number }>(...filter.params);
    // Decisions inherit workspace via decisions.item_id → work_items.id;
    // join through work_items so a workspace's count excludes other
    // workspaces' rows. (decisions itself has no workspace_id column —
    // see Phase 3 design notes; we deliberately scope transitively.)
    const totalDecisionsRow = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM decisions d
         JOIN work_items wi ON wi.id = d.item_id
         WHERE ${filter.sql}`,
      )
      .get<{ c: number }>(...filter.params);
    const lastSyncRow = await db
      .prepare(
        `SELECT MAX(last_sync_completed_at) AS at
         FROM workspace_connector_configs
         WHERE workspace_id = ? AND last_sync_status = 'success'`,
      )
      .get<{ at: string | null }>(workspaceId);
    const openActionItemsRow = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM action_items ai
         JOIN work_items wi ON wi.id = ai.source_item_id
         WHERE ai.state = 'open' AND ${filter.sql}`,
      )
      .get<{ c: number }>(...filter.params);
    const openAnomaliesRow = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM anomalies
         WHERE workspace_id = ? AND resolved_at IS NULL AND dismissed_by_user = 0`,
      )
      .get<{ c: number }>(workspaceId);

    const activity = await db
      .prepare(
        `SELECT wi.id, wi.source_id, wi.title, wi.source, wi.status, wi.url, wi.updated_at
         FROM work_items wi
         WHERE ${filter.sql}
         ORDER BY COALESCE(wi.updated_at, wi.created_at) DESC
         LIMIT 10`,
      )
      .all<ActivityRow>(...filter.params);

    return {
      snapshot: {
        totalItems: totalItemsRow?.c ?? 0,
        totalDecisions: totalDecisionsRow?.c ?? 0,
        lastSyncedAt: lastSyncRow?.at ?? null,
        openActionItems: openActionItemsRow?.c ?? 0,
        openAnomalies: openAnomaliesRow?.c ?? 0,
      },
      activity,
    };
  } catch {
    return {
      snapshot: { totalItems: 0, totalDecisions: 0, lastSyncedAt: null, openActionItems: 0, openAnomalies: 0 },
      activity: [],
    };
  }
}

export default async function DashboardPage() {
  const workspaceId = await getActiveWorkspaceId();
  const { snapshot, activity } = await gatherSnapshot();

  return (
    <div className="dash">
      <DashboardHero snapshot={snapshot} />
      <TrackerSection workspaceId={workspaceId} />
      <ActivityFeed activity={activity} />
    </div>
  );
}
