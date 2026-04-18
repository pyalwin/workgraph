/**
 * Accepts enrichment data from stdin and stores it in the DB.
 * Used by the Claude scheduled agent — the agent generates the enrichment
 * and pipes it to this script. No API key needed.
 *
 * Input format (JSON array):
 * [
 *   {
 *     "item_id": "uuid",
 *     "summary": "Concise summary",
 *     "item_type": "decision",
 *     "topics": ["auth", "pipeline"],
 *     "entities": ["Arun", "PEX-123"],
 *     "goals": ["ai-copilot", "platform"]
 *   }
 * ]
 */
import { getDb } from '../src/lib/db';
import { initSchema } from '../src/lib/schema';

initSchema();

function storeTags(itemId: string, category: string, names: string[]) {
  const db = getDb();
  for (const name of names) {
    if (!name || name.length < 2) continue;
    const normalized = name.toLowerCase().trim();
    const tagId = `${category}:${normalized}`;

    const existing = db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId);
    if (!existing) {
      db.prepare('INSERT INTO tags (id, name, category) VALUES (?, ?, ?)').run(tagId, normalized, category);
    }
    db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, 1.0)').run(itemId, tagId);
  }
}

function storeGoals(itemId: string, goalIds: string[]) {
  const db = getDb();
  const activeGoals = db.prepare("SELECT id FROM goals WHERE status = 'active'").all() as { id: string }[];
  const goalIdSet = new Set(activeGoals.map(g => g.id));

  // Clear old goal tags
  for (const gid of goalIdSet) {
    db.prepare('DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?').run(itemId, gid);
  }

  // Store new
  for (const goalId of goalIds) {
    if (!goalIdSet.has(goalId)) continue;
    const existing = db.prepare('SELECT id FROM tags WHERE id = ?').get(goalId);
    if (!existing) {
      const goal = db.prepare('SELECT name FROM goals WHERE id = ?').get(goalId) as { name: string };
      db.prepare("INSERT INTO tags (id, name, category) VALUES (?, ?, 'goal')").run(goalId, goal.name);
    }
    db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, 1.0)').run(itemId, goalId);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const raw = await readStdin();
  const enrichments = JSON.parse(raw);
  const db = getDb();

  let stored = 0;
  for (const e of enrichments) {
    if (!e.item_id) continue;

    // Verify item exists
    const item = db.prepare('SELECT id FROM work_items WHERE id = ?').get(e.item_id);
    if (!item) continue;

    // Store summary
    if (e.summary) {
      db.prepare("UPDATE work_items SET summary = ?, enriched_at = datetime('now') WHERE id = ?").run(e.summary, e.item_id);
    }

    // Store tags
    if (e.item_type) storeTags(e.item_id, 'type', [e.item_type]);
    if (e.topics) storeTags(e.item_id, 'topic', e.topics);
    if (e.entities) storeTags(e.item_id, 'entity', e.entities);
    if (e.goals) storeGoals(e.item_id, e.goals);

    stored++;
  }

  console.log(JSON.stringify({ stored, total: enrichments.length }));
}

main().catch(err => {
  console.error('Store enrichment failed:', err.message);
  process.exit(1);
});
