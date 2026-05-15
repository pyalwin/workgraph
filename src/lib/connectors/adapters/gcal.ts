import type { DirectAPIConnector, DirectRunContext } from '../types';
import type { WorkItemInput } from '../../sync/types';
import { resolveSince, DEFAULT_BACKFILL_DAYS } from '../defaults';

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars';
const FUTURE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

async function gapi(url: string, accessToken: string): Promise<any> {
  const { fetchGoogle } = await import('../google-fetch');
  return fetchGoogle(url, accessToken, { label: 'Calendar' });
}

function buildEventsUrl(calendarId: string, params: URLSearchParams): string {
  return `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
}

async function initialSync(
  ctx: DirectRunContext,
  calendarId: string,
): Promise<{ items: unknown[]; cursor: string | null; syncMarker?: string }> {
  const params = new URLSearchParams();
  // Resolve user-configured window. Calendar also looks forward (upcoming
  // events) so we add a 30-day future buffer unless an explicit `until`
  // says otherwise.
  const window = resolveSince(ctx.options, undefined, DEFAULT_BACKFILL_DAYS, ctx.since);
  const timeMin = window.allTime
    ? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString() // 1y as practical floor
    : `${window.date}T00:00:00Z`;
  const timeMax = window.until
    ? `${window.until}T23:59:59Z`
    : new Date(Date.now() + FUTURE_WINDOW_MS).toISOString();
  params.set('timeMin', timeMin);
  params.set('timeMax', timeMax);
  params.set('singleEvents', 'true');
  params.set('orderBy', 'updated');
  params.set('maxResults', String(ctx.limit));
  if (ctx.cursor) params.set('pageToken', ctx.cursor);

  const resp = await gapi(buildEventsUrl(calendarId, params), ctx.accessToken);
  const items: unknown[] = Array.isArray(resp?.items) ? resp.items : [];
  const cursor: string | null = resp?.nextPageToken ?? null;
  const out: { items: unknown[]; cursor: string | null; syncMarker?: string } = { items, cursor };
  // On the final page, Google returns nextSyncToken — persist it so subsequent
  // runs can use the incremental syncToken endpoint.
  if (!cursor && typeof resp?.nextSyncToken === 'string') {
    out.syncMarker = resp.nextSyncToken;
  }
  return out;
}

async function incrementalSync(
  ctx: DirectRunContext,
  calendarId: string,
  syncToken: string,
): Promise<{ items: unknown[]; cursor: string | null; syncMarker?: string }> {
  const params = new URLSearchParams();
  // syncToken cannot be combined with timeMin/timeMax/orderBy — Google rejects.
  params.set('syncToken', syncToken);
  params.set('singleEvents', 'true');
  params.set('maxResults', String(ctx.limit));
  // pageToken (when paginating within an incremental result set) is fine.
  if (ctx.cursor && ctx.cursor !== syncToken) params.set('pageToken', ctx.cursor);

  let resp: any;
  try {
    resp = await gapi(buildEventsUrl(calendarId, params), ctx.accessToken);
  } catch (err: any) {
    if (err?.status === 410) {
      console.warn(
        `[gcal] syncToken expired (HTTP 410) — falling back to initial sync for calendar ${calendarId}`,
      );
      return initialSync(ctx, calendarId);
    }
    throw err;
  }

  const items: unknown[] = Array.isArray(resp?.items) ? resp.items : [];
  const cursor: string | null = resp?.nextPageToken ?? null;
  const out: { items: unknown[]; cursor: string | null; syncMarker?: string } = { items, cursor };
  if (!cursor && typeof resp?.nextSyncToken === 'string') {
    out.syncMarker = resp.nextSyncToken;
  }
  return out;
}

export const gcalConnector: DirectAPIConnector = {
  kind: 'direct',
  source: 'gcal',
  label: 'Google Calendar',
  itemType: 'event',
  oauthProvider: 'google',

  list: async (ctx) => {
    const calendarId = process.env.MCP_GCAL_CALENDAR_ID || 'primary';
    // Prefer ctx.cursor when paginating mid-run; otherwise use the persisted
    // syncMarker as the syncToken seed.
    const syncToken = ctx.syncMarker ?? null;
    if (syncToken) {
      // ctx.cursor takes precedence as a pageToken within an in-progress
      // incremental result set; the syncToken itself is always the seed.
      return incrementalSync(ctx, calendarId, syncToken);
    }
    return initialSync(ctx, calendarId);
  },

  toItem: (raw: any): WorkItemInput | null => {
    if (!raw?.id) return null;
    const start = raw.start?.dateTime || raw.start?.date;
    const end = raw.end?.dateTime || raw.end?.date;
    const attendees = (raw.attendees || [])
      .map((a: any) => a.email || a.displayName)
      .filter(Boolean);
    const status = raw.status === 'cancelled' ? 'cancelled' : 'scheduled';
    return {
      source: 'gcal',
      source_id: raw.id,
      item_type: 'event',
      title: raw.summary || 'Untitled event',
      body: raw.description || null,
      author:
        raw.organizer?.displayName ||
        raw.organizer?.email ||
        raw.creator?.email ||
        null,
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
