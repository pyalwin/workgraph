import { v4 as uuidv4 } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { getConnectorConfigBySource } from '@/lib/connectors/config-store';
import { inngest } from '../client';

/**
 * Almanac · code_events backfill
 *
 * Runs weekly (Monday 05:00 UTC) or on demand via `workgraph/almanac.backfill`.
 * For each configured GitHub repo it enqueues an `almanac.code-events.extract`
 * job into `agent_jobs`, which the paired local agent picks up and executes.
 *
 * Re-runs within the same calendar day are idempotent: INSERT OR IGNORE on
 * the (agent_id, idempotency_key) unique constraint makes duplicate enqueues
 * a no-op.
 */

interface RepoEntry {
  id: string; // "owner/name"
}

interface BackfillCursor {
  last_sha: string | null;
  last_occurred_at: string | null;
}

interface AgentRow {
  agent_id: string;
}

/** Agent resolves repoPath from env or default ~/code/<name> — v1 convention */
interface JobParams {
  workspaceId: string;
  repo: string;
  repoPath: string | null;
  sinceIso: string | null;
  branch: string;
}

export const almanacCodeEventsBackfill = inngest.createFunction(
  {
    id: 'almanac-code-events-backfill',
    name: 'Almanac · code_events backfill',
    triggers: [
      { cron: '0 5 * * 1' }, // weekly Monday 05:00 UTC
      { event: 'workgraph/almanac.backfill' }, // manual trigger
    ],
    concurrency: [{ key: 'event.data.repo', limit: 1 }], // per-repo concurrency=1
  },
  async ({ event, step }) => {
    // Step 1 — resolve workspace
    const workspaceId = await step.run('resolve-workspace', async () => {
      return (event.data as { workspaceId?: string })?.workspaceId ?? 'default';
    });

    // Step 2 — resolve repos from github connector config
    const repos = await step.run('resolve-repos', async () => {
      await ensureSchemaAsync();
      const cfg = await getConnectorConfigBySource(workspaceId, 'github');
      if (!cfg) {
        console.log('[almanac-backfill] No github connector configured for workspace', workspaceId);
        return [] as RepoEntry[];
      }
      const all = (cfg.config.options?.repos as RepoEntry[] | undefined) ?? [];
      const filterRepo = (event.data as { repo?: string })?.repo;
      if (filterRepo) {
        return all.filter((r) => r.id === filterRepo);
      }
      return all;
    });

    if (repos.length === 0) {
      return { ok: true, repos: 0 };
    }

    // Step 3 — pick the most recently-seen online agent for the workspace
    // v1 pick — multi-tenant routing is a follow-up
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

    if (!agentId) {
      return { ok: false, reason: 'no_online_agent' };
    }

    // Step 4 — read per-repo backfill cursors
    const cursors = await step.run('read-cursors', async () => {
      const db = getLibsqlDb();
      const map: Record<string, BackfillCursor> = {};
      for (const repo of repos) {
        const row = await db
          .prepare(
            `SELECT last_sha, last_occurred_at FROM code_events_backfill_state WHERE repo = ?`,
          )
          .get<BackfillCursor>(repo.id);
        map[repo.id] = row ?? { last_sha: null, last_occurred_at: null };
      }
      return map;
    });

    // Step 5 — enqueue jobs (INSERT OR IGNORE — idempotent per repo per day)
    const enqueued = await step.run('enqueue-jobs', async () => {
      const db = getLibsqlDb();
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      let inserted = 0;

      for (const repo of repos) {
        const cursor = cursors[repo.id] ?? { last_sha: null, last_occurred_at: null };
        const sinceIso = cursor.last_occurred_at ?? null;

        const params: JobParams = {
          workspaceId,
          repo: repo.id,
          repoPath: null, // Agent resolves repoPath from env or default ~/code/<name> — v1 convention
          sinceIso,
          branch: 'main',
        };

        const idempotencyKey = `almanac-code-events-${repo.id}-${today}`;

        const result = await db
          .prepare(
            `INSERT OR IGNORE INTO agent_jobs (id, agent_id, kind, params, status, idempotency_key, created_at)
             VALUES (?, ?, ?, ?, 'queued', ?, datetime('now'))`,
          )
          .run(uuidv4(), agentId, 'almanac.code-events.extract', JSON.stringify(params), idempotencyKey);

        if (result.changes > 0) inserted++;
      }

      return inserted;
    });

    const skippedExisting = repos.length - enqueued;
    return { ok: true, repos: repos.length, enqueued, skipped_existing: skippedExisting };
  },
);
