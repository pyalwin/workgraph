import type { DirectAPIConnector, DirectRunContext } from '../types';
import type { WorkItemInput } from '../../sync/types';
import { resolveSince } from '../defaults';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const BODY_CAP_BYTES = 32 * 1024;

const FILE_FIELDS =
  'id, name, mimeType, owners(displayName, emailAddress), parents, modifiedTime, createdTime, webViewLink, size, starred, trashed';

async function gapi(url: string, accessToken: string, asText = false): Promise<any> {
  // Shared rate-limit-aware fetcher.
  const { fetchGoogle } = await import('../google-fetch');
  return fetchGoogle(url, accessToken, { label: 'Drive', asText });
}

function buildUrl(path: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, v);
  }
  return `${DRIVE_BASE}${path}?${qs.toString()}`;
}

async function initialList(
  ctx: DirectRunContext,
  startPageToken: string,
): Promise<{ items: unknown[]; cursor: string | null; syncMarker?: string }> {
  // Resolve user-configured window into a Drive `q` clause. Drive uses
  // RFC 3339 timestamps with quoted comparisons in the q parameter.
  const window = resolveSince(ctx.options, undefined, undefined, ctx.since);
  const parts: string[] = ['trashed = false'];
  if (!window.allTime) {
    if (window.date) parts.push(`modifiedTime > '${window.date}T00:00:00'`);
    if (window.until) parts.push(`modifiedTime < '${window.until}T23:59:59'`);
  }
  const envQ = process.env.MCP_GDRIVE_QUERY;
  const q = envQ && envQ.trim().length > 0 ? envQ : parts.join(' and ');

  const url = buildUrl('/files', {
    q,
    fields: `nextPageToken, files(${FILE_FIELDS})`,
    pageSize: String(ctx.limit),
    pageToken: ctx.cursor ?? undefined,
  });
  const resp = await gapi(url, ctx.accessToken);
  const items = Array.isArray(resp?.files) ? resp.files : [];
  const cursor: string | null = resp?.nextPageToken ?? null;
  // Always return startPageToken as syncMarker so the runner persists it
  // even if the run halts mid-pagination.
  return { items, cursor, syncMarker: startPageToken };
}

async function incrementalList(
  ctx: DirectRunContext,
): Promise<{ items: unknown[]; cursor: string | null; syncMarker?: string }> {
  const pageToken = ctx.cursor ?? ctx.syncMarker!;
  const url = buildUrl('/changes', {
    pageToken,
    fields: `newStartPageToken, nextPageToken, changes(file(${FILE_FIELDS}), removed)`,
  });
  let resp: any;
  try {
    resp = await gapi(url, ctx.accessToken);
  } catch (e: any) {
    if (e?.status === 410) {
      console.warn('[gdrive] Stale changes pageToken (410); falling back to initial sync');
      const startResp = await gapi(
        buildUrl('/changes/startPageToken', {}),
        ctx.accessToken,
      );
      const startPageToken: string = startResp?.startPageToken;
      // Restart paginating from scratch (drop ctx.cursor implicitly by
      // re-entering initial branch with no cursor).
      const fallbackCtx: DirectRunContext = { ...ctx, syncMarker: null, cursor: null };
      return initialList(fallbackCtx, startPageToken);
    }
    throw e;
  }
  const changes: any[] = Array.isArray(resp?.changes) ? resp.changes : [];
  const items = changes
    .filter((c: any) => !c.removed)
    .map((c: any) => c.file)
    .filter(Boolean);
  const cursor: string | null = resp?.nextPageToken ?? null;
  const out: { items: unknown[]; cursor: string | null; syncMarker?: string } = {
    items,
    cursor,
  };
  if (!cursor && resp?.newStartPageToken) {
    out.syncMarker = resp.newStartPageToken;
  }
  return out;
}

const EXPORTABLE_MIMES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
]);

export const gdriveConnector: DirectAPIConnector = {
  kind: 'direct',
  source: 'gdrive',
  label: 'Google Drive',
  itemType: 'document',
  oauthProvider: 'google',

  list: async (ctx) => {
    if (!ctx.syncMarker) {
      // Initial sync — fetch startPageToken first so we can persist it.
      const startResp = await gapi(
        buildUrl('/changes/startPageToken', {}),
        ctx.accessToken,
      );
      const startPageToken: string = startResp?.startPageToken;
      return initialList(ctx, startPageToken);
    }
    return incrementalList(ctx);
  },

  detail: async (raw: any, ctx) => {
    if (!raw?.id) return raw;
    const mime: string = raw.mimeType || '';
    if (!EXPORTABLE_MIMES.has(mime)) return raw;
    try {
      const url = buildUrl(`/files/${encodeURIComponent(raw.id)}/export`, {
        mimeType: 'text/plain',
      });
      const text = await gapi(url, ctx.accessToken, true);
      const buf = Buffer.from(text, 'utf8');
      if (buf.byteLength > BODY_CAP_BYTES) {
        const truncated = buf.subarray(0, BODY_CAP_BYTES).toString('utf8');
        return { ...raw, body: truncated, body_truncated: true };
      }
      return { ...raw, body: text };
    } catch (e: any) {
      console.warn(`[gdrive] export failed for ${raw.id}: ${e?.message ?? e}`);
      return raw;
    }
  },

  toItem: (raw: any): WorkItemInput | null => {
    if (!raw?.id) return null;
    const mime: string = raw.mimeType || '';
    const itemType = mime.includes('document')
      ? 'doc'
      : mime.includes('spreadsheet')
      ? 'sheet'
      : mime.includes('presentation')
      ? 'slides'
      : mime.includes('folder')
      ? 'folder'
      : 'file';
    const metadata: Record<string, unknown> = {
      mime_type: mime,
      size: raw.size || null,
      owners: Array.isArray(raw.owners)
        ? raw.owners.map((o: any) => o.emailAddress).filter(Boolean)
        : [],
      parents: raw.parents || [],
      starred: raw.starred ?? false,
    };
    if (raw.body_truncated) metadata.body_truncated = true;
    return {
      source: 'gdrive',
      source_id: raw.id,
      item_type: itemType,
      title: raw.name || 'Untitled',
      body: raw.body ?? null,
      author:
        raw.owners?.[0]?.displayName || raw.owners?.[0]?.emailAddress || null,
      status: raw.trashed ? 'archived' : 'published',
      priority: null,
      url: raw.webViewLink || null,
      metadata,
      created_at: raw.createdTime || new Date().toISOString(),
      updated_at: raw.modifiedTime || null,
    };
  },
};
