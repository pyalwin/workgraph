import { ingestItems } from '../src/lib/sync/ingest';
import type { WorkItemInput } from '../src/lib/sync/types';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const raw = await readStdin();
  const messages = JSON.parse(raw);

  const items: WorkItemInput[] = messages.map((msg: any) => ({
    source: 'slack',
    source_id: `${msg.channel_id || msg.channel}:${msg.ts}`,
    item_type: msg.thread_ts && msg.thread_ts !== msg.ts ? 'thread_reply' : msg.thread_ts ? 'thread' : 'message',
    title: (msg.text || '').slice(0, 200),
    body: msg.text || null,
    author: msg.user_name || msg.user || null,
    status: 'posted',
    priority: null,
    url: msg.permalink || null,
    metadata: {
      channel_name: msg.channel_name || msg.channel || null,
      channel_id: msg.channel_id || null,
      thread_ts: msg.thread_ts || null,
      reply_count: msg.reply_count || 0,
      reaction_count: msg.reactions?.length || 0,
    },
    created_at: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : new Date().toISOString(),
    updated_at: msg.edited?.ts ? new Date(parseFloat(msg.edited.ts) * 1000).toISOString() : null,
  }));

  const result = ingestItems(items);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Slack sync failed:', err.message);
  process.exit(1);
});
