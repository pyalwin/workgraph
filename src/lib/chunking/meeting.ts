import type { ChunkInput, WorkItemForChunking } from './util';
import { approxTokens, passesMinimum } from './util';

export function chunkMeeting(item: WorkItemForChunking): ChunkInput[] {
  const text = [item.title, item.body].filter(Boolean).join('\n\n');
  if (!passesMinimum(text)) return [];
  return [{
    chunk_type: 'meeting_note',
    chunk_text: text,
    position: 0,
    token_count: approxTokens(text),
  }];
}
