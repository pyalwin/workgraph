/**
 * Assemble per-item fetched JSON files into the arrays that sync-*.ts scripts expect.
 *
 * Inputs (written by bulk-fetcher subagents):
 *   /tmp/workgraph-sync/jira/<KEY>.json      — one file per issue (nodes[0] shape)
 *   /tmp/workgraph-sync/granola/<UUID>.json  — {id, title, transcript}
 *   /tmp/workgraph-sync/slack/page-*.json    — slack search responses w/ messages
 *
 * Also reads the raw Granola list file (saved by MCP) for participants + date metadata.
 *
 * Outputs:
 *   /tmp/workgraph-sync/jira-issues.json     — array ready for sync-jira.ts
 *   /tmp/workgraph-sync/granola-meetings.json — array ready for sync-meetings.ts
 *   /tmp/workgraph-sync/slack-messages.json  — array ready for sync-slack.ts
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import path from 'path';
import { parseSlackMarkdown, parseAllPages, parseThreadMarkdown } from './slack-parse-pages';

const SYNC_DIR = '/tmp/workgraph-sync';

function assembleJira(): number {
  const jiraDir = path.join(SYNC_DIR, 'jira');
  if (!existsSync(jiraDir)) { console.error('  jira/ missing'); return 0; }

  const files = readdirSync(jiraDir).filter(f => f.endsWith('.json'));
  const issues: any[] = [];

  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(path.join(jiraDir, f), 'utf-8'));
      // Subagent may have written either the unwrapped issue or the wrapper
      const issue = raw?.issues?.nodes?.[0] || raw;
      if (issue?.key) issues.push(issue);
    } catch (err: any) {
      console.error(`  bad jira file ${f}: ${err.message}`);
    }
  }

  const out = path.join(SYNC_DIR, 'jira-issues.json');
  writeFileSync(out, JSON.stringify(issues, null, 0));
  console.log(`  jira: ${issues.length} issues → ${out}`);
  return issues.length;
}

interface MeetingMeta {
  id: string;
  title: string;
  date: string | null;
  participants: string[];
  url: string | null;
}

function parseMeetingMeta(xmlText: string): Map<string, MeetingMeta> {
  const meta = new Map<string, MeetingMeta>();
  const meetingBlockRe = /<meeting id="([a-f0-9-]+)" title="([^"]*)" date="([^"]*)">([\s\S]*?)<\/meeting>/g;
  let m: RegExpExecArray | null;
  while ((m = meetingBlockRe.exec(xmlText)) !== null) {
    const [, id, title, date, inner] = m;
    const participantsRe = /<known_participants>([\s\S]*?)<\/known_participants>/;
    const pMatch = inner.match(participantsRe);
    const participants = pMatch
      ? pMatch[1]
          .split(',')
          .map(s => s.trim().replace(/\s*<[^>]+>\s*$/, '').replace(/\s+from\s+[^<]+$/, ''))
          .filter(Boolean)
      : [];
    meta.set(id, { id, title, date, participants, url: null });
  }
  return meta;
}

function assembleGranola(listMetaPath?: string): number {
  const granolaDir = path.join(SYNC_DIR, 'granola');
  if (!existsSync(granolaDir)) { console.error('  granola/ missing'); return 0; }

  let meta = new Map<string, MeetingMeta>();
  if (listMetaPath && existsSync(listMetaPath)) {
    const xml = readFileSync(listMetaPath, 'utf-8');
    meta = parseMeetingMeta(xml);
    console.log(`  granola: parsed ${meta.size} meeting metadata records from list file`);
  }

  const files = readdirSync(granolaDir).filter(f => f.endsWith('.json'));
  const meetings: any[] = [];

  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(path.join(granolaDir, f), 'utf-8'));
      const id = raw.id || f.replace(/\.json$/, '');
      const m = meta.get(id);
      meetings.push({
        id,
        title: raw.title || m?.title || 'Untitled Meeting',
        date: m?.date || null,
        participants: m?.participants || [],
        transcript: raw.transcript || null,
        summary: raw.summary || null,
        notes: raw.notes || null,
        url: m?.url || raw.url || null,
      });
    } catch (err: any) {
      console.error(`  bad granola file ${f}: ${err.message}`);
    }
  }

  const out = path.join(SYNC_DIR, 'granola-meetings.json');
  writeFileSync(out, JSON.stringify(meetings, null, 0));
  console.log(`  granola: ${meetings.length} meetings → ${out}`);
  return meetings.length;
}

function assembleSlack(): number {
  const slackDir = path.join(SYNC_DIR, 'slack');
  if (!existsSync(slackDir)) { console.error('  slack/ missing'); return 0; }

  // Page files contain markdown-formatted search results. Use the parser.
  const seedMessages = parseAllPages(slackDir);

  // Read enriched thread files (one per unique channel+thread_ts), if present.
  // File name pattern: thread-<channel_id>-<thread_ts>.json
  // Contents may be structured JSON OR a markdown string from slack_read_thread.
  // Exclude thread-list.json (the seed list, not a thread).
  const threadFiles = readdirSync(slackDir).filter(
    f => /^thread-(C|D|G)[A-Z0-9]+-[\d.]+\.json$/.test(f),
  );
  const enrichedThreads = new Map<string, any>();  // key = channel_id:thread_ts

  for (const f of threadFiles) {
    try {
      const raw = JSON.parse(readFileSync(path.join(slackDir, f), 'utf-8'));

      // Parse filename: thread-<channel_id>-<thread_ts>.json
      const fnameMatch = f.match(/^thread-(C[A-Z0-9]+|D[A-Z0-9]+|G[A-Z0-9]+)-([\d.]+)\.json$/);
      const channelIdFromName = fnameMatch?.[1] || '';
      const threadTsFromName = fnameMatch?.[2] || '';

      // Try multiple shapes the MCP tool might return
      let messages: any[] = [];
      if (Array.isArray(raw.messages)) {
        messages = raw.messages;
      } else if (Array.isArray(raw.results)) {
        messages = raw.results;
      } else if (Array.isArray(raw)) {
        messages = raw;
      } else if (typeof raw.messages === 'string') {
        // NEW: subagent wrote markdown thread content in raw.messages
        messages = parseThreadMarkdown(raw.messages);
      } else if (typeof raw.results === 'string') {
        messages = parseThreadMarkdown(raw.results);
      } else if (typeof raw === 'string') {
        messages = parseThreadMarkdown(raw);
      }

      const channelId = raw.channel_id || raw.channel || channelIdFromName;
      const threadTs = raw.thread_ts || threadTsFromName || messages[0]?.thread_ts || messages[0]?.ts;

      if (channelId && threadTs && messages.length > 0) {
        enrichedThreads.set(`${channelId}:${threadTs}`, {
          type: 'thread',
          channel_id: channelId,
          channel_name: raw.channel_name || messages[0]?.channel_name || null,
          thread_ts: threadTs,
          messages,
          permalink: raw.permalink || messages[0]?.permalink || null,
        });
      } else {
        console.error(`  thread file ${f}: could not identify channel_id/thread_ts or no messages`);
      }
    } catch (err: any) {
      console.error(`  bad slack thread ${f}: ${err.message}`);
    }
  }

  // Classify seed messages: threaded vs standalone.
  const assembled: any[] = [];
  const processedThreads = new Set<string>();

  for (const m of seedMessages) {
    const channelId = m.channel_id || '';
    const threadTs = m.thread_ts || null;

    if (threadTs) {
      const key = `${channelId}:${threadTs}`;
      if (processedThreads.has(key)) continue;
      processedThreads.add(key);

      const enriched = enrichedThreads.get(key);
      if (enriched) {
        assembled.push(enriched);
      } else {
        // No enriched thread file — include just this message under thread_ts as fallback.
        assembled.push({
          type: 'thread',
          channel_id: channelId,
          channel_name: m.channel_name || null,
          thread_ts: threadTs,
          messages: [m],
          permalink: m.permalink || null,
        });
      }
    } else {
      assembled.push({ type: 'message', ...m });
    }
  }

  // Also include any enriched threads whose seed message might have been filtered upstream.
  for (const [key, thr] of enrichedThreads) {
    if (!processedThreads.has(key)) {
      assembled.push(thr);
      processedThreads.add(key);
    }
  }

  const out = path.join(SYNC_DIR, 'slack-messages.json');
  writeFileSync(out, JSON.stringify(assembled, null, 0));
  const threadCount = assembled.filter(a => a.type === 'thread').length;
  const msgCount = assembled.filter(a => a.type === 'message').length;
  console.log(`  slack: ${threadCount} threads + ${msgCount} standalone messages → ${out}`);
  return assembled.length;
}

function main() {
  const granolaListArg = process.argv.find(a => a.startsWith('--granola-list='));
  const granolaList = granolaListArg ? granolaListArg.split('=')[1] : undefined;

  console.log('Assembling reingest inputs...\n');
  const j = assembleJira();
  console.log();
  const g = assembleGranola(granolaList);
  console.log();
  const s = assembleSlack();
  console.log(`\nDone: ${j} jira, ${g} granola, ${s} slack.`);
}

if (require.main === module) {
  main();
}
