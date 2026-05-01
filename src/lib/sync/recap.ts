import { generateText } from 'ai';
import { getDb } from '../db';
import { getModel } from '../ai';

const PROJECT_NAMES: Record<string, string> = {
  INT: 'Integrations',
  PEX: 'Partner Experience',
  OA: 'Otti Assistant',
};

interface ProjectStats {
  key: string;
  name: string;
  itemCount: number;
  doneCount: number;
  activeCount: number;
  blockerCount: number;
  recentItems: { title: string; summary: string | null; status: string | null; source_id: string }[];
}

function getProjectStats(): ProjectStats[] {
  const db = getDb();

  const projects = db.prepare(`
    SELECT DISTINCT json_extract(metadata, '$.project') as project_key
    FROM work_items
    WHERE source = 'jira' AND json_extract(metadata, '$.project') IS NOT NULL
  `).all() as { project_key: string }[];

  return projects.map(({ project_key }) => {
    const items = db.prepare(`
      SELECT title, summary, status, source_id
      FROM work_items
      WHERE source = 'jira' AND json_extract(metadata, '$.project') = ?
      ORDER BY updated_at DESC, created_at DESC
    `).all(project_key) as any[];

    const doneCount = items.filter(i => ['done', 'closed', 'resolved'].includes(i.status || '')).length;
    const activeCount = items.filter(i => ['open', 'in_progress', 'to_do', 'in_review', 'in_development'].includes(i.status || '')).length;

    // Check for blockers from enrichment tags
    const blockerCount = db.prepare(`
      SELECT COUNT(DISTINCT wi.id) as c
      FROM work_items wi
      JOIN item_tags it ON it.item_id = wi.id
      JOIN tags t ON t.id = it.tag_id
      WHERE wi.source = 'jira'
        AND json_extract(wi.metadata, '$.project') = ?
        AND t.category = 'type' AND t.name = 'blocker'
    `).get(project_key) as any;

    return {
      key: project_key,
      name: PROJECT_NAMES[project_key] || project_key,
      itemCount: items.length,
      doneCount,
      activeCount,
      blockerCount: blockerCount?.c || 0,
      recentItems: items.slice(0, 15),
    };
  });
}

async function generateRecap(project: ProjectStats): Promise<string> {
  // Try Haiku first, fall back to a simple computed recap
  try {
    const itemList = project.recentItems
      .map(i => `- [${i.source_id}] ${i.title} (${i.status || 'unknown'})${i.summary ? ` — ${i.summary}` : ''}`)
      .join('\n');

    const { text } = await generateText({
      model: getModel('recap'),
      maxOutputTokens: 300,
      prompt: `Write a 2-3 sentence project recap for "${project.name}" (${project.key}). Stats: ${project.itemCount} total items, ${project.doneCount} done, ${project.activeCount} active, ${project.blockerCount} blockers.\n\nRecent items:\n${itemList}\n\nFocus on: what's the current state, what's being worked on, any blockers or risks. Be concise and direct. No markdown, no bullet points, just prose.`,
    });

    return text.trim() || computeSimpleRecap(project);
  } catch {
    return computeSimpleRecap(project);
  }
}

function computeSimpleRecap(project: ProjectStats): string {
  const parts: string[] = [];
  parts.push(`${project.itemCount} items tracked`);
  if (project.doneCount > 0) parts.push(`${project.doneCount} completed`);
  if (project.activeCount > 0) parts.push(`${project.activeCount} in progress`);
  if (project.blockerCount > 0) parts.push(`${project.blockerCount} blocked`);

  const pct = project.itemCount > 0 ? Math.round((project.doneCount / project.itemCount) * 100) : 0;
  return `${parts.join(', ')}. ${pct}% completion rate.`;
}

export async function generateAllRecaps(): Promise<{ generated: number }> {
  const db = getDb();

  // Ensure table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_summaries (
      project_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      recap TEXT,
      item_count INTEGER DEFAULT 0,
      done_count INTEGER DEFAULT 0,
      active_count INTEGER DEFAULT 0,
      blocker_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const projects = getProjectStats();
  let generated = 0;

  for (const project of projects) {
    console.log(`  Generating recap for ${project.key} (${project.name})...`);
    const recap = await generateRecap(project);

    db.prepare(`
      INSERT OR REPLACE INTO project_summaries (project_key, name, recap, item_count, done_count, active_count, blocker_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(project.key, project.name, recap, project.itemCount, project.doneCount, project.activeCount, project.blockerCount);

    generated++;
  }

  return { generated };
}
