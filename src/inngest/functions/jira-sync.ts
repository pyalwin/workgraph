/**
 * Phase 1.1 — scheduled JIRA sync orchestrator.
 *
 * Two functions:
 *   - jira.sync.tick    — cron every 30 min; lists enabled JIRA connectors
 *                         across all workspaces and fans out one event per.
 *   - jira.sync.workspace — event-triggered; triggers the actual MCP sync
 *                         via the existing orchestrator subprocess, polls
 *                         until completion, then runs the rich enrichment
 *                         pass over modified items.
 */
import { initSchema } from '@/lib/schema';
import { getDb } from '@/lib/db';
import { triggerSync } from '@/lib/connectors/sync-orchestrator';
import { recomputeIsMineForSource } from '@/lib/sync/identity';
import { enrichItemFully } from '@/lib/sync/enrich-rich';
import { inngest } from '../client';

const SYNC_TIMEOUT_MS = 10 * 60 * 1000; // 10 min hard cap
const ENRICH_BATCH = 25;

interface JiraConfigRow {
  workspaceId: string;
  slot: string;
  source: string;
  config: string; // JSON
  lastSyncCompletedAt: string | null;
  lastSyncStatus: string | null;
}

function listEnabledJiraConnectors(): JiraConfigRow[] {
  initSchema();
  const db = getDb();
  return db
    .prepare(
      `SELECT workspace_id AS workspaceId, slot, source, config,
              last_sync_completed_at AS lastSyncCompletedAt,
              last_sync_status AS lastSyncStatus
       FROM workspace_connector_configs
       WHERE source = 'jira' AND status != 'skipped'`,
    )
    .all() as JiraConfigRow[];
}

// ─── jira.sync.tick — every 30 min ────────────────────────────────────────

export const jiraSyncTick = inngest.createFunction(
  {
    id: 'jira-sync-tick',
    name: 'JIRA · scheduled sync tick',
    triggers: [
      { cron: '*/30 * * * *' },
      { event: 'workgraph/jira.sync.tick' },
    ],
  },
  async ({ step }) => {
    const configs = await step.run('list-enabled-connectors', () => {
      return listEnabledJiraConnectors().map((c) => ({
        workspaceId: c.workspaceId,
        slot: c.slot,
      }));
    });

    if (configs.length === 0) {
      return { fanOut: 0 };
    }

    await step.sendEvent(
      'fan-out-per-workspace',
      configs.map((c) => ({
        name: 'workgraph/jira.sync.workspace',
        data: c,
      })),
    );

    return { fanOut: configs.length };
  },
);

// ─── jira.sync.workspace — per-workspace pipeline ─────────────────────────

export const jiraSyncWorkspace = inngest.createFunction(
  {
    id: 'jira-sync-workspace',
    name: 'JIRA · sync + enrich for one workspace',
    triggers: [{ event: 'workgraph/jira.sync.workspace' }],
    // One per workspace+slot at a time — avoids racing the orchestrator's
    // in-flight map and keeps log files coherent.
    concurrency: { key: 'event.data.workspaceId + "::" + event.data.slot', limit: 1 },
  },
  async ({ event, step }) => {
    const data = event.data as { workspaceId: string; slot: string };
    const workspaceId = data.workspaceId;
    const slot = data.slot;

    // 1. Trigger the existing MCP-driven sync (fire-and-forget subprocess).
    const triggered = await step.run('trigger-sync', () => {
      return triggerSync(workspaceId, slot, 'jira');
    });

    if (!triggered.ok && !triggered.alreadyRunning) {
      throw new Error(`triggerSync returned not-ok: ${triggered.error ?? 'unknown'}`);
    }

    // 2. Poll until the sync writes a completion timestamp newer than the
    //    one we observed before kickoff. Cap at SYNC_TIMEOUT_MS.
    const startedAt = await step.run('snapshot-prev-completion', () => {
      const db = getDb();
      const row = db
        .prepare(
          `SELECT last_sync_completed_at AS at FROM workspace_connector_configs
           WHERE workspace_id = ? AND slot = ?`,
        )
        .get(workspaceId, slot) as { at: string | null } | undefined;
      return row?.at ?? null;
    });

    const start = Date.now();
    let completed = false;
    while (Date.now() - start < SYNC_TIMEOUT_MS) {
      await step.sleep('wait-30s', '30s');
      const status = await step.run(`poll-${Math.floor((Date.now() - start) / 30000)}`, () => {
        const db = getDb();
        return db
          .prepare(
            `SELECT last_sync_completed_at AS at, last_sync_status AS status
             FROM workspace_connector_configs WHERE workspace_id = ? AND slot = ?`,
          )
          .get(workspaceId, slot) as { at: string | null; status: string | null } | undefined;
      });
      if (status?.at && status.at !== startedAt && status.status !== 'running') {
        completed = true;
        break;
      }
    }

    if (!completed) {
      throw new Error(`Sync did not complete within ${SYNC_TIMEOUT_MS / 1000}s`);
    }

    // 3. Run the rich enrichment pass over items modified since last enrich.
    const enriched = await step.run('enrich-changed-items', async () => {
      initSchema();
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT id FROM work_items
           WHERE source = 'jira'
             AND (enriched_at IS NULL OR enriched_at < COALESCE(updated_at, created_at))
           ORDER BY COALESCE(updated_at, created_at) DESC
           LIMIT ?`,
        )
        .all(ENRICH_BATCH) as { id: string }[];

      let ok = 0;
      let failed = 0;
      for (const r of rows) {
        const result = await enrichItemFully(r.id, workspaceId);
        if (result.ok) ok++;
        else failed++;
      }
      return { ok, failed, total: rows.length };
    });

    // 4. Recompute is_mine for the workspace's auth user (if we have aliases
    //    seeded). If no aliases exist, this is a no-op.
    await step.run('recompute-is-mine', () => {
      // Pull the first auth_user that has any alias in this workspace.
      const db = getDb();
      const row = db
        .prepare(
          `SELECT auth_user_id FROM workspace_user_aliases
           WHERE workspace_id = ? LIMIT 1`,
        )
        .get(workspaceId) as { auth_user_id: string } | undefined;
      if (!row) return { skipped: 'no-aliases' };
      return recomputeIsMineForSource(workspaceId, row.auth_user_id, 'jira');
    });

    // 5. Fan out one project-action-items refresh per project. The function
    //    runs project-level (not per-ticket) action item synthesis to avoid
    //    duplicating the same logical action across siblings.
    const projectKeys = await step.run('list-distinct-projects', () => {
      const db = getDb();
      return (
        db
          .prepare(
            `SELECT DISTINCT json_extract(metadata, '$.entity_key') AS k
             FROM work_items
             WHERE source='jira' AND json_extract(metadata, '$.entity_key') IS NOT NULL`,
          )
          .all() as { k: string }[]
      ).map((r) => r.k);
    });

    if (projectKeys.length > 0) {
      await step.sendEvent(
        'fan-out-project-actions',
        projectKeys.map((projectKey) => ({
          name: 'workgraph/project.action-items.refresh',
          data: { projectKey },
        })),
      );
    }

    return { workspaceId, slot, enriched, projectsRefreshed: projectKeys.length };
  },
);
