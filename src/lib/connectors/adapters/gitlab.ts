import type { MCPConnector } from '../types';
import type { WorkItemInput } from '../../sync/types';

const STATUS_MAP: Record<string, string> = {
  opened: 'open', closed: 'done', merged: 'done', locked: 'done',
};

export const gitlabConnector: MCPConnector = {
  source: 'gitlab',
  label: 'GitLab',
  serverId: 'gitlab',
  itemType: 'issue',

  list: {
    tool: 'list_issues',
    args: (ctx) => ({
      project_id: process.env.MCP_GITLAB_PROJECT_ID || undefined,
      group_id: process.env.MCP_GITLAB_GROUP_ID || undefined,
      updated_after: ctx.since || undefined,
      per_page: ctx.limit,
      page: ctx.cursor ? Number(ctx.cursor) : 1,
      scope: 'all',
    }),
    extractItems: (resp: any) => resp?.issues ?? resp?.items ?? (Array.isArray(resp) ? resp : []),
    extractCursor: (resp: any) => {
      const items = resp?.issues ?? resp?.items ?? (Array.isArray(resp) ? resp : []);
      if (items.length === 0) return null;
      return String(Number(resp?._page ?? 1) + 1);
    },
  },

  toItem: (raw: any): WorkItemInput | null => {
    if (!raw?.id) return null;
    const isMR = raw.iid != null && (raw.target_branch || raw.merge_status);
    return {
      source: 'gitlab',
      source_id: `${raw.project_id || 'unknown'}#${raw.iid || raw.id}`,
      item_type: isMR ? 'merge_request' : 'issue',
      title: raw.title || `#${raw.iid}`,
      body: raw.description || null,
      author: raw.assignee?.name || raw.author?.name || null,
      status: STATUS_MAP[raw.state] || 'open',
      priority: null,
      url: raw.web_url || null,
      metadata: {
        project_id: raw.project_id,
        labels: raw.labels || [],
        milestone: raw.milestone?.title || null,
        weight: raw.weight ?? null,
      },
      created_at: raw.created_at || new Date().toISOString(),
      updated_at: raw.updated_at || null,
    };
  },
};
