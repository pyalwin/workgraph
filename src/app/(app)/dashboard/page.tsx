import { getDb } from '@/lib/db';
import { initSchema } from '@/lib/schema';
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

function gatherSnapshot(): { snapshot: Snapshot; activity: ActivityRow[] } {
  initSchema();
  const db = getDb();

  try {
    const totalItems = (db
      .prepare('SELECT COUNT(*) AS c FROM work_items')
      .get() as { c: number }).c;

    const totalDecisions = (db
      .prepare('SELECT COUNT(*) AS c FROM decisions')
      .get() as { c: number }).c;

    const lastSync = (db
      .prepare(
        `SELECT MAX(last_sync_completed_at) AS at
         FROM workspace_connector_configs
         WHERE last_sync_status = 'success'`,
      )
      .get() as { at: string | null }).at;

    const openActionItems = (db
      .prepare(`SELECT COUNT(*) AS c FROM action_items WHERE state = 'open'`)
      .get() as { c: number }).c;

    const openAnomalies = (db
      .prepare(
        `SELECT COUNT(*) AS c FROM anomalies
         WHERE resolved_at IS NULL AND dismissed_by_user = 0`,
      )
      .get() as { c: number }).c;

    const activity = db
      .prepare(
        `SELECT id, source_id, title, source, status, url, updated_at
         FROM work_items
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT 10`,
      )
      .all() as ActivityRow[];

    return {
      snapshot: { totalItems, totalDecisions, lastSyncedAt: lastSync, openActionItems, openAnomalies },
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
  const { snapshot, activity } = gatherSnapshot();

  return (
    <div className="dash">
      <DashboardHero snapshot={snapshot} />
      <TrackerSection />
      <ActivityFeed activity={activity} />
    </div>
  );
}
