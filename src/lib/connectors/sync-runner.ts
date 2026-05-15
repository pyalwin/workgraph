import { getConnector } from './registry';
import { connectMCP, resolveServerConfig } from './mcp-client';
import { getConnectorConfigBySource, markSyncStarted, markSyncFinished, upsertConnectorConfig } from './config-store';
import { runConnector } from './runner';
import { runDirectConnector } from './direct-runner';
import { getLibsqlDb } from '../db/libsql';
import type { SyncResult } from '../sync/types';
import type { Connector } from './types';

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
  // getConnector returns MCPConnector today; widen to the discriminated
  // Connector union here so the kind-branch typechecks. Phase C will move
  // this widening into the registry itself.
  const connector = getConnector(source) as unknown as Connector;
  const cfg = await getConnectorConfigBySource(workspaceId, source);
  const savedOptions = cfg?.config?.options ?? {};

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

  // Direct-API branch — skip MCP transport resolution entirely. The
  // direct-runner reads the OAuth token via getOAuthTokenByProvider, pages
  // through connector.list, and returns a nextSyncMarker we persist below.
  if (connector.kind === 'direct') {
    if (!cfg) {
      throw new Error(
        `No connector config for direct-API ${source} (workspace=${workspaceId}). Connect via OAuth first.`,
      );
    }

    // Cooldown check — if a prior run hit a provider rate-limit (daily
    // quota), options.rate_limit_until holds an ISO timestamp. Skip the
    // sync silently until the cooldown expires.
    const cooldownIso = (cfg.config?.options as Record<string, unknown> | undefined)?.rate_limit_until;
    if (typeof cooldownIso === 'string') {
      const until = Date.parse(cooldownIso);
      if (Number.isFinite(until) && until > Date.now()) {
        const remainingSec = Math.floor((until - Date.now()) / 1000);
        const skipMsg = `${source}: skipped (rate-limit cooldown ${remainingSec}s remaining until ${cooldownIso})`;
        console.warn(`[sync] ${skipMsg}`);
        await markSyncFinished(workspaceId, slot, { ok: true, itemsSynced: 0, error: null });
        return {
          itemsSynced: 0,
          itemsUpdated: 0,
          errors: [],
          links: [],
          ok: true,
          skipped: 'rate_limit_cooldown',
          cooldown_until: cooldownIso,
        } as any;
      }
      // Cooldown expired — clear it before resuming.
      try {
        const cleared = { ...(cfg.config?.options ?? {}) } as Record<string, unknown>;
        delete cleared.rate_limit_until;
        const db = getLibsqlDb();
        await db
          .prepare(
            `UPDATE workspace_connector_configs
             SET config = json_set(coalesce(config, '{}'), '$.options', json(?)),
                 updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(JSON.stringify(cleared), cfg.id);
      } catch {
        /* best-effort */
      }
    }

    await markSyncStarted(workspaceId, slot);
    let directResult: Awaited<ReturnType<typeof runDirectConnector>>;
    try {
      // Re-read the row so we get sync_marker / oauth_provider columns that
      // ConnectorConfig doesn't surface. Cheap; runs once per sync.
      const db = getLibsqlDb();
      const row = await db
        .prepare(
          'SELECT id, source, sync_marker, oauth_provider FROM workspace_connector_configs WHERE id = ?',
        )
        .get<{ id: string; source: string; sync_marker: string | null; oauth_provider: string | null }>(
          cfg.id,
        );
      if (!row) throw new Error(`connector_config row vanished: ${cfg.id}`);

      directResult = await runDirectConnector(connector, {
        workspaceId,
        configRow: {
          id: row.id,
          source: row.source,
          sync_marker: row.sync_marker,
          oauth_provider: row.oauth_provider,
          options: savedOptions,
        },
        since,
        limit: pageLimit,
        dryRun: false,
        verbose: true,
      });

      // Persist the new sync marker only on a successful run (no errors that
      // would invalidate the marker — e.g. a partial page fetch shouldn't
      // advance the cursor past items we never ingested).
      const realErrorsBeforePersist = (directResult.errors ?? []).filter(
        (e) => !e.startsWith('dry-run'),
      );
      if (
        directResult.nextSyncMarker &&
        directResult.nextSyncMarker !== row.sync_marker &&
        realErrorsBeforePersist.length === 0
      ) {
        const now = new Date().toISOString();
        await db
          .prepare(
            'UPDATE workspace_connector_configs SET sync_marker = ?, updated_at = ? WHERE id = ?',
          )
          .run(directResult.nextSyncMarker, now, row.id);
      }
    } catch (err: any) {
      const message = err?.message || String(err);
      // GoogleRateLimitError carries a recovery hint — store it in the
      // connector config options as a cooldown so any later sync attempt
      // skips this connector until the window expires. This is the
      // sync-side analog of agent_jobs.next_retry_at.
      if (err?.name === 'GoogleRateLimitError' && cfg) {
        try {
          const { GoogleRateLimitError } = await import('./google-fetch');
          if (err instanceof GoogleRateLimitError) {
            const cooldownUntil = new Date(Date.now() + err.retry_after_seconds * 1000).toISOString();
            const updatedOptions = { ...(cfg.config?.options ?? {}), rate_limit_until: cooldownUntil };
            const cooldownDb = getLibsqlDb();
            await cooldownDb
              .prepare(
                `UPDATE workspace_connector_configs
                 SET config = json_set(coalesce(config, '{}'), '$.options', json(?)),
                     updated_at = datetime('now')
                 WHERE id = ?`,
              )
              .run(JSON.stringify(updatedOptions), cfg.id);
            console.warn(
              `[sync] ${source}: ${err.reason ?? '?'} — cooldown until ${cooldownUntil} (${err.retry_after_seconds}s)`,
            );
          }
        } catch (cooldownErr) {
          console.warn('[sync] failed to record cooldown:', cooldownErr instanceof Error ? cooldownErr.message : String(cooldownErr));
        }
      }
      await markSyncFinished(workspaceId, slot, { ok: false, error: message });
      throw err;
    }

    const items = (directResult.itemsSynced ?? 0) + (directResult.itemsUpdated ?? 0);
    const realErrors = (directResult.errors ?? []).filter((e) => !e.startsWith('dry-run'));
    const ok = realErrors.length === 0;
    await markSyncFinished(workspaceId, slot, {
      ok,
      itemsSynced: items,
      error: realErrors.length ? realErrors.slice(0, 3).join('; ') : null,
    });
    return { ...directResult, ok };
  }

  // MCP branch (default): resolve transport, connect, run as before.
  const server = await resolveServerConfig(connector.serverId, source, workspaceId, process.env);
  if (!server) {
    throw new Error(
      `No MCP server config for ${connector.serverId} (workspace=${workspaceId}, source=${source})`,
    );
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
      // Resolve dynamic options before the list phase (e.g. Atlassian cloudId).
      // Persists any newly discovered values so subsequent syncs skip discovery.
      let resolvedOptions = savedOptions;
      if (connector.resolveOptions) {
        resolvedOptions = await connector.resolveOptions(client, savedOptions, process.env);
        const newCloudId = resolvedOptions.cloudId;
        if (newCloudId && newCloudId !== savedOptions.cloudId && cfg) {
          await upsertConnectorConfig({
            workspaceId,
            slot: cfg.slot,
            source,
            serverId: cfg.serverId,
            transport: cfg.transport,
            config: { ...cfg.config, options: resolvedOptions },
            status: cfg.status,
          });
        }
      }

      result = await runConnector(connector, {
        client,
        since,
        cursor: null,
        limit: pageLimit,
        pageSize: 100,
        dryRun: false,
        verbose: true,
        options: resolvedOptions,
        workspaceId,
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
