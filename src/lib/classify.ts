import { getLibsqlDb } from './db/libsql';

interface Goal {
  id: string;
  name: string;
  keywords: string;
  status: string;
}

export async function classifyItem(
  title: string,
  body: string | null,
): Promise<{ goalId: string; confidence: number }[]> {
  const db = getLibsqlDb();
  const goals = await db
    .prepare("SELECT id, name, keywords, status FROM goals WHERE status = 'active'")
    .all<Goal>();

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

export async function reclassifyAll(): Promise<void> {
  const db = getLibsqlDb();

  await db
    .prepare("DELETE FROM item_tags WHERE tag_id IN (SELECT id FROM tags WHERE category = 'goal')")
    .run();

  const items = await db
    .prepare('SELECT id, title, body FROM work_items')
    .all<{ id: string; title: string; body: string | null }>();

  for (const item of items) {
    const matches = await classifyItem(item.title, item.body);
    for (const m of matches) {
      await db
        .prepare("INSERT OR IGNORE INTO tags (id, name, category) VALUES (?, ?, 'goal')")
        .run(m.goalId, m.goalId);
      await db
        .prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, ?)')
        .run(item.id, m.goalId, m.confidence);
    }
  }
}
