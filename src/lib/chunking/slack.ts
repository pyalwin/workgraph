import type { ChunkInput, WorkItemForChunking } from './util';
import { approxTokens, passesMinimum, parseMetadata } from './util';

export function chunkSlack(item: WorkItemForChunking): ChunkInput[] {
  const metadata = parseMetadata(item.metadata);
  const replies = (metadata?.replies as Array<{ ts?: string; text?: string; author?: string }>) || [];

  // Single-message path (current behavior: each message is its own work_item)
  if (replies.length === 0) {
    const text = item.body || item.title;
    if (!passesMinimum(text)) return [];
    return [{
      chunk_type: 'slack_message',
      chunk_text: text,
      position: 0,
      token_count: approxTokens(text),
    }];
  }

  // Thread path (future, once ingestion extension is live)
  const chunks: ChunkInput[] = [];
  const rootText = item.body || item.title || '';
  if (passesMinimum(rootText)) {
    chunks.push({
      chunk_type: 'slack_message',
      chunk_text: rootText,
      position: 0,
      token_count: approxTokens(rootText),
      metadata: { role: 'root', author: item.author },
    });
  }
  replies.forEach((r, i) => {
    const text = r.text || '';
    if (!passesMinimum(text)) return;
    chunks.push({
      chunk_type: 'slack_message',
      chunk_text: text,
      position: i + 1,
      token_count: approxTokens(text),
      metadata: { role: 'reply', ts: r.ts ?? null, author: r.author ?? null },
    });
  });

  // Thread aggregate: join root + replies into one chunk for coarse matching
  if (chunks.length >= 2) {
    const joined = [rootText, ...replies.map(r => r.text || '').filter(Boolean)].join('\n---\n');
    if (passesMinimum(joined)) {
      chunks.push({
        chunk_type: 'slack_thread_agg',
        chunk_text: joined.slice(0, 6000),
        position: chunks.length,
        token_count: approxTokens(joined),
        metadata: { reply_count: replies.length },
      });
    }
  }

  return chunks;
}
