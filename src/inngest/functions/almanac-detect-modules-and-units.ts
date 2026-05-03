import { v4 as uuidv4 } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { getConnectorConfigBySource } from '@/lib/connectors/config-store';
import { detectModulesForRepo } from '@/lib/almanac/module-detector';
import { seedJiraEpicAliases } from '@/lib/almanac/jira-epic-aliases';
import { inngest } from '../client';

/**
 * Almanac · detect modules + cluster + name units
 *
 * Runs Monday 05:30 UTC (30 min after code-events backfill) or on demand.
 * Steps:
 *   1. Resolve workspace / repos / agent (same pattern as Phase 1.6).
 *   2. Server-side: detect modules per repo via file-path grouping.
 *   3. Server-side: seed functional_units rows for in-scope Jira epics.
 *   4. Enqueue almanac.units.cluster agent_jobs (one per repo).
 *   5. Enqueue almanac.units.name agent_jobs for unnamed co_change units (50 per batch).
 */

const UNIT_BATCH_SIZE = 50;
const SAMPLE_FILES_LIMIT = 5;
const SAMPLE_MESSAGES_LIMIT = 5;
// 12-month lookback for clustering
const CLUSTER_LOOKBACK_MONTHS = 12;

interface RepoEntry {
  id: string;
}

interface AgentRow {
  agent_id: string;
}

interface UnnamedUnit {
  id: string;
  file_path_patterns: string; // JSON string
}

interface SampleMessage {
  message: string | null;
}

export const almanacDetectModulesAndUnits = inngest.createFunction(
  {
    id: 'almanac-detect-modules-and-units',
    name: 'Almanac · detect modules + cluster + name units',
    triggers: [
      { cron: '30 5 * * 1' },                         // 30 min after code-events backfill
      { event: 'workgraph/almanac.detect-units' },    // manual trigger
    ],
    concurrency: [{ key: 'event.data.repo', limit: 1 }],
  },
  async ({ event, step }) => {
    // Step 1 — resolve workspace from event payload or fall back to default
    const workspaceId = await step.run('resolve-workspace', async () => {
      return (event.data as { workspaceId?: string })?.workspaceId ?? 'default';
    });

    // Step 2 — resolve repos from github connector config, with optional filter
    const repos = await step.run('resolve-repos', async () => {
      await ensureSchemaAsync();
      const cfg = await getConnectorConfigBySource(workspaceId, 'github');
      if (!cfg) {
        console.log('[almanac-detect-modules] No github connector for workspace', workspaceId);
        return [] as RepoEntry[];
      }
      const all = (cfg.config.options?.repos as RepoEntry[] | undefined) ?? [];
      const filterRepo = (event.data as { repo?: string })?.repo;
      if (filterRepo) return all.filter((r) => r.id === filterRepo);
      return all;
    });

    if (repos.length === 0) return { ok: true, repos: 0 };

    // Step 3 — resolve the most recently-seen online agent
    const agentId = await step.run('resolve-agent', async () => {
      const db = getLibsqlDb();
      const row = await db
        .prepare(
          `SELECT agent_id FROM workspace_agents
           WHERE workspace_id = ? AND status = 'online'
           ORDER BY last_seen_at DESC
           LIMIT 1`,
        )
        .get<AgentRow>(workspaceId);
      return row?.agent_id ?? null;
    });

    if (!agentId) return { ok: false, reason: 'no_online_agent' };

    // Step 4 — server-side module detection per repo
    const moduleResults = await step.run('detect-modules', async () => {
      const results: Record<string, { modules_upserted: number; events_assigned: number }> = {};
      for (const repo of repos) {
        results[repo.id] = await detectModulesForRepo(workspaceId, repo.id);
        console.log(
          `[almanac-detect-modules] repo=${repo.id}`,
          results[repo.id],
        );
      }
      return results;
    });

    // Step 5 — seed functional_units from Jira epics (no project filter — all in scope)
    const epicsAliased = await step.run('seed-jira-epics', async () => {
      const { aliased } = await seedJiraEpicAliases(workspaceId, null);
      console.log(`[almanac-detect-modules] jira_epics_aliased=${aliased}`);
      return aliased;
    });

    // Step 6 — enqueue almanac.units.cluster jobs per repo
    const clusterJobs = await step.run('enqueue-cluster-jobs', async () => {
      const db = getLibsqlDb();
      const today = new Date().toISOString().slice(0, 10);
      // ISO date 12 months ago for the agent's lookback window
      const sinceDate = new Date();
      sinceDate.setMonth(sinceDate.getMonth() - CLUSTER_LOOKBACK_MONTHS);
      const sinceIso = sinceDate.toISOString();

      let inserted = 0;
      for (const repo of repos) {
        const params = { workspaceId, repo: repo.id, sinceIso };
        const idempotencyKey = `almanac-cluster-${repo.id}-${today}`;

        const result = await db
          .prepare(
            `INSERT OR IGNORE INTO agent_jobs
               (id, agent_id, kind, params, status, idempotency_key, created_at)
             VALUES (?, ?, ?, ?, 'queued', ?, datetime('now'))`,
          )
          .run(
            uuidv4(),
            agentId,
            'almanac.units.cluster',
            JSON.stringify(params),
            idempotencyKey,
          );

        if (result.changes > 0) inserted++;
      }
      return inserted;
    });

    // Step 7 — enqueue almanac.units.name jobs for unnamed co_change units
    const nameJobs = await step.run('enqueue-name-jobs', async () => {
      const db = getLibsqlDb();
      const today = new Date().toISOString().slice(0, 10);

      let inserted = 0;
      for (const repo of repos) {
        // Find unnamed co_change units that have at least one code_event in this repo
        const unnamedUnits = await db
          .prepare(
            `SELECT DISTINCT fu.id, fu.file_path_patterns
             FROM functional_units fu
             JOIN code_events ce ON ce.functional_unit_id = fu.id
             WHERE fu.workspace_id = ?
               AND fu.name IS NULL
               AND fu.detected_from = 'co_change'
               AND ce.repo = ?`,
          )
          .all<UnnamedUnit>(workspaceId, repo.id);

        if (unnamedUnits.length === 0) continue;

        // Chunk into batches of UNIT_BATCH_SIZE
        for (let i = 0; i < unnamedUnits.length; i += UNIT_BATCH_SIZE) {
          const chunk = unnamedUnits.slice(i, i + UNIT_BATCH_SIZE);
          const batchIndex = Math.floor(i / UNIT_BATCH_SIZE);

          // Build lightweight unit summaries for the naming agent
          const units = await Promise.all(
            chunk.map(async (unit) => {
              // Parse file paths, take the first SAMPLE_FILES_LIMIT
              let allFiles: string[] = [];
              try {
                allFiles = JSON.parse(unit.file_path_patterns) as string[];
              } catch {
                allFiles = [];
              }
              const sampleFiles = allFiles.slice(0, SAMPLE_FILES_LIMIT);

              // Pull sample messages from most-recent events in this unit
              const msgs = await db
                .prepare(
                  `SELECT message
                   FROM code_events
                   WHERE functional_unit_id = ? AND repo = ? AND message IS NOT NULL
                   ORDER BY occurred_at DESC
                   LIMIT ?`,
                )
                .all<SampleMessage>(unit.id, repo.id, SAMPLE_MESSAGES_LIMIT);

              return {
                unit_id: unit.id,
                sample_files: sampleFiles,
                sample_messages: msgs.map((m) => m.message).filter(Boolean),
              };
            }),
          );

          const params = { workspaceId, repo: repo.id, units };
          const idempotencyKey = `almanac-name-${repo.id}-${today}-batch${batchIndex}`;

          const result = await db
            .prepare(
              `INSERT OR IGNORE INTO agent_jobs
                 (id, agent_id, kind, params, status, idempotency_key, created_at)
               VALUES (?, ?, ?, ?, 'queued', ?, datetime('now'))`,
            )
            .run(
              uuidv4(),
              agentId,
              'almanac.units.name',
              JSON.stringify(params),
              idempotencyKey,
            );

          if (result.changes > 0) inserted++;
        }
      }

      return inserted;
    });

    const totalModules = Object.values(moduleResults).reduce(
      (acc, r) => acc + r.modules_upserted,
      0,
    );

    return {
      ok: true,
      modules_for: repos.length,
      modules_upserted: totalModules,
      epics_aliased: epicsAliased,
      cluster_jobs: clusterJobs,
      name_jobs: nameJobs,
    };
  },
);
