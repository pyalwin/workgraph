import { getDb } from './db';

interface Goal {
  id: string;
  name: string;
  keywords: string;
  status: string;
}

export function classifyItem(title: string, body: string | null): { goalId: string; confidence: number }[] {
  const db = getDb();
  const goals = db.prepare("SELECT id, name, keywords, status FROM goals WHERE status = 'active'").all() as Goal[];

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

export function reclassifyAll() {
  const db = getDb();

  // Clear existing goal tags
  db.prepare("DELETE FROM item_tags WHERE tag_id IN (SELECT id FROM tags WHERE category = 'goal')").run();

  const items = db.prepare('SELECT id, title, body FROM work_items').all() as { id: string; title: string; body: string | null }[];

  const insertTag = db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, ?)');

  for (const item of items) {
    const matches = classifyItem(item.title, item.body);
    for (const m of matches) {
      // Use goal id as tag id for simplicity (goal tags have category='goal')
      db.prepare("INSERT OR IGNORE INTO tags (id, name, category) VALUES (?, ?, 'goal')").run(m.goalId, m.goalId);
      insertTag.run(item.id, m.goalId, m.confidence);
    }
  }
}
