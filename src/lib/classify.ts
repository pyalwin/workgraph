import { getLibsqlDb } from './db/libsql';

interface Goal {
  id: string;
  name: string;
  keywords: string;
  status: string;
}

export async function classifyItem(
  workspaceId: string,
  title: string,
  body: string | null,
): Promise<{ goalId: string; confidence: number }[]> {
  const db = getLibsqlDb();
  const goals = await db
    .prepare(
      "SELECT id, name, keywords, status FROM goals WHERE workspace_id = ? AND status = 'active'",
    )
    .all<Goal>(workspaceId);

  const text = `${title} ${body || ''}`.toLowerCase();
  const matches: { goalId: string; confidence: number }[] = [];

  for (const goal of goals) {
    const keywords: string[] = JSON.parse(goal.keywords);
    let matchCount = 0;

    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) {
        matchCount++;
      }
    }

    if (matchCount > 0) {
      const confidence = Math.min(1.0, matchCount * 0.3 + 0.4);
      matches.push({ goalId: goal.id, confidence });
    }
  }

  return matches;
}

export async function reclassifyAll(workspaceId: string): Promise<void> {
  const db = getLibsqlDb();

  await db
    .prepare(
      "DELETE FROM item_tags WHERE tag_id IN (SELECT id FROM tags WHERE category = 'goal' AND workspace_id = ?)",
    )
    .run(workspaceId);

  const items = await db
    .prepare('SELECT id, title, body FROM work_items')
    .all<{ id: string; title: string; body: string | null }>();

  for (const item of items) {
    const matches = await classifyItem(workspaceId, item.title, item.body);
    for (const m of matches) {
      await db
        .prepare(
          "INSERT OR IGNORE INTO tags (id, name, category, workspace_id) VALUES (?, ?, 'goal', ?)",
        )
        .run(m.goalId, m.goalId, workspaceId);
      await db
        .prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, ?)')
        .run(item.id, m.goalId, m.confidence);
    }
  }
}
