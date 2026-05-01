import type { MCPConnector } from '../types';
import type { WorkItemInput } from '../../sync/types';

// Microsoft Teams MCP servers vary; this adapter targets the common pattern of
// list_messages-style tools that return Graph API message objects.
export const teamsConnector: MCPConnector = {
  source: 'teams',
  label: 'Microsoft Teams',
  serverId: 'teams',
  itemType: 'message',

  list: {
    tool: 'list_channel_messages',
    args: (ctx) => ({
      team_id: process.env.MCP_TEAMS_TEAM_ID || '',
      channel_id: process.env.MCP_TEAMS_CHANNEL_ID || '',
      top: ctx.limit,
      skipToken: ctx.cursor ?? undefined,
      filter: ctx.since ? `lastModifiedDateTime ge ${ctx.since}` : undefined,
    }),
    extractItems: (resp: any) => resp?.value ?? resp?.messages ?? [],
    extractCursor: (resp: any) => {
      const link = resp?.['@odata.nextLink'];
      if (!link) return null;
      const m = link.match(/\$skiptoken=([^&]+)/i);
      return m ? decodeURIComponent(m[1]) : null;
    },
  },

  toItem: (raw: any): WorkItemInput | null => {
    if (!raw?.id) return null;
    const text = raw.body?.content || '';
    return {
      source: 'teams',
      source_id: raw.id,
      item_type: raw.replyToId ? 'thread_reply' : 'message',
      title: text.replace(/<[^>]*>/g, '').slice(0, 80) || raw.subject || `Message ${raw.id}`,
      body: text || null,
      author: raw.from?.user?.displayName || raw.from?.application?.displayName || null,
      status: 'sent',
      priority: raw.importance || null,
      url: raw.webUrl || null,
      metadata: {
        channel_id: raw.channelIdentity?.channelId || null,
        team_id: raw.channelIdentity?.teamId || null,
        attachments: (raw.attachments || []).map((a: any) => a.name),
        reactions: (raw.reactions || []).map((r: any) => r.reactionType),
        reply_count: raw.replyCount ?? 0,
      },
      created_at: raw.createdDateTime || new Date().toISOString(),
      updated_at: raw.lastModifiedDateTime || raw.lastEditedDateTime || null,
    };
  },
};
