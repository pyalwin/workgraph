import type { MCPConnector } from '../types';
import type { WorkItemInput } from '../../sync/types';

function extractTitle(raw: any): string {
  if (typeof raw.title === 'string') return raw.title;
  const titleProp = raw.properties?.title || raw.properties?.Name || raw.properties?.name;
  if (Array.isArray(titleProp?.title)) {
    return titleProp.title.map((t: any) => t?.plain_text ?? '').join('').trim() || 'Untitled';
  }
  return raw.name || raw.plain_text || 'Untitled';
}

export const notionConnector: MCPConnector = {
  source: 'notion',
  label: 'Notion',
  serverId: 'notion',
  itemType: 'page',
  requiredEnv: ['MCP_NOTION_URL'],

  list: {
    tool: 'notion-search',
    args: (ctx) => ({
      query: process.env.MCP_NOTION_QUERY || '',
      query_type: 'internal',
      filters: { include: ['page', 'database'] },
      page_size: ctx.limit,
      start_cursor: ctx.cursor ?? undefined,
    }),
    extractItems: (resp: any) => resp?.results ?? resp?.pages ?? [],
    extractCursor: (resp: any) => resp?.next_cursor ?? null,
  },

  detail: {
    tool: 'notion-fetch',
    args: (raw: any) => ({ id: raw.id, urls: raw.url ? [raw.url] : undefined }),
    merge: (raw: any, detail: any) => ({ ...raw, ...detail, body: detail?.content || detail?.markdown || raw.content }),
  },

  toItem: (raw: any): WorkItemInput | null => {
    if (!raw?.id) return null;
    const isDatabase = raw.object === 'database' || raw.parent?.type === 'workspace';
    return {
      source: 'notion',
      source_id: raw.id,
      item_type: isDatabase ? 'database' : 'page',
      title: extractTitle(raw),
      body: raw.body || raw.content || raw.markdown || raw.description || null,
      author: raw.last_edited_by?.name || raw.created_by?.name || null,
      status: 'published',
      priority: null,
      url: raw.url || null,
      metadata: {
        parent_database: raw.parent?.database_id || null,
        parent_page: raw.parent?.page_id || null,
        last_edited_time: raw.last_edited_time || null,
        properties: raw.properties ? Object.keys(raw.properties) : [],
      },
      created_at: raw.created_time || new Date().toISOString(),
      updated_at: raw.last_edited_time || null,
    };
  },
};
