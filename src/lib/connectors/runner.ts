import { ingestItems, ingestLinks, type LinkRowInput } from '../sync/ingest';
import { getDb } from '../db';
import { initSchema } from '../schema';
import { createLinksForItem } from '../crossref';
import type { WorkItemInput, SyncResult } from '../sync/types';
import type { MCPConnector, ConnectorRunContext, LinkInput } from './types';
import type { MCPClient } from './mcp-client';

export interface RunOptions {
  since?: string | null;        // ISO timestamp; defaults to last synced for this source
  limit?: number;               // Max pages to fetch (safety cap)
  cursor?: string | null;       // Override starting cursor
  dryRun?: boolean;             // Skip ingest, just print mapped items
  pageSize?: number;            // Hint passed via ctx (adapters decide how to use)
  verbose?: boolean;            // Emit per-page progress + tool calls to stderr
  options?: Record<string, unknown>;  // Saved per-workspace options for adapters
}

export interface RunPipelineOptions extends RunOptions {
  client: MCPClient | null;     // null means caller will provide raw responses (stdin mode)
  rawPages?: unknown[];         // For stdin mode: pre-fetched response pages
}

export function lastSyncedAt(source: string): string | null {
  initSchema();
  const db = getDb();
  const row = db
    .prepare('SELECT MAX(updated_at) as updated FROM work_items WHERE source = ?')
    .get(source) as { updated: string | null } | undefined;
  return row?.updated ?? null;
}

/**
 * Per-project (or per-bucket) MAX(updated_at). Used by adapters that scope by
 * sub-resource (Jira projects, GitHub repos, etc.) so newly-added scope items
 * get backfilled automatically — instead of being clamped to a global since
 * computed before they were ever in scope.
 *
 * `bucketKey` is the metadata field that holds the bucket id, e.g.
 * 'project' for Jira, 'repo' for GitHub.
 *
 * Returns: { bucketId: lastUpdatedISO } for buckets that have items;
 * buckets passed in `expected` but missing from the result are absent
 * (caller should treat them as never-synced).
 */
export function lastSyncedAtByBucket(
  source: string,
  bucketKey: string,
  expected: string[],
): Record<string, string> {
  initSchema();
  if (expected.length === 0) return {};
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT json_extract(metadata, '$.${bucketKey}') as bucket, MAX(updated_at) as updated
       FROM work_items
       WHERE source = ? AND json_extract(metadata, '$.${bucketKey}') IS NOT NULL
       GROUP BY bucket`,
    )
    .all(source) as { bucket: string | null; updated: string | null }[];
  const out: Record<string, string> = {};
  const expectedSet = new Set(expected);
  for (const r of rows) {
    if (r.bucket && r.updated && expectedSet.has(r.bucket)) out[r.bucket] = r.updated;
  }
  return out;
}

export async function runConnector(connector: MCPConnector, opts: RunPipelineOptions): Promise<SyncResult> {
  // Only honor an explicit since (CLI / "Resync from scratch"). Adapters
  // compute their own per-bucket incremental via resolveSince — falling back
  // to a global lastSyncedAt here would over-broadcast that floor to every
  // bucket and override the per-project incremental high-water mark.
  const since = opts.since ?? null;
  const limit = opts.limit ?? 20;
  const pageSize = opts.pageSize ?? 100;
  let cursor: string | null = opts.cursor ?? null;
  const collected: WorkItemInput[] = [];
  const pendingLinks: LinkInput[] = [];
  const errors: string[] = [];
  const verbose = opts.verbose ?? false;
  const log = (msg: string) => { if (verbose) console.error(`[${connector.source}] ${msg}`); };

  log(`begin since=${since ?? 'never'} limit=${limit} pageSize=${pageSize}`);

  // Pre-compute per-bucket since when the connector declares incremental
  // sync. Adapters read this from ctx instead of querying the DB themselves —
  // keeps adapters free of server-only DB imports so they're safe to import
  // from client components.
  let bucketLastSynced: Record<string, string> = {};
  if (connector.incremental) {
    const buckets = connector.incremental.getBuckets(opts.options ?? {});
    if (buckets.length > 0) {
      bucketLastSynced = lastSyncedAtByBucket(connector.source, connector.incremental.bucketField, buckets);
    }
  }

  for (let page = 0; page < limit; page++) {
    const ctx: ConnectorRunContext = {
      since,
      cursor,
      limit: pageSize,
      env: process.env,
      options: opts.options ?? {},
      bucketLastSynced,
    };

    const args = connector.list.args(ctx);
    log(`page ${page}: tool=${connector.list.tool} args=${JSON.stringify(args).slice(0, 240)}`);

    let response: unknown;
    if (opts.rawPages && opts.rawPages.length > 0) {
      response = opts.rawPages[page];
      if (!response) break;
    } else if (opts.client) {
      const t0 = Date.now();
      try {
        response = await opts.client.callTool(connector.list.tool, args);
        log(`page ${page}: ${Date.now() - t0}ms response=${typeof response === 'object' ? JSON.stringify(response).slice(0, 240) : String(response).slice(0, 240)}`);
      } catch (err: any) {
        const msg = `${connector.source} list page ${page}: ${err.message}`;
        log(msg);
        errors.push(msg);
        break;
      }
    } else {
      throw new Error(`runConnector(${connector.source}): no client and no rawPages provided`);
    }

    let rawItems: unknown[];
    try {
      rawItems = connector.list.extractItems(response) ?? [];
    } catch (err: any) {
      const msg = `${connector.source} extract page ${page}: ${err.message}`;
      log(msg);
      errors.push(msg);
      break;
    }
    log(`page ${page}: extracted ${rawItems.length} raw items`);

    for (const raw of rawItems) {
      let resolved: unknown = raw;
      if (connector.detail && opts.client && !connector.detail.skip?.(raw)) {
        try {
          const detail = await opts.client.callTool(connector.detail.tool, connector.detail.args(raw));
          resolved = connector.detail.merge(raw, detail);
        } catch (err: any) {
          errors.push(`${connector.source} detail: ${err.message}`);
        }
      }
      try {
        const item = connector.toItem(resolved);
        if (item) collected.push(item);
        if (connector.derivedItems) {
          for (const d of connector.derivedItems(resolved, item)) collected.push(d);
        }
        if (connector.links) {
          for (const l of connector.links(resolved, item)) pendingLinks.push(l);
        }
      } catch (err: any) {
        errors.push(`${connector.source} toItem: ${err.message}`);
      }
    }

    const next = connector.list.extractCursor?.(response) ?? null;
    if (!next || rawItems.length === 0) break;
    cursor = next;
  }

  // Optional post-pass (e.g. fetch releases per discovered repo)
  if (connector.postPass && opts.client) {
    try {
      log(`postPass start (${collected.length} primaries collected)`);
      const post = await connector.postPass(opts.client, collected);
      collected.push(...post.items);
      pendingLinks.push(...post.links);
      log(`postPass done items=${post.items.length} links=${post.links.length}`);
    } catch (err: any) {
      const msg = `${connector.source} postPass: ${err.message}`;
      log(msg);
      errors.push(msg);
    }
  }

  log(`done collected=${collected.length} links=${pendingLinks.length} errors=${errors.length}`);

  if (opts.dryRun) {
    return {
      source: connector.source,
      itemsSynced: 0,
      itemsUpdated: 0,
      itemsSkipped: collected.length,
      errors: ['dry-run: ingest skipped', ...errors],
    };
  }

  if (collected.length === 0) {
    return { source: connector.source, itemsSynced: 0, itemsUpdated: 0, itemsSkipped: 0, errors };
  }

  const result = ingestItems(collected);

  // Resolve link refs to work_items.id and insert
  if (pendingLinks.length > 0) {
    const linkRows: LinkRowInput[] = pendingLinks.map((l) => ({
      from: l.from,
      to: l.to,
      link_type: l.link_type,
      confidence: l.confidence,
    }));
    try {
      const linkResult = ingestLinks(linkRows);
      log(`links inserted=${linkResult.inserted} skipped=${linkResult.skipped}`);
    } catch (err: any) {
      errors.push(`${connector.source} links: ${err.message}`);
    }
  }

  // Cross-source linking — run after items are ingested. crossref.ts looks for
  // Jira-key mentions, @user / #channel handles, and chunk-embedding similarity
  // and creates 'references' / 'mentions' / 'discusses' edges between items.
  // We only process items just synced/updated to keep this cheap.
  if (collected.length > 0 && !opts.dryRun) {
    try {
      const lookup = getDb().prepare('SELECT id FROM work_items WHERE source = ? AND source_id = ?');
      let processed = 0;
      let crossLinks = 0;
      for (const item of collected) {
        const row = lookup.get(item.source, item.source_id) as { id: string } | undefined;
        if (!row) continue;
        try {
          crossLinks += createLinksForItem(row.id);
          processed++;
        } catch (err: any) {
          // crossref failures shouldn't fail the sync — log and continue
          errors.push(`${connector.source} crossref ${item.source_id}: ${err.message}`);
        }
      }
      log(`crossref processed=${processed} new-edges=${crossLinks}`);
    } catch (err: any) {
      log(`crossref skipped: ${err.message}`);
    }
  }

  if (errors.length) result.errors.push(...errors);
  return result;
}
