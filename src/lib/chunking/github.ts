import type { ChunkInput, WorkItemForChunking } from './util';
import { approxTokens, passesMinimum, parseMetadata } from './util';

export function chunkGithub(item: WorkItemForChunking): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  const metadata = parseMetadata(item.metadata);

  const isCommit = item.item_type === 'commit';
  const primaryType = isCommit ? 'commit' : 'pr_desc';

  const descText = [item.title, item.body].filter(Boolean).join('\n\n');
  if (passesMinimum(descText)) {
    chunks.push({
      chunk_type: primaryType,
      chunk_text: descText,
      position: 0,
      token_count: approxTokens(descText),
      metadata: {
        repo: metadata?.repo ?? null,
        pr_number: metadata?.pr_number ?? null,
        sha: metadata?.sha ?? null,
        branch: metadata?.branch ?? null,
        jira_key: metadata?.jira_key ?? null,
      },
    });
  }

  // Sonnet-generated semantic diff summary — populated by code-enrich
  const diffSummary = metadata?.diff_summary as string | undefined;
  if (diffSummary && passesMinimum(diffSummary)) {
    chunks.push({
      chunk_type: 'pr_diff_summary',
      chunk_text: diffSummary,
      position: chunks.length,
      token_count: approxTokens(diffSummary),
      metadata: { source: 'sonnet' },
    });
  }

  // Per-commit entries for PR (once patch-ingestion populates metadata.commits)
  const commits = (metadata?.commits as Array<{ sha?: string; message?: string; summary?: string }>) || [];
  if (!isCommit) {
    commits.forEach((c, i) => {
      const text = [c.message, c.summary].filter(Boolean).join('\n\n');
      if (!passesMinimum(text)) return;
      chunks.push({
        chunk_type: 'commit',
        chunk_text: text,
        position: chunks.length,
        token_count: approxTokens(text),
        metadata: { sha: c.sha ?? null },
      });
    });
  }

  return chunks;
}
