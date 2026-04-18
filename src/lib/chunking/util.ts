export type ChunkType =
  | 'notion_section'
  | 'notion_summary'
  | 'jira_body'
  | 'jira_comment'
  | 'slack_message'
  | 'slack_thread_agg'
  | 'pr_desc'
  | 'pr_diff_summary'
  | 'commit'
  | 'pr_patch'
  | 'meeting_note'
  | 'generic';

export interface ChunkInput {
  chunk_type: ChunkType;
  chunk_text: string;
  position: number;
  token_count?: number;
  metadata?: Record<string, unknown>;
}

export interface WorkItemForChunking {
  id: string;
  source: string;
  source_id: string;
  item_type: string;
  title: string;
  body: string | null;
  author: string | null;
  url: string | null;
  metadata: string | null;
  created_at: string;
}

const STOPWORDS = new Set([
  'the','a','an','of','to','in','on','at','for','is','are','and','or','but','not',
  'this','that','with','as','it','be','by','from','we','you','i','they','he','she',
]);

export function passesMinimum(text: string | null | undefined): boolean {
  if (!text) return false;
  if (text.length < 30) return false;
  const words = text
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
  return words.length >= 5;
}

export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function parseMetadata(m: string | null | undefined): Record<string, unknown> | null {
  if (!m) return null;
  try {
    return JSON.parse(m);
  } catch {
    return null;
  }
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}
