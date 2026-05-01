import { ingestItems } from '../src/lib/sync/ingest';
import type { WorkItemInput } from '../src/lib/sync/types';

// Normalize Jira statuses to: done | active | open | backlog
const STATUS_MAP: Record<string, string> = {
  'done': 'done',
  'closed': 'done',
  'resolved': 'done',
  'production': 'done',
  'merged': 'done',
  'will_not_do': 'done',
  'not_doing': 'done',
  'won\'t_do': 'done',
  'cancelled': 'done',
  'duplicate': 'done',
  'in_progress': 'active',
  'in_development': 'active',
  'in_review': 'active',
  'qa': 'active',
  'testing': 'active',
  'code_review': 'active',
  'to_do': 'open',
  'open': 'open',
  'new': 'open',
  'backlog': 'backlog',
  'icebox': 'backlog',
};

function normalizeStatus(raw: string | null): string {
  if (!raw) return 'open';
  const key = raw.toLowerCase().replace(/\s+/g, '_');
  return STATUS_MAP[key] || 'open';
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const raw = await readStdin();
  const issues = JSON.parse(raw);

  const items: WorkItemInput[] = issues.map((issue: any) => {
    const description = typeof issue.fields?.description === 'string' ? issue.fields.description : '';
    const comments: any[] = issue.fields?.comment?.comments || issue.fields?.comments || [];
    const commentsText = comments.length > 0
      ? '\n\n---\n**Comments:**\n\n' + comments.map((c: any) => {
          const author = c.author?.displayName || c.updateAuthor?.displayName || 'Unknown';
          const created = c.created || '';
          const cBody = typeof c.body === 'string' ? c.body : '';
          return `**${author}** (${created}):\n${cBody}\n`;
        }).join('\n')
      : '';
    const body = (description + commentsText) || null;

    return {
      source: 'jira',
      source_id: issue.key,
      item_type: issue.fields?.issuetype?.name?.toLowerCase() || 'task',
      title: issue.fields?.summary || issue.key,
      body,
      author: issue.fields?.assignee?.displayName || issue.fields?.reporter?.displayName || null,
      status: normalizeStatus(issue.fields?.status?.name),
      priority: issue.fields?.priority?.name?.toLowerCase() || null,
      url: `https://plateiq.atlassian.net/browse/${issue.key}`,
      metadata: {
        labels: issue.fields?.labels || [],
        components: issue.fields?.components?.map((c: any) => c.name) || [],
        sprint: issue.fields?.sprint?.name || null,
        reporter: issue.fields?.reporter?.displayName || null,
        project: issue.fields?.project?.key || null,
        resolution: issue.fields?.resolution?.name || null,
        comment_count: comments.length,
      },
      created_at: issue.fields?.created || new Date().toISOString(),
      updated_at: issue.fields?.updated || null,
    };
  });

  const result = ingestItems(items);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Jira sync failed:', err.message);
  process.exit(1);
});
