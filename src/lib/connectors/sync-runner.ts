import { getConnector } from './registry';
import { connectMCP, resolveServerConfig } from './mcp-client';
import { getConnectorConfigBySource, markSyncStarted, markSyncFinished } from './config-store';
import { runConnector } from './runner';
import type { SyncResult } from '../sync/types';

export interface RunSyncOptions {
  /** ISO date, 'all' for full backfill, or null/undefined for per-bucket incremental. */
  since?: string | null;
  /** Page cap. Default 20. Backfills should pass a larger cap. */
  limit?: number;
}

export interface RunSyncSummary extends SyncResult {
  ok: boolean;
}

/**
 * In-process sync — connects MCP, runs the connector, persists results.
 * Designed to be called from inside an Inngest step so the entire sync is
 * durable and retryable as a single unit. Replaces the previous subprocess
 * + polling architecture (sync-orchestrator.ts).
 *
 * Throws on connect / config failure so Inngest will surface the step error
 * and retry. Connector-internal errors (per-page, per-item) are collected on
 * the result.errors array and recorded but do not throw.
 */
export async function runConnectorSync(
  workspaceId: string,
  slot: string,
  source: string,
  options: RunSyncOptions = {},
): Promise<RunSyncSummary> {
  const connector = getConnector(source);
  const cfg = await getConnectorConfigBySource(workspaceId, source);
  const savedOptions = cfg?.config?.options ?? {};

  const server = await resolveServerConfig(connector.serverId, source, workspaceId, process.env);
  if (!server) {
    throw new Error(
      `No MCP server config for ${connector.serverId} (workspace=${workspaceId}, source=${source})`,
    );
  }

  // Translate the orchestrator's 'full' / 'all' sentinel — adapters drop the
  // updated >= clause when since is empty string.
  let since: string | null = null;
  let pageLimit = options.limit ?? 20;
  if (options.since) {
    if (options.since === 'all' || options.since === 'full') {
      since = '';
      pageLimit = options.limit ?? 200;
    } else {
      since = options.since;
      pageLimit = options.limit ?? 200;
    }
  }

  await markSyncStarted(workspaceId, slot);

  // From this point we MUST reach markSyncFinished, otherwise the row is
  // stuck at status='running' and the UI/API will refuse retries. Wrap
  // both the connect and the run in try/catch so any failure (MCP unreachable,
  // OAuth expired, runConnector throwing) is recorded as an errored sync
  // rather than silently hung-running.
  let result: SyncResult;
  try {
    const client = await connectMCP(server);
    try {
      result = await runConnector(connector, {
        client,
        since,
        cursor: null,
        limit: pageLimit,
        pageSize: 100,
        dryRun: false,
        verbose: true,
        options: savedOptions,
      });
    } finally {
      try {
        await client.close();
      } catch {
        // closing a transport that's already torn down is fine
      }
    }
  } catch (err: any) {
    const message = err?.message || String(err);
    await markSyncFinished(workspaceId, slot, { ok: false, error: message });
    // Re-throw so Inngest records the failure on the run too — keeps the
    // step retry semantics intact.
    throw err;
  }

  const items = (result.itemsSynced ?? 0) + (result.itemsUpdated ?? 0);
  const realErrors = (result.errors ?? []).filter((e) => !e.startsWith('dry-run'));
  const ok = realErrors.length === 0;

  await markSyncFinished(workspaceId, slot, {
    ok,
    itemsSynced: items,
    error: realErrors.length ? realErrors.slice(0, 3).join('; ') : null,
  });

  return { ...result, ok };
}
