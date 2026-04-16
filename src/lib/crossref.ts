import { getDb } from './db';
import { v4 as uuid } from 'uuid';

const JIRA_KEY_REGEX = /[A-Z][A-Z0-9]+-\d+/g;
const MENTION_REGEX = /@[\w.-]+/g;
const CHANNEL_REGEX = /#[\w-]+/g;

export function extractEntities(text: string) {
  return {
    jiraKeys: [...new Set(text.match(JIRA_KEY_REGEX) || [])],
    mentions: [...new Set(text.match(MENTION_REGEX) || [])],
    channels: [...new Set(text.match(CHANNEL_REGEX) || [])],
  };
}

export function createLinksForItem(itemId: string) {
  const db = getDb();
  const item = db.prepare('SELECT id, title, body, source, source_id FROM work_items WHERE id = ?').get(itemId) as any;
  if (!item) return;

  const text = `${item.title} ${item.body || ''}`;
  const entities = extractEntities(text);

  // Link to items whose source_id matches a Jira key found in this item's text
  for (const key of entities.jiraKeys) {
    const target = db.prepare("SELECT id FROM work_items WHERE source = 'jira' AND source_id = ?").get(key) as any;
    if (target && target.id !== itemId) {
      const existing = db.prepare('SELECT id FROM links WHERE source_item_id = ? AND target_item_id = ?').get(itemId, target.id);
      if (!existing) {
        db.prepare('INSERT INTO links (id, source_item_id, target_item_id, link_type, confidence) VALUES (?, ?, ?, ?, ?)').run(uuid(), itemId, target.id, 'mentions', 1.0);
      }
    }
  }

  // Link to items that mention the same Jira key as this item (if this is a Jira item)
  if (item.source === 'jira') {
    const mentioners = db.prepare("SELECT id, title, body FROM work_items WHERE id != ? AND (title LIKE ? OR body LIKE ?)").all(itemId, `%${item.source_id}%`, `%${item.source_id}%`) as any[];
    for (const m of mentioners) {
      const existing = db.prepare('SELECT id FROM links WHERE source_item_id = ? AND target_item_id = ?').get(m.id, itemId);
      if (!existing) {
        db.prepare('INSERT INTO links (id, source_item_id, target_item_id, link_type, confidence) VALUES (?, ?, ?, ?, ?)').run(uuid(), m.id, itemId, 'mentions', 1.0);
      }
    }
  }
}

export function createLinksForAll() {
  const db = getDb();
  const items = db.prepare('SELECT id FROM work_items').all() as { id: string }[];
  for (const item of items) {
    createLinksForItem(item.id);
  }
}
