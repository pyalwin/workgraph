import type { MCPConnector } from '../types';
import type { WorkItemInput } from '../../sync/types';

export const granolaConnector: MCPConnector = {
  source: 'meeting',
  label: 'Granola Meetings',
  serverId: 'granola',
  itemType: 'meeting',
  requiredEnv: ['MCP_GRANOLA_URL'],

  list: {
    tool: 'list_meetings',
    args: (ctx) => ({
      time_range: ctx.since
        ? { type: 'custom', start: ctx.since, end: new Date().toISOString() }
        : { type: 'last_30_days' },
      limit: ctx.limit,
      cursor: ctx.cursor ?? undefined,
    }),
    extractItems: (resp: any) => resp?.meetings ?? resp?.results ?? [],
    extractCursor: (resp: any) => resp?.next_cursor ?? null,
  },

  detail: {
    tool: 'get_meeting_transcript',
    args: (raw: any) => ({ meeting_id: raw.id }),
    merge: (raw: any, detail: any) => ({
      ...raw,
      transcript: detail?.transcript || detail?.text || raw.transcript,
      summary: detail?.summary || raw.summary,
    }),
  },

  toItem: (raw: any): WorkItemInput | null => {
    if (!raw?.id) return null;
    const participants: string[] = Array.isArray(raw.participants)
      ? raw.participants.map((p: any) => (typeof p === 'string' ? p : p.name || p.email)).filter(Boolean)
      : [];
    return {
      source: 'meeting',
      source_id: raw.id,
      item_type: 'meeting',
      title: raw.title || 'Untitled Meeting',
      body: raw.transcript || raw.summary || raw.notes || null,
      author: raw.organizer?.name || raw.organizer || participants[0] || null,
      status: 'completed',
      priority: null,
      url: raw.url || null,
      metadata: {
        participants,
        duration: raw.duration_seconds || raw.duration || null,
        folder: raw.folder?.name || raw.folder || null,
      },
      created_at: raw.start_time || raw.date || new Date().toISOString(),
      updated_at: raw.end_time || null,
    };
  },
};
