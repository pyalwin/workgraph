import { ingestItems, ingestLinks, type LinkRowInput } from '../sync/ingest';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { createLinksForItem } from '../crossref';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}
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

export async function lastSyncedAt(source: string): Promise<string | null> {
  await ensureInit();
  const db = getLibsqlDb();
  const row = await db
    .prepare('SELECT MAX(updated_at) as updated FROM work_items WHERE source = ?')
    .get<{ updated: string | null }>(source);
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
export async function lastSyncedAtByBucket(
  source: string,
  bucketKey: string,
  expected: string[],
): Promise<Record<string, string>> {
  await ensureInit();
  if (expected.length === 0) return {};
  const db = getLibsqlDb();
  const rows = await db
    .prepare(
      `SELECT json_extract(metadata, '$.${bucketKey}') as bucket, MAX(updated_at) as updated
       FROM work_items
       WHERE source = ? AND json_extract(metadata, '$.${bucketKey}') IS NOT NULL
       GROUP BY bucket`,
    )
    .all<{ bucket: string | null; updated: string | null }>(source);
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
      bucketLastSynced = await lastSyncedAtByBucket(connector.source, connector.incremental.bucketField, buckets);
    }
  }

  // Some connectors (e.g. GitHub: releases-only via postPass) opt out of the
  // list step entirely. Skip the page loop and let postPass do the work.
  const skipList = connector.list.skip === true;
  if (skipList) log('list step skipped (postPass-only connector)');

  for (let page = 0; !skipList && page < limit; page++) {
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

    // Phase 0: drop unchanged items before doing any per-item network work.
    // For incremental syncs (most syncs) the result list is dominated by
    // items whose updated_at matches what we already have in the DB. Skipping
    // the detail fetch + re-ingest for those is the single biggest perf win.
    //
    // Cheap: one batched SELECT per page. We compute the source_id by calling
    // toItem(raw) — pure local work, no I/O. Items whose toItem throws or
    // returns null fall through to the full pipeline so behavior is preserved.
    const previewIds: { idx: number; sourceId: string; updatedAt: string | null }[] = [];
    for (let i = 0; i < rawItems.length; i++) {
      try {
        const preview = connector.toItem(rawItems[i]);
        if (preview?.source_id) {
          previewIds.push({ idx: i, sourceId: preview.source_id, updatedAt: preview.updated_at ?? null });
        }
      } catch {
        // toItem fails → keep the raw item in the active set for normal handling.
      }
    }

    let activeIndices: number[] = rawItems.map((_, i) => i);
    if (previewIds.length > 0) {
      const lookupDb = getLibsqlDb();
      const placeholders = previewIds.map(() => '?').join(',');
      const existing = await lookupDb
        .prepare(
          `SELECT source_id, updated_at FROM work_items
           WHERE source = ? AND source_id IN (${placeholders})`,
        )
        .all<{ source_id: string; updated_at: string | null }>(
          connector.source,
          ...previewIds.map((p) => p.sourceId),
        );
      const existingMap = new Map(existing.map((r) => [r.source_id, r.updated_at]));
      const skip = new Set<number>();
      let unchanged = 0;
      for (const p of previewIds) {
        const prev = existingMap.get(p.sourceId);
        // Skip iff we already have a row AND its updated_at is >= the raw's.
        // Strict equality is too brittle (timezones, rounding); >= covers it.
        if (prev && p.updatedAt && prev >= p.updatedAt) {
          skip.add(p.idx);
          unchanged++;
        }
      }
      if (skip.size > 0) {
        activeIndices = activeIndices.filter((i) => !skip.has(i));
        log(`page ${page}: skipping ${unchanged} unchanged items (kept ${activeIndices.length})`);
      }
    }

    // Phase 1: resolve detail (per-item enrichment call) in parallel batches.
    // Was serial — for GitHub PRs that meant 100 PRs × ~200ms = 20s/page just
    // for the get_pull_request round-trips. With concurrency=8 the same page
    // finishes in ~2.5s; total throughput goes up ~5-8× without exhausting
    // either the MCP server or our event loop.
    const DETAIL_CONCURRENCY = 8;
    const resolved: unknown[] = new Array(rawItems.length);
    // Default-fill so phase 2 has something for skipped indices.
    for (let i = 0; i < rawItems.length; i++) resolved[i] = rawItems[i];

    if (connector.detail && opts.client && activeIndices.length > 0) {
      const client = opts.client;
      const detailFn = connector.detail;
      let nextDetailIdx = 0;
      const workers: Promise<void>[] = [];
      const detailErrors: string[] = [];
      for (let w = 0; w < DETAIL_CONCURRENCY; w++) {
        workers.push((async () => {
          while (true) {
            const k = nextDetailIdx++;
            if (k >= activeIndices.length) return;
            const idx = activeIndices[k];
            const raw = rawItems[idx];
            if (detailFn.skip?.(raw)) continue;
            try {
              const detail = await client.callTool(detailFn.tool, detailFn.args(raw));
              resolved[idx] = detailFn.merge(raw, detail);
            } catch (err: any) {
              detailErrors.push(`${connector.source} detail: ${err.message}`);
              // keep the raw fallback already in resolved[idx]
            }
          }
        })());
      }
      await Promise.all(workers);
      if (detailErrors.length > 0) errors.push(...detailErrors.slice(0, 10));
    }

    // Phase 2: convert + collect items/links — only for indices that survived
    // the unchanged-skip and any detail-fetch errors. Sequential: pure local
    // work, no benefit from parallelism and ordering keeps logs readable.
    const activeSet = new Set(activeIndices);
    for (let i = 0; i < resolved.length; i++) {
      if (!activeSet.has(i)) continue;
      const r = resolved[i];
      try {
        const item = connector.toItem(r);
        if (item) collected.push(item);
        if (connector.derivedItems) {
          for (const d of connector.derivedItems(r, item)) collected.push(d);
        }
        if (connector.links) {
          for (const l of connector.links(r, item)) pendingLinks.push(l);
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
      const postCtx: ConnectorRunContext = {
        since,
        cursor,
        limit: pageSize,
        env: process.env,
        options: opts.options ?? {},
        bucketLastSynced,
      };
      const post = await connector.postPass(opts.client, collected, postCtx);
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

  const result = await ingestItems(collected);

  // Resolve link refs to work_items.id and insert
  if (pendingLinks.length > 0) {
    const linkRows: LinkRowInput[] = pendingLinks.map((l) => ({
      from: l.from,
      to: l.to,
      link_type: l.link_type,
      confidence: l.confidence,
    }));
    try {
      const linkResult = await ingestLinks(linkRows);
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
      const lookupDb = getLibsqlDb();
      const lookupSql = 'SELECT id FROM work_items WHERE source = ? AND source_id = ?';
      let processed = 0;
      let crossLinks = 0;
      for (const item of collected) {
        const row = await lookupDb
          .prepare(lookupSql)
          .get<{ id: string }>(item.source, item.source_id);
        if (!row) continue;
        try {
          crossLinks += await createLinksForItem(row.id);
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
