import type { MCPConnector } from '../types';
import type { WorkItemInput } from '../../sync/types';
import { resolveSince, BACKFILL_DEFAULT_DATE } from '../defaults';

const baseUrl = () =>
  process.env.MCP_CONFLUENCE_BASE_URL
  || process.env.MCP_ATLASSIAN_BASE_URL
  || 'https://your-org.atlassian.net/wiki';

export const confluenceConnector: MCPConnector = {
  source: 'confluence',
  label: 'Confluence',
  serverId: 'confluence',
  itemType: 'page',

  list: {
    tool: 'searchConfluencePagesUsingCQL',
    args: (ctx) => {
      const r = resolveSince(ctx.options, ctx.since ?? undefined, BACKFILL_DEFAULT_DATE);
      const space = process.env.MCP_CONFLUENCE_SPACE;
      const spaceClause = space ? ` AND space = "${space}"` : '';
      const cql = r.allTime
        ? `type = page${spaceClause}`
        : `type = page${spaceClause} AND lastmodified >= "${r.date}"`;
      return {
        cloudId: process.env.MCP_ATLASSIAN_CLOUD_ID || process.env.MCP_CONFLUENCE_CLOUD_ID || '',
        cql,
        limit: ctx.limit,
        nextPageToken: ctx.cursor ?? undefined,
      };
    },
    extractItems: (resp: any) => resp?.results ?? resp?.pages ?? [],
    extractCursor: (resp: any) => resp?.nextPageToken ?? resp?._links?.next ?? null,
  },

  detail: {
    tool: 'getConfluencePage',
    args: (raw: any) => ({
      cloudId: process.env.MCP_ATLASSIAN_CLOUD_ID || '',
      pageId: raw.id,
      bodyFormat: 'view',
    }),
    merge: (raw: any, detail: any) => ({
      ...raw,
      body: detail?.body?.view?.value || detail?.body?.storage?.value || raw.body,
      version: detail?.version,
    }),
  },

  toItem: (raw: any): WorkItemInput | null => {
    if (!raw?.id) return null;
    const stripped = typeof raw.body === 'string' ? raw.body.replace(/<[^>]*>/g, '') : null;
    return {
      source: 'confluence',
      source_id: String(raw.id),
      item_type: 'page',
      title: raw.title || 'Untitled',
      body: stripped,
      author: raw.version?.by?.displayName || raw.history?.createdBy?.displayName || null,
      status: raw.status || 'published',
      priority: null,
      url: raw._links?.webui ? `${baseUrl()}${raw._links.webui}` : raw.url || null,
      metadata: {
        space: raw.space?.key || raw.spaceId || null,
        version: raw.version?.number ?? null,
        labels: (raw.metadata?.labels?.results || []).map((l: any) => l.name),
      },
      created_at: raw.history?.createdDate || raw.createdAt || new Date().toISOString(),
      updated_at: raw.version?.when || raw.lastModified || null,
    };
  },
};
