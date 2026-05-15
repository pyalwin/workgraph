import { ingestItems, ingestLinks, type LinkRowInput } from '../sync/ingest';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { createLinksForItem } from '../crossref';
import { getOAuthTokenByProvider } from '../oauth/refresh';
import { persistPipelineLinksForItems } from '../pipelines/persist';
import type { WorkItemInput, SyncResult } from '../sync/types';
import type { DirectAPIConnector, DirectRunContext, LinkInput } from './types';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

export interface RunDirectOptions {
  workspaceId: string;
  configRow: {
    id: string;
    source: string;
    sync_marker: string | null;
    oauth_provider: string | null;
    options: Record<string, unknown>;
  };
  since?: string | null;
  limit?: number;
  dryRun?: boolean;
  verbose?: boolean;
}

export interface DirectSyncResult extends SyncResult {
  // New: the latest syncMarker observed across pages. Orchestrator persists
  // this back to workspace_connector_configs.sync_marker after a successful
  // run so the next run picks up where we left off.
  nextSyncMarker?: string | null;
}

/**
 * Direct-API sibling of `runConnector` (runner.ts). Pages through the
 * connector's `list`, optionally enriches via `detail`, maps via `toItem`,
 * persists via the same ingest pipeline, and surfaces the latest syncMarker
 * back to the orchestrator for round-tripping.
 *
 * Mirrors runner.ts shape for: error accumulation (per-item, non-fatal),
 * derivedItems / links emission, post-ingest crossref linking.
 *
 * Distinct from runner.ts: no MCP transport, no per-bucket incremental, no
 * postPass (Google adapters don't need it), no preview-skip pass (Gmail/Drive
 * `list` already pages by sync token, so the unchanged-skip dance is moot).
 */
export async function runDirectConnector(
  connector: DirectAPIConnector,
  opts: RunDirectOptions,
): Promise<DirectSyncResult> {
  await ensureInit();

  const since = opts.since ?? null;
  const limit = opts.limit ?? 20;
  const verbose = opts.verbose ?? false;
  const log = (msg: string) => {
    if (verbose) console.error(`[${connector.source}] ${msg}`);
  };

  log(`begin since=${since ?? 'never'} limit=${limit} marker=${opts.configRow.sync_marker ?? 'none'}`);

  // Resolve the OAuth token via the provider declared on the connector. The
  // configRow may pin a different provider (future-proofing) — prefer that if
  // present, else fall back to the connector's declared provider.
  const provider = opts.configRow.oauth_provider || connector.oauthProvider;
  let accessToken: string;
  try {
    accessToken = await getOAuthTokenByProvider(opts.workspaceId, provider);
  } catch (err: any) {
    return {
      source: connector.source,
      itemsSynced: 0,
      itemsUpdated: 0,
      itemsSkipped: 0,
      errors: [`${connector.source} oauth: ${err?.message || String(err)}`],
      nextSyncMarker: null,
    };
  }

  const collected: WorkItemInput[] = [];
  const pendingLinks: LinkInput[] = [];
  const errors: string[] = [];

  let cursor: string | null = null;
  let latestSyncMarker: string | null = opts.configRow.sync_marker ?? null;

  for (let page = 0; page < limit; page++) {
    const ctx: DirectRunContext = {
      since,
      cursor,
      limit: 100,
      env: process.env,
      options: opts.configRow.options ?? {},
      bucketLastSynced: {},
      accessToken,
      syncMarker: opts.configRow.sync_marker ?? null,
    };

    let pageResult: { items: unknown[]; cursor: string | null; syncMarker?: string };
    try {
      pageResult = await connector.list(ctx);
    } catch (err: any) {
      const msg = `${connector.source} list page ${page}: ${err?.message || String(err)}`;
      log(msg);
      errors.push(msg);
      break;
    }
    log(`page ${page}: got ${pageResult.items.length} raw items cursor=${pageResult.cursor ?? 'null'}`);

    if (pageResult.syncMarker) latestSyncMarker = pageResult.syncMarker;

    // Detail-fetch enrichment — sequential. Direct-API quotas (Gmail: ~250
    // QPU/sec, Drive: 1000 RPS, Calendar: 600 RPM) are per-user and parallel
    // detail calls would burn through them on big pages. Sequential is plenty
    // for v1 and avoids 429 storms; can revisit if Gmail full-thread sync
    // becomes a bottleneck.
    const resolved: unknown[] = new Array(pageResult.items.length);
    for (let i = 0; i < pageResult.items.length; i++) {
      const raw = pageResult.items[i];
      if (connector.detail) {
        try {
          resolved[i] = await connector.detail(raw, ctx);
        } catch (err: any) {
          errors.push(`${connector.source} detail: ${err?.message || String(err)}`);
          resolved[i] = raw;
        }
      } else {
        resolved[i] = raw;
      }
    }

    // Convert + collect items/links — same shape as runner.ts phase 2.
    for (let i = 0; i < resolved.length; i++) {
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
        errors.push(`${connector.source} toItem: ${err?.message || String(err)}`);
      }
    }

    if (!pageResult.cursor || pageResult.items.length === 0) break;
    cursor = pageResult.cursor;
  }

  log(`done collected=${collected.length} links=${pendingLinks.length} errors=${errors.length}`);

  if (opts.dryRun) {
    return {
      source: connector.source,
      itemsSynced: 0,
      itemsUpdated: 0,
      itemsSkipped: collected.length,
      errors: ['dry-run: ingest skipped', ...errors],
      nextSyncMarker: latestSyncMarker,
    };
  }

  if (collected.length === 0) {
    return {
      source: connector.source,
      itemsSynced: 0,
      itemsUpdated: 0,
      itemsSkipped: 0,
      errors,
      nextSyncMarker: latestSyncMarker,
    };
  }

  const result = await ingestItems(collected);

  // Pipeline-link matching for founder-preset workspaces. Failures must NOT
  // fail the ingest. (Phase D, spec 4.3)
  try {
    await persistPipelineLinksForItems(
      opts.workspaceId,
      collected.map((i) => ({
        source: i.source,
        source_id: i.source_id,
        title: i.title,
        metadata: i.metadata,
      })),
    );
  } catch (err: any) {
    log(`pipeline matching skipped: ${err?.message || String(err)}`);
  }

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
      errors.push(`${connector.source} links: ${err?.message || String(err)}`);
    }
  }

  // Cross-source linking — same as runner.ts. Keeps gmail/gdrive/gcal items
  // discoverable from Jira-key / GitHub-url mentions and vice versa.
  if (collected.length > 0) {
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
          errors.push(`${connector.source} crossref ${item.source_id}: ${err?.message || String(err)}`);
        }
      }
      log(`crossref processed=${processed} new-edges=${crossLinks}`);
    } catch (err: any) {
      log(`crossref skipped: ${err?.message || String(err)}`);
    }
  }

  if (errors.length) result.errors.push(...errors);
  return { ...result, nextSyncMarker: latestSyncMarker };
}
