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
  const issues = JSON.parse(raw);

  const items: WorkItemInput[] = issues.map((issue: any) => ({
    source: 'jira',
    source_id: issue.key,
    item_type: issue.fields?.issuetype?.name?.toLowerCase() || 'task',
    title: issue.fields?.summary || issue.key,
    body: issue.fields?.description || null,
    author: issue.fields?.assignee?.displayName || issue.fields?.reporter?.displayName || null,
    status: issue.fields?.status?.name?.toLowerCase().replace(/\s+/g, '_') || null,
    priority: issue.fields?.priority?.name?.toLowerCase() || null,
    url: `https://${issue.self?.split('/rest/')[0]?.split('//')[1] || 'jira'}/browse/${issue.key}`,
    metadata: {
      labels: issue.fields?.labels || [],
      components: issue.fields?.components?.map((c: any) => c.name) || [],
      sprint: issue.fields?.sprint?.name || null,
      reporter: issue.fields?.reporter?.displayName || null,
      project: issue.fields?.project?.key || null,
      resolution: issue.fields?.resolution?.name || null,
    },
    created_at: issue.fields?.created || new Date().toISOString(),
    updated_at: issue.fields?.updated || null,
  }));

  const result = ingestItems(items);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Jira sync failed:', err.message);
  process.exit(1);
});
