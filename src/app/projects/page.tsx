import { getDb } from '@/lib/db';
import { initSchema, seedGoals } from '@/lib/schema';
import ProjectsClient, { type GoalWithItems } from './projects-client';

export const dynamic = 'force-dynamic';

interface GoalRow {
  id: string;
  name: string;
  description: string;
  keywords: string;
  item_count: number;
  done_count: number;
  active_count: number;
  source_count: number;
}

interface RecentItemRow {
  id: string;
  title: string;
  source: string;
  status: string;
  source_id: string;
  created_at: string;
  updated_at: string | null;
  body: string | null;
  author: string | null;
  url: string | null;
  metadata: string | null;
  link_count: number;
  version_count: number;
}

function getProjectsData(): { goals: GoalWithItems[]; hasData: boolean } {
  try {
    initSchema();
    seedGoals();
    const db = getDb();

    const goals = db.prepare(`
      SELECT g.id, g.name, g.description, g.keywords,
        COUNT(it.item_id) as item_count,
        SUM(CASE WHEN wi.status IN ('done', 'closed', 'resolved') THEN 1 ELSE 0 END) as done_count,
        SUM(CASE WHEN wi.status IN ('open', 'in_progress', 'to_do') THEN 1 ELSE 0 END) as active_count,
        COUNT(DISTINCT wi.source) as source_count
      FROM goals g
      LEFT JOIN item_tags it ON it.tag_id = g.id
      LEFT JOIN work_items wi ON wi.id = it.item_id
      WHERE g.status = 'active'
      GROUP BY g.id
      ORDER BY g.sort_order
    `).all() as GoalRow[];

    const recentItemsStmt = db.prepare(`
      SELECT wi.id, wi.title, wi.source, wi.status, wi.source_id,
             wi.created_at, wi.updated_at, wi.body, wi.author, wi.url, wi.metadata,
             (SELECT COUNT(*) FROM links WHERE source_item_id = wi.id OR target_item_id = wi.id) as link_count,
             (SELECT COUNT(*) FROM work_item_versions WHERE item_id = wi.id) as version_count
      FROM work_items wi
      JOIN item_tags it ON it.item_id = wi.id
      WHERE it.tag_id = ?
      ORDER BY wi.created_at DESC
      LIMIT 15
    `);

    const goalsWithItems = goals.map(goal => ({
      ...goal,
      recentItems: recentItemsStmt.all(goal.id) as RecentItemRow[],
    }));

    return { goals: goalsWithItems, hasData: goals.length > 0 };
  } catch {
    return { goals: [], hasData: false };
  }
}

export default function ProjectsPage() {
  const { goals, hasData } = getProjectsData();

  return <ProjectsClient goals={goals} hasData={hasData} />;
}
