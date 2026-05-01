/**
 * Parse Slack search pages saved by the paginator subagent.
 *
 * Each page file is { results: <markdown string>, pagination_info: <string> }.
 * The markdown contains per-message blocks starting with "### Result N of M".
 *
 * Outputs (to stdout as JSON by default, or to files with --write):
 *   - `messages`: all parsed structured messages
 *   - `threads`:  unique (channel_id, thread_ts) pairs for follow-up slack_read_thread calls
 *
 * Usage:
 *   bunx tsx scripts/slack-parse-pages.ts                             # JSON to stdout
 *   bunx tsx scripts/slack-parse-pages.ts --write                      # write parsed-messages.json + thread-list.json
 *   bunx tsx scripts/slack-parse-pages.ts --dir=/tmp/workgraph-sync/slack
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

export interface ParsedSlackMessage {
  channel_id: string;
  channel_name: string | null;
  user: string;
  user_name: string;
  time: string;
  ts: string;
  thread_ts: string | null;
  text: string;
  permalink: string;
}

const FIELD_PATTERNS = {
  channel: /Channel:\s*(#\S+|[^()\n]+?)\s*\(ID:\s*(C\w+)\)/,
  from: /From:\s*(.+?)\s*\(ID:\s*(U\w+|B\w+)\)/,
  time: /Time:\s*(.+)/,
  ts: /Message_ts:\s*([\d.]+)/,
  permalink: /Permalink:\s*\[link\]\(([^)]+)\)/,
};

function extractThreadTsFromPermalink(url: string): string | null {
  const m = url.match(/[?&]thread_ts=([\d.]+)/);
  return m ? m[1] : null;
}

function parseOneBlock(block: string): ParsedSlackMessage | null {
  const channelMatch = block.match(FIELD_PATTERNS.channel);
  const fromMatch = block.match(FIELD_PATTERNS.from);
  const timeMatch = block.match(FIELD_PATTERNS.time);
  const tsMatch = block.match(FIELD_PATTERNS.ts);
  const permalinkMatch = block.match(FIELD_PATTERNS.permalink);

  if (!tsMatch) return null;

  // Text: everything after "Text:" line until end of block
  const textIdx = block.indexOf('\nText:');
  const text = textIdx >= 0 ? block.slice(textIdx + 6).trim() : '';

  const channelRawName = channelMatch?.[1]?.trim() || '';
  const permalink = permalinkMatch?.[1] || '';

  return {
    channel_id: channelMatch?.[2] || '',
    channel_name: channelRawName.startsWith('#')
      ? channelRawName
      : channelRawName || null,
    user: fromMatch?.[2] || '',
    user_name: fromMatch?.[1]?.trim() || 'unknown',
    time: timeMatch?.[1]?.trim() || '',
    ts: tsMatch[1],
    thread_ts: extractThreadTsFromPermalink(permalink),
    text,
    permalink,
  };
}

export function parseSlackMarkdown(markdown: string): ParsedSlackMessage[] {
  // Split on "### Result N of M" — first split is preamble, discard it.
  const blocks = markdown.split(/\n### Result \d+ of \d+\n?/).slice(1);
  const messages: ParsedSlackMessage[] = [];
  for (const block of blocks) {
    const parsed = parseOneBlock(block);
    if (parsed) messages.push(parsed);
  }
  return messages;
}

export function parseAllPages(dir: string): ParsedSlackMessage[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter(f => /^page-.*\.json$/.test(f))
    .sort();

  const all: ParsedSlackMessage[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, f), 'utf-8'));
      const md = typeof raw.results === 'string' ? raw.results : '';
      all.push(...parseSlackMarkdown(md));
    } catch (err: any) {
      console.error(`  parse error in ${f}: ${err.message}`);
    }
  }
  return all;
}

/**
 * Parse the markdown format that `slack_read_thread` returns:
 *   === THREAD PARENT MESSAGE ===
 *   From: <name> (<Uxxx>)
 *   Time: <date>
 *   Message TS: <ts>
 *   <body text>
 *   Reactions: ...
 *
 *   === THREAD REPLIES (N total) ===
 *
 *   --- Reply 1 of N ---
 *   From: ...
 *   Time: ...
 *   Message TS: ...
 *   <body>
 *   Reactions: ...
 */
export interface ThreadMessage {
  user: string;
  user_name: string;
  time: string;
  ts: string;
  text: string;
}

function parseOneThreadMessage(block: string): ThreadMessage | null {
  const fromMatch = block.match(/From:\s*(.+?)\s*\(([UB]\w+)\)/);
  const timeMatch = block.match(/Time:\s*(.+)/);
  const tsMatch = block.match(/Message TS:\s*([\d.]+)/);
  if (!tsMatch) return null;

  // Body = everything after the "Message TS: <ts>" line, up to Reactions line or end
  const tsLine = tsMatch[0];
  const tsIdx = block.indexOf(tsLine);
  const afterTs = block.slice(tsIdx + tsLine.length).replace(/^\s*\n/, '');
  const reactionsIdx = afterTs.search(/\n?Reactions:/);
  const text = reactionsIdx >= 0 ? afterTs.slice(0, reactionsIdx).trim() : afterTs.trim();

  return {
    user: fromMatch?.[2] || '',
    user_name: fromMatch?.[1]?.trim() || 'unknown',
    time: timeMatch?.[1]?.trim() || '',
    ts: tsMatch[1],
    text,
  };
}

export function parseThreadMarkdown(md: string): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  if (!md || typeof md !== 'string') return messages;

  // Parent message block — between "=== THREAD PARENT MESSAGE ===" and the next === or --- heading
  const parentMatch = md.match(/=== THREAD PARENT MESSAGE ===\s*\n([\s\S]*?)(?=\n===|\n--- Reply|$)/);
  if (parentMatch) {
    const m = parseOneThreadMessage(parentMatch[1]);
    if (m) messages.push(m);
  }

  // Replies — split on "--- Reply N of M ---"
  const replyHeadingRe = /---\s*Reply\s+\d+\s+of\s+\d+\s*---/;
  const afterRepliesMarker = md.split(/=== THREAD REPLIES[^=]*===\s*/)[1];
  const repliesBlob = afterRepliesMarker !== undefined ? afterRepliesMarker : md;
  const replyBlocks = repliesBlob.split(replyHeadingRe).slice(1);
  for (const block of replyBlocks) {
    const m = parseOneThreadMessage(block);
    if (m) messages.push(m);
  }

  return messages;
}

export function extractThreadSeeds(messages: ParsedSlackMessage[]): Array<{ channel_id: string; thread_ts: string }> {
  const seen = new Set<string>();
  const seeds: Array<{ channel_id: string; thread_ts: string }> = [];
  for (const m of messages) {
    if (!m.thread_ts || !m.channel_id) continue;
    const key = `${m.channel_id}:${m.thread_ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    seeds.push({ channel_id: m.channel_id, thread_ts: m.thread_ts });
  }
  return seeds;
}

function main() {
  const dirArg = process.argv.find(a => a.startsWith('--dir='));
  const dir = dirArg ? dirArg.split('=')[1] : '/tmp/workgraph-sync/slack';
  const write = process.argv.includes('--write');

  const messages = parseAllPages(dir);
  const threads = extractThreadSeeds(messages);

  if (write) {
    writeFileSync(
      path.join(dir, 'parsed-messages.json'),
      JSON.stringify(messages, null, 0),
    );
    writeFileSync(
      path.join(dir, 'thread-list.json'),
      JSON.stringify(threads, null, 2),
    );
    console.error(`Wrote ${messages.length} messages, ${threads.length} unique threads.`);
  } else {
    console.log(JSON.stringify({ messages, threads }, null, 2));
    console.error(`${messages.length} messages, ${threads.length} unique threads.`);
  }
}

if (require.main === module) {
  main();
}
