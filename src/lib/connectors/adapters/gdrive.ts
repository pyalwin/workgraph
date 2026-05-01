import type { MCPConnector } from '../types';
import type { WorkItemInput } from '../../sync/types';
import { resolveSince, BACKFILL_DEFAULT_DATE } from '../defaults';

export const gdriveConnector: MCPConnector = {
  source: 'gdrive',
  label: 'Google Drive',
  serverId: 'gdrive',
  itemType: 'document',
  requiredEnv: ['MCP_GDRIVE_URL'],

  list: {
    tool: 'search',
    args: (ctx) => {
      const r = resolveSince(ctx.options, ctx.since ?? undefined, BACKFILL_DEFAULT_DATE);
      const query = process.env.MCP_GDRIVE_QUERY
        || (r.allTime ? `trashed = false` : `modifiedTime > '${r.date}T00:00:00Z'`);
      return {
        query,
        pageSize: ctx.limit,
        pageToken: ctx.cursor ?? undefined,
      };
    },
    extractItems: (resp: any) => resp?.files ?? resp?.results ?? [],
    extractCursor: (resp: any) => resp?.nextPageToken ?? null,
  },

  detail: {
    tool: 'fetch',
    args: (raw: any) => ({ file_id: raw.id, fileId: raw.id }),
    merge: (raw: any, detail: any) => ({
      ...raw,
      body: detail?.content || detail?.text || detail?.body,
    }),
  },

  toItem: (raw: any): WorkItemInput | null => {
    if (!raw?.id) return null;
    const mime: string = raw.mimeType || '';
    const itemType = mime.includes('document') ? 'doc'
      : mime.includes('spreadsheet') ? 'sheet'
      : mime.includes('presentation') ? 'slides'
      : mime.includes('folder') ? 'folder'
      : 'file';
    return {
      source: 'gdrive',
      source_id: raw.id,
      item_type: itemType,
      title: raw.name || 'Untitled',
      body: raw.body || raw.snippet || null,
      author: raw.lastModifyingUser?.displayName || raw.owners?.[0]?.displayName || null,
      status: raw.trashed ? 'archived' : 'published',
      priority: null,
      url: raw.webViewLink || raw.url || null,
      metadata: {
        mime_type: mime,
        size: raw.size || null,
        owners: raw.owners?.map((o: any) => o.emailAddress) || [],
        parents: raw.parents || [],
        starred: raw.starred ?? false,
      },
      created_at: raw.createdTime || new Date().toISOString(),
      updated_at: raw.modifiedTime || null,
    };
  },
};
