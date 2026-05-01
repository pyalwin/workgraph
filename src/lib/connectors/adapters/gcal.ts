import type { MCPConnector } from '../types';
import type { WorkItemInput } from '../../sync/types';

export const gcalConnector: MCPConnector = {
  source: 'gcal',
  label: 'Google Calendar',
  serverId: 'gcal',
  itemType: 'event',

  list: {
    tool: 'list_events',
    args: (ctx) => ({
      calendarId: process.env.MCP_GCAL_CALENDAR_ID || 'primary',
      timeMin: ctx.since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      timeMax: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      maxResults: ctx.limit,
      pageToken: ctx.cursor ?? undefined,
      singleEvents: true,
      orderBy: 'updated',
    }),
    extractItems: (resp: any) => resp?.items ?? resp?.events ?? [],
    extractCursor: (resp: any) => resp?.nextPageToken ?? null,
  },

  toItem: (raw: any): WorkItemInput | null => {
    if (!raw?.id) return null;
    const start = raw.start?.dateTime || raw.start?.date;
    const end = raw.end?.dateTime || raw.end?.date;
    const attendees = (raw.attendees || []).map((a: any) => a.email || a.displayName).filter(Boolean);
    const status = raw.status === 'cancelled' ? 'cancelled' : 'scheduled';
    return {
      source: 'gcal',
      source_id: raw.id,
      item_type: 'event',
      title: raw.summary || 'Untitled event',
      body: raw.description || null,
      author: raw.organizer?.displayName || raw.organizer?.email || raw.creator?.email || null,
      status,
      priority: null,
      url: raw.htmlLink || null,
      metadata: {
        start,
        end,
        attendees,
        location: raw.location || null,
        recurring_event_id: raw.recurringEventId || null,
        hangout_link: raw.hangoutLink || null,
      },
      created_at: raw.created || start || new Date().toISOString(),
      updated_at: raw.updated || null,
    };
  },
};
