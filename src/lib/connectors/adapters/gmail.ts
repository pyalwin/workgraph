import type { DirectAPIConnector, DirectRunContext } from '../types';
import type { WorkItemInput } from '../../sync/types';
import { resolveSince } from '../defaults';
import { fetchGoogle } from '../google-fetch';

/**
 * Gmail direct-API adapter.
 *
 * Plain `fetch` against the Gmail REST API — no `googleapis` dependency.
 * Sync model:
 *   - Initial: list threads matching `q` (default `newer_than:30d` or
 *     `after:<since>` if ctx.since is set), capture profile.historyId as the
 *     starting syncMarker for the next run.
 *   - Incremental: walk users.history starting from the stored historyId,
 *     collecting distinct thread IDs touched by messageAdded events. On
 *     stale-marker 404, fall back to a full sync.
 *
 * detail() fetches the full thread (format=full) so toItem can build a
 * thread-shaped WorkItemInput from the message tree.
 */

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface GapiError extends Error {
  status?: number;
  body?: string;
}

// Routed through the shared fetchGoogle helper so rate-limit handling
// (429 + Retry-After + 5xx backoff + GoogleRateLimitError on daily quota)
// is consistent with the other Google adapters.
async function gapi(url: string, accessToken: string): Promise<any> {
  return fetchGoogle(url, accessToken, { label: 'Gmail' });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toGmailDate(iso: string): string {
  // Gmail's `after:` operator accepts YYYY/MM/DD.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '1970/01/01';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

function isStaleHistoryError(err: unknown): boolean {
  const e = err as GapiError | undefined;
  if (!e || e.status !== 404) return false;
  const body = e.body ?? '';
  // Gmail returns errors[0].reason === 'notFound' for stale historyIds.
  if (body.includes('"reason":"notFound"') || body.includes('"reason": "notFound"')) {
    return true;
  }
  try {
    const parsed = JSON.parse(body);
    const reason = parsed?.error?.errors?.[0]?.reason;
    return reason === 'notFound';
  } catch {
    return false;
  }
}

function buildHistoryUrl(syncMarker: string, pageToken: string | null | undefined): string {
  const params = new URLSearchParams();
  params.set('startHistoryId', syncMarker);
  params.append('historyTypes', 'messageAdded');
  if (pageToken) params.set('pageToken', pageToken);
  return `https://gmail.googleapis.com/gmail/v1/users/me/history?${params.toString()}`;
}

function buildThreadsListUrl(q: string, limit: number, pageToken: string | null | undefined): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('maxResults', String(limit));
  if (pageToken) params.set('pageToken', pageToken);
  return `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params.toString()}`;
}

function maxHistoryId(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  // Gmail historyIds are monotonically increasing integers represented as strings.
  // Compare numerically when both parse cleanly; otherwise lex-fall-back.
  try {
    const ai = BigInt(a);
    const bi = BigInt(b);
    return ai >= bi ? a : b;
  } catch {
    return a >= b ? a : b;
  }
}

// ---------------------------------------------------------------------------
// MIME parsing for toItem
// ---------------------------------------------------------------------------

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailPayload {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPayload;
}

interface GmailThread {
  id?: string;
  historyId?: string;
  messages?: GmailMessage[];
  snippet?: string;
}

function indexHeaders(headers: GmailHeader[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!headers) return m;
  for (const h of headers) {
    if (h.name && h.value !== undefined) {
      m.set(h.name.toLowerCase(), h.value);
    }
  }
  return m;
}

function parseAddrs(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function decodeBase64Url(data: string): string {
  // Gmail bodies are base64url with optional padding stripped.
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

function stripHtml(html: string): string {
  // Coarse HTML strip — drop scripts/styles, replace block tags with newlines,
  // strip remaining tags, collapse whitespace.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function extractTextBody(payload: GmailPayload | undefined): string {
  if (!payload) return '';

  const plains: string[] = [];
  const htmls: string[] = [];

  const walk = (node: GmailPayload): void => {
    const mime = (node.mimeType || '').toLowerCase();
    if (mime === 'text/plain' && node.body?.data) {
      plains.push(decodeBase64Url(node.body.data));
    } else if (mime === 'text/html' && node.body?.data) {
      htmls.push(decodeBase64Url(node.body.data));
    }
    if (node.parts && node.parts.length) {
      for (const child of node.parts) walk(child);
    }
  };

  walk(payload);

  if (plains.length) return plains.join('\n').trim();
  if (htmls.length) return stripHtml(htmls.join('\n')).trim();
  return '';
}

const BODY_CAP = 32 * 1024;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const gmailConnector: DirectAPIConnector = {
  kind: 'direct',
  source: 'gmail',
  label: 'Gmail',
  itemType: 'thread',
  oauthProvider: 'google',

  list: async (ctx: DirectRunContext) => {
    const { accessToken, syncMarker, cursor, limit, since, env } = ctx;

    // -------- Incremental path --------
    if (syncMarker) {
      try {
        const url = buildHistoryUrl(syncMarker, cursor);
        const res = await gapi(url, accessToken);

        const threadIds = new Set<string>();
        const history: any[] = Array.isArray(res.history) ? res.history : [];
        let largestSeen: string | undefined = res.historyId;
        for (const entry of history) {
          if (entry?.id) {
            largestSeen = maxHistoryId(largestSeen, String(entry.id));
          }
          const added: any[] = Array.isArray(entry?.messagesAdded) ? entry.messagesAdded : [];
          for (const ma of added) {
            const tid = ma?.message?.threadId;
            if (typeof tid === 'string' && tid) threadIds.add(tid);
          }
        }

        const items = Array.from(threadIds).map((id) => ({ id }));
        const nextCursor: string | null = res.nextPageToken ?? null;
        const out: { items: unknown[]; cursor: string | null; syncMarker?: string } = {
          items,
          cursor: nextCursor,
        };
        if (largestSeen) out.syncMarker = largestSeen;
        return out;
      } catch (err) {
        if (isStaleHistoryError(err)) {
          console.warn(
            `[gmail] stale syncMarker (${syncMarker}); falling back to full sync.`,
          );
          // Fall through to initial path below by clearing the marker.
          return await runInitialSync({ ...ctx, syncMarker: null }, env);
        }
        throw err;
      }
    }

    // -------- Initial path --------
    return await runInitialSync(ctx, env);
  },

  detail: async (raw: unknown, ctx: DirectRunContext) => {
    const stub = raw as { id?: string };
    if (!stub?.id) return raw;
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(
      stub.id,
    )}?format=full`;
    try {
      return await gapi(url, ctx.accessToken);
    } catch (err) {
      // Surface the error message but return the stub so toItem can skip it
      // (no messages → null) rather than aborting the whole page.
      console.warn(
        `[gmail] detail fetch failed for thread ${stub.id}: ${(err as Error).message}`,
      );
      return raw;
    }
  },

  toItem: (raw: unknown): WorkItemInput | null => {
    const t = raw as GmailThread | null | undefined;
    if (!t || !t.id || !t.messages || t.messages.length === 0) return null;

    const messages = [...t.messages].sort((a, b) => {
      const an = Number(a.internalDate ?? 0);
      const bn = Number(b.internalDate ?? 0);
      return an - bn;
    });

    const firstMsg = messages[0];
    const lastMsg = messages[messages.length - 1];
    const firstHeaders = indexHeaders(firstMsg.payload?.headers);

    // Body — concat each message's extracted body separated by ---.
    const bodies: string[] = [];
    for (const m of messages) {
      const txt = extractTextBody(m.payload);
      if (txt) bodies.push(txt);
    }
    let body: string | null = bodies.length ? bodies.join('\n\n---\n\n') : null;
    let bodyTruncated = false;
    if (body && body.length > BODY_CAP) {
      body = body.slice(0, BODY_CAP) + '\n\n[…truncated]';
      bodyTruncated = true;
    }

    // Participants — union of from/to/cc across all messages.
    const participantSet = new Set<string>();
    for (const m of messages) {
      const h = indexHeaders(m.payload?.headers);
      for (const addr of parseAddrs(h.get('from'))) participantSet.add(addr);
      for (const addr of parseAddrs(h.get('to'))) participantSet.add(addr);
      for (const addr of parseAddrs(h.get('cc'))) participantSet.add(addr);
    }
    const participants = Array.from(participantSet);

    // Labels — union across all messages.
    const labelSet = new Set<string>();
    for (const m of messages) {
      for (const l of m.labelIds ?? []) labelSet.add(l);
    }
    const labels = Array.from(labelSet);

    const firstAtMs = Number(firstMsg.internalDate ?? 0);
    const lastAtMs = Number(lastMsg.internalDate ?? firstAtMs);
    const firstAtIso = new Date(firstAtMs).toISOString();
    const lastAtIso = new Date(lastAtMs).toISOString();

    // Status: archived if every message is in TRASH; otherwise active.
    const allTrashed =
      messages.length > 0 &&
      messages.every((m) => (m.labelIds ?? []).includes('TRASH'));
    const status = allTrashed ? 'archived' : 'active';

    // Priority: high if any message is IMPORTANT.
    const anyImportant = messages.some((m) => (m.labelIds ?? []).includes('IMPORTANT'));
    const priority = anyImportant ? 'high' : null;

    const subject = firstHeaders.get('subject');
    const fromAddr = firstHeaders.get('from') ?? null;

    const metadata: Record<string, unknown> = {
      message_count: messages.length,
      participants,
      labels,
      first_at: firstAtIso,
      last_at: lastAtIso,
    };
    if (bodyTruncated) metadata.body_truncated = true;

    return {
      source: 'gmail',
      source_id: t.id,
      item_type: 'thread',
      title: subject && subject.trim().length > 0 ? subject : '(no subject)',
      body,
      author: fromAddr,
      status,
      priority,
      url: `https://mail.google.com/mail/u/0/#inbox/${t.id}`,
      metadata,
      created_at: firstAtIso,
      updated_at: lastAtIso,
    };
  },
};

// ---------------------------------------------------------------------------
// Initial sync helper (also used as fallback when historyId is stale)
// ---------------------------------------------------------------------------

async function runInitialSync(
  ctx: DirectRunContext,
  env: NodeJS.ProcessEnv,
): Promise<{ items: unknown[]; cursor: string | null; syncMarker?: string }> {
  const { accessToken, cursor, limit, since, options } = ctx;

  const envQuery = env.MCP_GMAIL_QUERY;
  // Resolve the configured time window. Default: rolling 90 days.
  const window = resolveSince(options, undefined, undefined, since);
  let q: string;
  if (envQuery && envQuery.trim().length > 0) {
    q = envQuery;
  } else if (window.allTime) {
    // No date filter — sync full history.
    q = 'in:anywhere';
  } else {
    const parts: string[] = [];
    if (window.date) parts.push(`after:${window.date.replace(/-/g, '/')}`);
    if (window.until) parts.push(`before:${window.until.replace(/-/g, '/')}`);
    q = parts.join(' ') || 'newer_than:90d';
  }

  const url = buildThreadsListUrl(q, limit, cursor);
  const res = await gapi(url, accessToken);

  const threads: any[] = Array.isArray(res.threads) ? res.threads : [];
  const nextCursor: string | null = res.nextPageToken ?? null;

  // Capture the current profile.historyId on the first page so the next
  // run can switch to incremental. Cumulative-max across pages is safe;
  // the runner persists the latest emitted value.
  let syncMarker: string | undefined;
  try {
    const profile = await gapi(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      accessToken,
    );
    if (profile?.historyId) syncMarker = String(profile.historyId);
  } catch (err) {
    // Non-fatal — without a marker the next run just does another full sync.
    console.warn(`[gmail] profile fetch failed: ${(err as Error).message}`);
  }

  const out: { items: unknown[]; cursor: string | null; syncMarker?: string } = {
    items: threads,
    cursor: nextCursor,
  };
  if (syncMarker) out.syncMarker = syncMarker;
  return out;
}
