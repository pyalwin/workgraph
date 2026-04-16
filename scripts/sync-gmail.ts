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
  const threads = JSON.parse(raw);

  const items: WorkItemInput[] = threads.map((thread: any) => ({
    source: 'gmail',
    source_id: thread.id || thread.threadId,
    item_type: 'email_thread',
    title: thread.subject || thread.snippet?.slice(0, 120) || 'No subject',
    body: thread.snippet || thread.body || null,
    author: thread.from || thread.sender || null,
    status: thread.labelIds?.includes('SENT') ? 'sent' : 'received',
    priority: thread.labelIds?.includes('IMPORTANT') ? 'high' : null,
    url: thread.threadId ? `https://mail.google.com/mail/u/0/#inbox/${thread.threadId}` : null,
    metadata: {
      labels: thread.labelIds || [],
      message_count: thread.messagesCount || thread.messages?.length || 1,
      participants: thread.participants || [],
      to: thread.to || null,
    },
    created_at: thread.date || thread.internalDate ? new Date(parseInt(thread.internalDate)).toISOString() : new Date().toISOString(),
    updated_at: thread.lastMessageDate || null,
  }));

  const result = ingestItems(items);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Gmail sync failed:', err.message);
  process.exit(1);
});
