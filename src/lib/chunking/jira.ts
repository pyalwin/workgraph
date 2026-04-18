import type { ChunkInput, WorkItemForChunking } from './util';
import { approxTokens, passesMinimum, parseMetadata } from './util';

export function chunkJira(item: WorkItemForChunking): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  const bodyText = [item.title, item.body].filter(Boolean).join('\n\n');
  if (passesMinimum(bodyText)) {
    chunks.push({
      chunk_type: 'jira_body',
      chunk_text: bodyText,
      position: 0,
      token_count: approxTokens(bodyText),
    });
  }

  const metadata = parseMetadata(item.metadata);
  const comments = (metadata?.comments as Array<{ id?: string; body?: string; author?: string }>) || [];
  comments.forEach((c, i) => {
    const text = c.body || '';
    if (!passesMinimum(text)) return;
    chunks.push({
      chunk_type: 'jira_comment',
      chunk_text: text,
      position: i + 1,
      token_count: approxTokens(text),
      metadata: { comment_id: c.id ?? null, author: c.author ?? null },
    });
  });

  return chunks;
}
