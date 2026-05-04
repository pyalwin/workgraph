import { v4 as uuidv4 } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { getConnectorConfigBySource } from '@/lib/connectors/config-store';
import { resolveAgentForWorkspace } from '@/lib/almanac/agent-resolver';
import { inngest } from '../client';

/**
 * Almanac · noise classifier (Stage 2 LLM)
 *
 * Runs weekly (Monday 05:15 UTC — 15min after code-events backfill) or on
 * demand via `workgraph/almanac.noise-classify`. For each configured repo it
 * finds code_events where noise_class = 'signal' AND intent IS NULL (Stage 2
 * not yet run), chunks them into batches of 50, and enqueues
 * `almanac.noise.classify` agent_jobs for the local agent.
 *
 * Idempotent per repo per calendar day: INSERT OR IGNORE on the
 * (agent_id, idempotency_key) unique constraint makes duplicate enqueues a
 * no-op.
 */

interface RepoEntry {
  id: string; // "owner/name"
}

interface PendingEvent {
  id: string;
  sha: string;
  message: string | null;
  files_touched: string; // JSON string — parsed before sending to agent
}

const BATCH_SIZE = 50;

export const almanacNoiseClassify = inngest.createFunction(
  {
    id: 'almanac-noise-classify',
    name: 'Almanac · noise classifier (Stage 2 LLM)',
    triggers: [
      { cron: '15 5 * * 1' },                          // weekly — 15min after code-events backfill
      { event: 'workgraph/almanac.noise-classify' },   // manual trigger
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
        console.log('[almanac-noise-classify] No github connector configured for workspace', workspaceId);
        return [] as RepoEntry[];
      }
      const opts = cfg.config.options as
        | {
            repos?: (string | { id?: string })[];
            discovered?: { repos?: (string | { id?: string })[] };
          }
        | undefined;
      const raw = opts?.repos ?? opts?.discovered?.repos ?? [];
      const all: RepoEntry[] = raw
        .map((r) => (typeof r === 'string' ? { id: r } : r?.id ? { id: r.id } : null))
        .filter((r): r is RepoEntry => r !== null);
      const filterRepo = (event.data as { repo?: string })?.repo;
      if (filterRepo) {
        return all.filter((r) => r.id === filterRepo);
      }
      return all;
    });

    if (repos.length === 0) {
      return { ok: true, repos: 0 };
    }

    // Step 3 — pick the most recently-seen online agent (or 'all' slot)
    const agentId = await step.run('resolve-agent', async () => {
      return resolveAgentForWorkspace(workspaceId);
    });

    if (!agentId) {
      return { ok: false, reason: 'no_online_agent' };
    }

    // Step 4 — for each repo, find code_events that are signal but have no Stage 2 result yet
    const pendingByRepo = await step.run('find-pending', async () => {
      const db = getLibsqlDb();
      const map: Record<string, PendingEvent[]> = {};
      for (const repo of repos) {
        const rows = await db
          .prepare(
            `SELECT id, sha, message, files_touched
             FROM code_events
             WHERE repo = ?
               AND noise_class = 'signal'
               AND intent IS NULL
             LIMIT 1000`,
          )
          .all<PendingEvent>(repo.id);
        map[repo.id] = rows;
      }
      return map;
    });

    // Step 5 — chunk pending events into batches of 50 and enqueue agent_jobs
    const batchesEnqueued = await step.run('enqueue-jobs', async () => {
      const db = getLibsqlDb();
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      let inserted = 0;

      for (const repo of repos) {
        const events = pendingByRepo[repo.id] ?? [];
        if (events.length === 0) continue;

        // Chunk into batches of BATCH_SIZE
        for (let i = 0; i < events.length; i += BATCH_SIZE) {
          const chunk = events.slice(i, i + BATCH_SIZE);
          const batchIndex = Math.floor(i / BATCH_SIZE);

          const params = {
            workspaceId,
            repo: repo.id,
            events: chunk.map((e) => ({
              sha: e.sha,
              message: e.message,
              // Parse the stored JSON array before handing off to the agent
              files_touched: (() => {
                try { return JSON.parse(e.files_touched) as string[]; }
                catch { return [] as string[]; }
              })(),
            })),
          };

          // Deterministic per day per chunk — rerun on the same day is a no-op
          const idempotencyKey = `almanac-noise-${repo.id}-${today}-batch${batchIndex}`;

          const result = await db
            .prepare(
              `INSERT OR IGNORE INTO agent_jobs
                 (id, agent_id, kind, params, status, idempotency_key, created_at)
               VALUES (?, ?, ?, ?, 'queued', ?, datetime('now'))`,
            )
            .run(
              uuidv4(),
              agentId,
              'almanac.noise.classify',
              JSON.stringify(params),
              idempotencyKey,
            );

          if (result.changes > 0) inserted++;
        }
      }

      return inserted;
    });

    return {
      ok: true,
      repos: repos.length,
      batches_enqueued: batchesEnqueued,
    };
  },
);
