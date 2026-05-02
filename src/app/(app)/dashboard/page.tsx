import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
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
    const totalItemsRow = await db
      .prepare('SELECT COUNT(*) AS c FROM work_items')
      .get<{ c: number }>();
    const totalDecisionsRow = await db
      .prepare('SELECT COUNT(*) AS c FROM decisions')
      .get<{ c: number }>();
    const lastSyncRow = await db
      .prepare(
        `SELECT MAX(last_sync_completed_at) AS at
         FROM workspace_connector_configs
         WHERE last_sync_status = 'success'`,
      )
      .get<{ at: string | null }>();
    const openActionItemsRow = await db
      .prepare(`SELECT COUNT(*) AS c FROM action_items WHERE state = 'open'`)
      .get<{ c: number }>();
    const openAnomaliesRow = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM anomalies
         WHERE resolved_at IS NULL AND dismissed_by_user = 0`,
      )
      .get<{ c: number }>();

    const activity = await db
      .prepare(
        `SELECT id, source_id, title, source, status, url, updated_at
         FROM work_items
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT 10`,
      )
      .all<ActivityRow>();

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
  const { snapshot, activity } = await gatherSnapshot();

  return (
    <div className="dash">
      <DashboardHero snapshot={snapshot} />
      <TrackerSection />
      <ActivityFeed activity={activity} />
    </div>
  );
}
