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
  const pages = JSON.parse(raw);

  const items: WorkItemInput[] = pages.map((page: any) => ({
    source: 'notion',
    source_id: page.id,
    item_type: page.object === 'database' ? 'database' : 'page',
    title: page.title || page.properties?.Name?.title?.[0]?.plain_text || page.properties?.title?.title?.[0]?.plain_text || 'Untitled',
    body: page.content || page.description || null,
    author: page.last_edited_by?.name || page.created_by?.name || null,
    status: 'published',
    priority: null,
    url: page.url || null,
    metadata: {
      parent_database: page.parent?.database_id || null,
      last_edited_time: page.last_edited_time || null,
      properties: page.properties ? Object.keys(page.properties) : [],
    },
    created_at: page.created_time || new Date().toISOString(),
    updated_at: page.last_edited_time || null,
  }));

  const result = ingestItems(items);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Notion sync failed:', err.message);
  process.exit(1);
});
