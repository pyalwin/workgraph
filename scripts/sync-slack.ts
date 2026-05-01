import { ingestItems } from '../src/lib/sync/ingest';
import type { WorkItemInput } from '../src/lib/sync/types';

/**
 * Accepts Slack input from stdin as a JSON array of either:
 *   - type='thread'   : { type: 'thread', channel_id, channel_name?, thread_ts, messages: [...], permalink? }
 *   - type='message'  : { type: 'message', channel_id, channel_name?, ts, user, user_name, text, permalink? }
 *   - legacy          : a plain message object (treated as standalone message)
 *
 * A thread collapses to ONE work_item — the conversation is the unit of meaning.
 * Body is the concatenated thread with "**user** (timestamp): text\n" blocks.
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

interface SlackMessage {
  ts: string;
  user?: string;
  user_name?: string;
  username?: string;
  text?: string;
  edited?: { ts?: string };
  reactions?: any[];
  reply_count?: number;
  thread_ts?: string;
}

interface ThreadInput {
  type: 'thread';
  channel_id: string;
  channel_name?: string;
  thread_ts: string;
  messages: SlackMessage[];
  permalink?: string;
}

interface MessageInput {
  type?: 'message';
  channel_id?: string;
  channel?: string;
  channel_name?: string;
  ts: string;
  user?: string;
  user_name?: string;
  text?: string;
  edited?: any;
  permalink?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: any[];
}

function tsToIso(ts: string): string {
  const n = parseFloat(ts);
  if (!isFinite(n)) return new Date().toISOString();
  return new Date(n * 1000).toISOString();
}

function authorName(m: SlackMessage): string {
  return m.user_name || m.username || m.user || 'unknown';
}

function formatThreadBody(messages: SlackMessage[]): string {
  const sorted = [...messages].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  return sorted
    .map(m => `**${authorName(m)}** (${tsToIso(m.ts)}):\n${m.text || ''}`)
    .join('\n\n');
}

function mapThread(thread: ThreadInput): WorkItemInput | null {
  const msgs = thread.messages || [];
  if (msgs.length === 0) return null;

  const rootMessage = msgs.find(m => m.ts === thread.thread_ts) || msgs[0];
  const title = (rootMessage.text || 'Slack thread').slice(0, 200);
  const body = formatThreadBody(msgs);
  const earliestTs = msgs.reduce((a, b) => (parseFloat(a.ts) < parseFloat(b.ts) ? a : b));
  const latestTs = msgs.reduce((a, b) => (parseFloat(a.ts) > parseFloat(b.ts) ? a : b));

  return {
    source: 'slack',
    source_id: `${thread.channel_id}:thread:${thread.thread_ts}`,
    item_type: 'thread',
    title,
    body,
    author: authorName(rootMessage),
    status: 'posted',
    priority: null,
    url: thread.permalink || null,
    metadata: {
      channel_name: thread.channel_name || null,
      channel_id: thread.channel_id,
      thread_ts: thread.thread_ts,
      message_count: msgs.length,
      participants: [...new Set(msgs.map(authorName))],
    },
    created_at: tsToIso(earliestTs.ts),
    updated_at: tsToIso(latestTs.ts),
  };
}

function mapMessage(msg: MessageInput): WorkItemInput | null {
  if (!msg.ts) return null;
  const channelId = msg.channel_id || msg.channel || 'unknown';

  return {
    source: 'slack',
    source_id: `${channelId}:${msg.ts}`,
    item_type: msg.thread_ts && msg.thread_ts !== msg.ts ? 'thread_reply' : 'message',
    title: (msg.text || '').slice(0, 200),
    body: msg.text || null,
    author: msg.user_name || msg.user || null,
    status: 'posted',
    priority: null,
    url: msg.permalink || null,
    metadata: {
      channel_name: msg.channel_name || null,
      channel_id: channelId,
      thread_ts: msg.thread_ts || null,
      reply_count: msg.reply_count || 0,
      reaction_count: Array.isArray(msg.reactions) ? msg.reactions.length : 0,
    },
    created_at: tsToIso(msg.ts),
    updated_at: msg.edited?.ts ? tsToIso(msg.edited.ts) : null,
  };
}

async function main() {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const items: WorkItemInput[] = [];
  for (const entry of input) {
    if (entry?.type === 'thread') {
      const item = mapThread(entry);
      if (item) items.push(item);
    } else {
      const item = mapMessage(entry);
      if (item) items.push(item);
    }
  }

  const result = ingestItems(items);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Slack sync failed:', err.message);
  process.exit(1);
});
