import type { MCPConnector } from '../types';
import type { WorkItemInput } from '../../sync/types';

export const slackConnector: MCPConnector = {
  source: 'slack',
  label: 'Slack',
  serverId: 'slack',
  itemType: 'message',

  list: {
    tool: 'slack_get_channel_history',
    args: (ctx) => ({
      channel_id: process.env.MCP_SLACK_CHANNEL_ID || '',
      limit: ctx.limit,
      cursor: ctx.cursor ?? undefined,
      oldest: ctx.since ? Math.floor(new Date(ctx.since).getTime() / 1000).toString() : undefined,
    }),
    extractItems: (resp: any) => resp?.messages ?? [],
    extractCursor: (resp: any) => resp?.response_metadata?.next_cursor ?? null,
  },

  toItem: (raw: any): WorkItemInput | null => {
    if (!raw?.ts) return null;
    const channel = process.env.MCP_SLACK_CHANNEL_ID || 'unknown';
    const team = process.env.MCP_SLACK_TEAM_ID;
    const url = team
      ? `https://app.slack.com/client/${team}/${channel}/p${raw.ts.replace('.', '')}`
      : null;
    return {
      source: 'slack',
      source_id: `${channel}:${raw.ts}`,
      item_type: raw.thread_ts && raw.thread_ts !== raw.ts ? 'thread_reply' : 'message',
      title: (raw.text || '').slice(0, 80) || `Message ${raw.ts}`,
      body: raw.text || null,
      author: raw.user || raw.username || null,
      status: 'sent',
      priority: null,
      url,
      metadata: {
        channel,
        thread_ts: raw.thread_ts || null,
        reactions: (raw.reactions || []).map((r: any) => r.name),
        reply_count: raw.reply_count ?? 0,
        files: (raw.files || []).map((f: any) => f.name),
      },
      created_at: new Date(Number(raw.ts.split('.')[0]) * 1000).toISOString(),
      updated_at: raw.edited?.ts ? new Date(Number(raw.edited.ts.split('.')[0]) * 1000).toISOString() : null,
    };
  },
};
