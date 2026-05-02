/**
 * Scheduled JIRA sync orchestrator — fully durable inside Inngest.
 *
 * Two functions:
 *   - jira.sync.tick    — cron every 6 hours; lists enabled JIRA connectors
 *                         across all workspaces and fans out one event per.
 *   - jira.sync.workspace — event-triggered; runs the MCP sync inline as an
 *                         Inngest step (no subprocess, no polling), then
 *                         runs enrichment + project fan-outs.
 */
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { runConnectorSync } from '@/lib/connectors/sync-runner';
import { reapStaleSyncs } from '@/lib/connectors/config-store';
import { recomputeIsMineForSource } from '@/lib/sync/identity';
import { enrichItemFully } from '@/lib/sync/enrich-rich';
import { inngest } from '../client';

const ENRICH_BATCH = 25;

interface ConnectorConfigRow {
  workspaceId: string;
  slot: string;
  source: string;
}

async function listEnabledConnectors(): Promise<ConnectorConfigRow[]> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  return await db
    .prepare(
      `SELECT workspace_id AS workspaceId, slot, source
       FROM workspace_connector_configs
       WHERE status != 'skipped'`,
    )
    .all<ConnectorConfigRow>();
}

// ─── connector.sync.tick — every 6 hours, all connectors ───────────────────

export const jiraSyncTick = inngest.createFunction(
  {
    id: 'connector-sync-tick',
    name: 'Connectors · scheduled sync tick',
    triggers: [
      { cron: '0 */6 * * *' },
      { event: 'workgraph/jira.sync.tick' },
      { event: 'workgraph/connector.sync.tick' },
    ],
  },
  async ({ step }) => {
    const reaped = await step.run('reap-stale-syncs', () => reapStaleSyncs());

    const configs = await step.run('list-enabled-connectors', () => listEnabledConnectors());

    if (configs.length === 0) {
      return { fanOut: 0, reaped };
    }

    const events: Array<{ name: string; data: any }> = [];
    for (const c of configs) {
      if (c.source === 'jira') {
        events.push({
          name: 'workgraph/jira.sync.workspace',
          data: { workspaceId: c.workspaceId, slot: c.slot, source: c.source, since: null },
        });
      } else {
        events.push({
          name: 'workgraph/connector.sync.workspace',
          data: { workspaceId: c.workspaceId, slot: c.slot, source: c.source, since: null },
        });
      }
      if (c.source === 'github') {
        events.push({
          name: 'workgraph/github.trails.refresh',
          data: { workspaceId: c.workspaceId, slot: c.slot, since: null },
        });
      }
    }

    await step.sendEvent('fan-out-per-workspace', events);

    return { fanOut: events.length, reaped };
  },
);

// ─── jira.sync.workspace — per-workspace pipeline ─────────────────────────

export const jiraSyncWorkspace = inngest.createFunction(
  {
    id: 'jira-sync-workspace',
    name: 'JIRA · sync + enrich for one workspace',
    triggers: [{ event: 'workgraph/jira.sync.workspace' }],
    concurrency: { key: 'event.data.workspaceId + "::" + event.data.slot', limit: 1 },
  },
  async ({ event, step }) => {
    const data = event.data as {
      workspaceId: string;
      slot: string;
      since?: string | null;
    };
    const workspaceId = data.workspaceId;
    const slot = data.slot;
    const since = data.since ?? null;

    const syncResult = await step.run('run-sync', async () => {
      const result = await runConnectorSync(workspaceId, slot, 'jira', { since });
      return {
        ok: result.ok,
        itemsSynced: result.itemsSynced,
        itemsUpdated: result.itemsUpdated,
        itemsSkipped: result.itemsSkipped,
        errors: result.errors,
      };
    });

    if (!syncResult.ok) {
      console.warn(
        `[jira-sync] ${workspaceId}/${slot} completed with ${syncResult.errors.length} error(s):`,
        syncResult.errors.slice(0, 5),
      );
    }

    const enriched = await step.run('enrich-changed-items', async () => {
      await ensureSchemaAsync();
      const db = getLibsqlDb();
      const rows = await db
        .prepare(
          `SELECT id FROM work_items
           WHERE source = 'jira'
             AND (enriched_at IS NULL OR enriched_at < COALESCE(updated_at, created_at))
           ORDER BY COALESCE(updated_at, created_at) DESC
           LIMIT ?`,
        )
        .all<{ id: string }>(ENRICH_BATCH);

      let ok = 0;
      let failed = 0;
      for (const r of rows) {
        const result = await enrichItemFully(r.id, workspaceId);
        if (result.ok) ok++;
        else failed++;
      }
      return { ok, failed, total: rows.length };
    });

    await step.run('recompute-is-mine', async () => {
      const db = getLibsqlDb();
      const row = await db
        .prepare(
          `SELECT auth_user_id FROM workspace_user_aliases
           WHERE workspace_id = ? LIMIT 1`,
        )
        .get<{ auth_user_id: string }>(workspaceId);
      if (!row) return { skipped: 'no-aliases' };
      return recomputeIsMineForSource(workspaceId, row.auth_user_id, 'jira');
    });

    const projectKeys = await step.run('list-distinct-projects', async () => {
      const db = getLibsqlDb();
      const rows = await db
        .prepare(
          `SELECT DISTINCT json_extract(metadata, '$.entity_key') AS k
           FROM work_items
           WHERE source='jira' AND json_extract(metadata, '$.entity_key') IS NOT NULL`,
        )
        .all<{ k: string }>();
      return rows.map((r) => r.k);
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

    const readmeNeedingProjects = await step.run('list-projects-without-readme', async () => {
      const db = getLibsqlDb();
      const out: string[] = [];
      for (const projectKey of projectKeys) {
        const row = await db
          .prepare(`SELECT readme IS NOT NULL AS has FROM project_summaries WHERE project_key = ?`)
          .get<{ has: number }>(projectKey);
        if (!row?.has) out.push(projectKey);
      }
      return out;
    });

    if (readmeNeedingProjects.length > 0) {
      await step.sendEvent(
        'fan-out-project-readmes',
        readmeNeedingProjects.map((projectKey) => ({
          name: 'workgraph/project.readme.refresh',
          data: { projectKey },
        })),
      );
    }

    const okrNeedingProjects = await step.run('list-projects-needing-okrs', async () => {
      const db = getLibsqlDb();
      const out: string[] = [];
      for (const projectKey of projectKeys) {
        const hasReadme = await db
          .prepare(`SELECT readme IS NOT NULL AS has FROM project_summaries WHERE project_key = ?`)
          .get<{ has: number }>(projectKey);
        if (!hasReadme?.has) continue;
        const hasOkrs = await db
          .prepare(
            `SELECT COUNT(*) AS c FROM goals
             WHERE project_key = ? AND kind='objective' AND derived_from='ai_okr' AND status='active'`,
          )
          .get<{ c: number }>(projectKey);
        if (hasOkrs && hasOkrs.c === 0) out.push(projectKey);
      }
      return out;
    });

    if (okrNeedingProjects.length > 0) {
      await step.sendEvent(
        'fan-out-project-okrs',
        okrNeedingProjects.map((projectKey) => ({
          name: 'workgraph/project.okrs.refresh',
          data: { projectKey },
        })),
      );
    }

    const githubSlots = await step.run('list-github-slots', async () => {
      const db = getLibsqlDb();
      const rows = await db
        .prepare(
          `SELECT slot FROM workspace_connector_configs
           WHERE workspace_id = ? AND source = 'github' AND status != 'skipped'`,
        )
        .all<{ slot: string }>(workspaceId);
      return rows.map((r) => r.slot);
    });
    if (githubSlots.length > 0) {
      await step.sendEvent(
        'fan-out-github-trails',
        githubSlots.map((githubSlot) => ({
          name: 'workgraph/github.trails.refresh',
          data: { workspaceId, slot: githubSlot, since: null },
        })),
      );
    }

    if (syncResult.itemsSynced > 0 || syncResult.itemsUpdated > 0) {
      await step.sendEvent('fan-out-chunk-embed-jira', {
        name: 'workgraph/chunk-embed.run',
        data: { from: 'jira-sync', workspaceId, slot },
      });
    }

    return {
      workspaceId,
      slot,
      sync: syncResult,
      enriched,
      projectsRefreshed: projectKeys.length,
      readmesSeeded: readmeNeedingProjects.length,
      okrsSeeded: okrNeedingProjects.length,
      trailsFannedOut: githubSlots.length,
    };
  },
);
