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

/**
 * Determine the appropriate link_type based on source types and context.
 *
 * - 'references' — when a Notion or Gmail item mentions a Jira key
 * - 'discusses'  — when a Slack message or meeting references another item's topic
 * - 'mentions'   — default/generic cross-reference
 */
function determineLinkType(
  sourceItem: { source: string; item_type: string },
  targetSource: string,
): string {
  // Notion or Gmail referencing a Jira key -> 'references'
  if (
    (sourceItem.source === 'notion' || sourceItem.source === 'gmail') &&
    targetSource === 'jira'
  ) {
    return 'references';
  }

  // Slack or meeting discussing another item -> 'discusses'
  if (
    sourceItem.source === 'slack' ||
    sourceItem.source === 'meeting' ||
    sourceItem.item_type === 'message' ||
    sourceItem.item_type === 'meeting'
  ) {
    return 'discusses';
  }

  return 'mentions';
}

function upsertLink(
  sourceItemId: string,
  targetItemId: string,
  linkType: string,
  confidence: number,
) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id, link_type FROM links WHERE source_item_id = ? AND target_item_id = ?',
  ).get(sourceItemId, targetItemId) as { id: string; link_type: string } | undefined;

  if (!existing) {
    db.prepare(
      'INSERT INTO links (id, source_item_id, target_item_id, link_type, confidence) VALUES (?, ?, ?, ?, ?)',
    ).run(uuid(), sourceItemId, targetItemId, linkType, confidence);
  } else if (existing.link_type === 'mentions' && linkType !== 'mentions') {
    // Upgrade a generic 'mentions' link to a more specific type
    db.prepare('UPDATE links SET link_type = ? WHERE id = ?').run(linkType, existing.id);
  }
}

export function createLinksForItem(itemId: string) {
  const db = getDb();
  const item = db.prepare(
    'SELECT id, title, body, source, source_id, item_type FROM work_items WHERE id = ?',
  ).get(itemId) as any;
  if (!item) return;

  const text = `${item.title} ${item.body || ''}`;
  const entities = extractEntities(text);

  // Link to items whose source_id matches a Jira key found in this item's text
  for (const key of entities.jiraKeys) {
    const target = db.prepare(
      "SELECT id, source FROM work_items WHERE source = 'jira' AND source_id = ?",
    ).get(key) as any;
    if (target && target.id !== itemId) {
      const linkType = determineLinkType(item, target.source);
      upsertLink(itemId, target.id, linkType, 1.0);
    }
  }

  // Link to items that mention the same Jira key as this item (if this is a Jira item)
  if (item.source === 'jira') {
    const mentioners = db.prepare(
      "SELECT id, title, body, source, item_type FROM work_items WHERE id != ? AND (title LIKE ? OR body LIKE ?)",
    ).all(itemId, `%${item.source_id}%`, `%${item.source_id}%`) as any[];
    for (const m of mentioners) {
      const linkType = determineLinkType(m, item.source);
      upsertLink(m.id, itemId, linkType, 1.0);
    }
  }

  // Topic-based linking: Slack messages and meetings that share significant title overlap
  // with other items are linked as 'discusses'
  if (item.source === 'slack' || item.source === 'meeting') {
    const titleWords = item.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .split(/\s+/)
      .filter((w: string) => w.length > 3);

    if (titleWords.length >= 2) {
      // Build a LIKE-based search for items sharing key terms from the title
      const candidates = db.prepare(
        'SELECT id, source, item_type, title FROM work_items WHERE id != ? AND source != ?',
      ).all(itemId, item.source) as any[];

      for (const candidate of candidates) {
        const candidateTitle = candidate.title.toLowerCase();
        const matchCount = titleWords.filter((w: string) => candidateTitle.includes(w)).length;
        const matchRatio = matchCount / titleWords.length;

        // Require at least 40% word overlap and at least 2 matching words
        if (matchRatio >= 0.4 && matchCount >= 2) {
          const confidence = Math.min(matchRatio, 1.0);
          upsertLink(itemId, candidate.id, 'discusses', confidence);
        }
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
