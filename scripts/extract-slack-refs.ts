/**
 * Scan all ingested work_items.body (across jira, meeting, github, notion, and also slack
 * for cross-thread refs) for Slack archive permalinks. Dedupe to unique
 * (channel_id, thread_ts || ts) pairs.
 *
 * Slack permalink shapes:
 *   https://<workspace>.slack.com/archives/<channel_id>/p<ts_no_dot>
 *   https://<workspace>.slack.com/archives/<channel_id>/p<ts_no_dot>?thread_ts=<thread_ts>&cid=<channel_id>
 *
 * `ts_no_dot` is the message's own timestamp with the dot removed (last 6 digits are microseconds).
 * We reconstruct the dotted form. If `thread_ts` appears in the query string, the reference points
 * at a reply in a thread — we fetch the thread root (slack_read_thread with thread_ts).
 *
 * Output: JSON array of {channel_id, thread_ts, ts, source_url, found_in: [item_ids]}
 *
 * Usage:
 *   bunx tsx scripts/extract-slack-refs.ts --json   → JSON to stdout
 *   bunx tsx scripts/extract-slack-refs.ts           → human-readable
 */
import { getDb } from '../src/lib/db';

const SLACK_URL_RE = /https?:\/\/[\w-]+\.slack\.com\/archives\/(C[A-Z0-9]+|D[A-Z0-9]+|G[A-Z0-9]+)\/p(\d{16,20})((?:\?[^\s)\]"'>]*)?)/g;

function reconstructTs(tsNoDot: string): string {
  // Slack permalink format drops the dot: "1776787230010819" → "1776787230.010819"
  if (tsNoDot.length < 7) return tsNoDot;
  return `${tsNoDot.slice(0, -6)}.${tsNoDot.slice(-6)}`;
}

function extractThreadTsFromQuery(query: string): string | null {
  const m = query.match(/[?&]thread_ts=([\d.]+)/);
  return m ? m[1] : null;
}

export interface SlackRef {
  channel_id: string;
  thread_ts: string | null;    // null when the link points to a non-threaded message
  ts: string;                  // the specific message's ts (may differ from thread_ts for replies)
  fetch_ts: string;            // what to pass to slack_read_thread — thread_ts if present, else ts
  source_url: string;
  found_in: string[];          // work_item ids that mention this ref
}

export function extractSlackRefs(): SlackRef[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT id, body FROM work_items
      WHERE source IN ('jira', 'meeting', 'github', 'notion', 'slack')
        AND body IS NOT NULL
        AND length(body) > 0
    `)
    .all() as { id: string; body: string }[];

  const byKey = new Map<string, SlackRef>();

  for (const row of rows) {
    SLACK_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SLACK_URL_RE.exec(row.body)) !== null) {
      const [fullUrl, channelId, tsNoDot, queryStr] = m;
      const ts = reconstructTs(tsNoDot);
      const threadTs = extractThreadTsFromQuery(queryStr || '');
      const fetchTs = threadTs || ts;
      const key = `${channelId}:${fetchTs}`;

      const existing = byKey.get(key);
      if (existing) {
        if (!existing.found_in.includes(row.id)) existing.found_in.push(row.id);
      } else {
        byKey.set(key, {
          channel_id: channelId,
          thread_ts: threadTs,
          ts,
          fetch_ts: fetchTs,
          source_url: fullUrl,
          found_in: [row.id],
        });
      }
    }
  }

  return Array.from(byKey.values());
}

/**
 * Returns only the refs that don't already have a thread file locally
 * (so we don't re-fetch threads we already have from the `from:me` baseline).
 */
export function filterNewRefs(
  refs: SlackRef[],
  existingThreadFiles: Set<string>,  // set of "channel_id:thread_ts" keys
): SlackRef[] {
  return refs.filter(r => !existingThreadFiles.has(`${r.channel_id}:${r.fetch_ts}`));
}

function main() {
  const asJson = process.argv.includes('--json');
  const refs = extractSlackRefs();

  if (asJson) {
    console.log(JSON.stringify(refs, null, 2));
    console.error(`${refs.length} unique Slack refs across ingested bodies.`);
  } else {
    console.error(`Found ${refs.length} unique Slack refs.`);
    for (const r of refs) {
      const marker = r.thread_ts ? '[thread]' : '[msg]   ';
      console.log(`${marker} ${r.channel_id}/${r.fetch_ts}\t${r.found_in.length} refs\t${r.source_url}`);
    }
  }
}

if (require.main === module) {
  main();
}
