/**
 * Scan Jira + Slack work_item bodies for Notion URLs, dedupe to page IDs.
 *
 * Notion URL shapes:
 *   https://www.notion.so/<workspace>/<slug>-<32hex>
 *   https://www.notion.so/<32hex>
 *   https://<workspace>.notion.site/<slug>-<32hex>
 *   https://www.notion.so/<workspace>/<Title>-<dashed-uuid>
 *
 * Page ID can be:
 *   - 32 hex chars (no dashes), e.g. 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
 *   - UUID format with dashes (8-4-4-4-12)
 *
 * Output: JSON array of {page_id: string, source_url: string, found_in: string[]}
 * Written to stdout, one ID per line in simple mode or JSON if --json.
 */
import { getDb } from '../src/lib/db';

const NOTION_URL_RE = /https?:\/\/(?:[\w-]+\.)?notion\.(?:so|site)\/[^\s)\]"'>]+/g;
const HEX32_RE = /([a-f0-9]{32})/;
const UUID_RE = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/;

function extractPageId(url: string): string | null {
  // Strip query string
  const u = url.split('?')[0].split('#')[0];

  // Try UUID format first (8-4-4-4-12)
  const uuidMatch = u.match(UUID_RE);
  if (uuidMatch) {
    return uuidMatch[1].replace(/-/g, '');
  }

  // Fall back to 32-hex
  const hexMatch = u.match(HEX32_RE);
  if (hexMatch) {
    return hexMatch[1];
  }

  return null;
}

interface NotionRef {
  page_id: string;           // 32-hex, no dashes
  source_url: string;        // first URL seen for this page
  found_in: string[];        // work_item IDs that reference this page
}

export function extractNotionRefs(): NotionRef[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT id, body FROM work_items
      WHERE source IN ('jira', 'slack')
        AND body IS NOT NULL
        AND length(body) > 0
    `)
    .all() as { id: string; body: string }[];

  const byPageId = new Map<string, NotionRef>();

  for (const row of rows) {
    const urls = row.body.match(NOTION_URL_RE) || [];
    for (const url of urls) {
      const pageId = extractPageId(url);
      if (!pageId) continue;

      const existing = byPageId.get(pageId);
      if (existing) {
        if (!existing.found_in.includes(row.id)) existing.found_in.push(row.id);
      } else {
        byPageId.set(pageId, {
          page_id: pageId,
          source_url: url,
          found_in: [row.id],
        });
      }
    }
  }

  return Array.from(byPageId.values());
}

function main() {
  const asJson = process.argv.includes('--json');
  const refs = extractNotionRefs();

  if (asJson) {
    console.log(JSON.stringify(refs, null, 2));
  } else {
    console.error(`Found ${refs.length} unique Notion page references across Jira + Slack items.`);
    for (const r of refs) {
      console.log(`${r.page_id}\t${r.source_url}\t(${r.found_in.length} refs)`);
    }
  }
}

if (require.main === module) {
  main();
}
