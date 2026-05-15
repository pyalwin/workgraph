/**
 * Gmail enrichment orchestrator.
 *
 * Flow:
 *   1. Event 'gmail/enrich.requested' triggers gmailEnrichOrchestrator.
 *   2. Function queries un-enriched gmail items for the given workspace
 *      (or all if `force`), capped at `limit`.
 *   3. Fans out one `agent_jobs` row per thread (kind='gmail.classify')
 *      with the thread payload baked into params — the agent reads them
 *      directly without extra DB roundtrips.
 *   4. Per-workspace concurrency cap keeps a single workspace from
 *      monopolising the agent pool.
 *   5. When each job finishes, the result handler writes tags/entities/
 *      summary via persistGmailClassification and emits agent/job.completed.
 *   6. gmailEnrichComplete listens for completion events; when no jobs
 *      remain queued/assigned for this workspace, kicks off the follow-up
 *      crossref + pipeline graph rebuild.
 *
 * Incremental: only items with enriched_at IS NULL get enqueued unless
 * `force=true`. So clicking Run repeatedly is cheap — only new threads
 * (or failures whose enriched_at was never set) get re-tried.
 */
import { v4 as uuid } from 'uuid';
import { inngest } from '@/inngest/client';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

interface EnrichRequested {
  data: {
    workspace_id: string;
    force?: boolean;
    limit?: number;
  };
}

export const gmailEnrichOrchestrator = inngest.createFunction(
  {
    id: 'gmail-enrich-orchestrator',
    name: 'Gmail · enrich orchestrator',
    triggers: [{ event: 'gmail/enrich.requested' }],
    concurrency: { key: 'event.data.workspace_id', limit: 1 },
  },
  async ({ event, step }: { event: EnrichRequested; step: any }) => {
    const { workspace_id: workspaceId, force = false, limit = 500 } = event.data;

    const enqueued = await step.run('fan-out-agent-jobs', async (): Promise<{ enqueued: number; scanned: number }> => {
      await ensureSchemaAsync();
      const db = getLibsqlDb();

      const where = force ? '' : 'AND (enriched_at IS NULL)';
      const rows = await db
        .prepare(
          `SELECT id, source_id, title, body, author, metadata
           FROM work_items
           WHERE source = 'gmail' ${where}
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all<{
          id: string;
          source_id: string;
          title: string;
          body: string | null;
          author: string | null;
          metadata: string | null;
        }>(limit);

      let enqueued = 0;
      for (const r of rows) {
        // Body cap for params payload — keeps the JSON row small. Agent
        // gets ~8KB which is plenty for classification of a thread.
        const cappedBody = r.body ? r.body.slice(0, 8000) : null;
        const params = JSON.stringify({
          item_id: r.id,
          source_id: r.source_id,
          title: r.title,
          body: cappedBody,
          author: r.author,
          metadata: r.metadata ? JSON.parse(r.metadata) : null,
        });
        try {
          await db
            .prepare(
              `INSERT INTO agent_jobs (id, workspace_id, kind, status, params)
               VALUES (?, ?, 'gmail.classify', 'queued', ?)`,
            )
            .run(uuid(), workspaceId, params);
          enqueued += 1;
        } catch {
          /* best-effort per row */
        }
      }
      return { enqueued, scanned: rows.length };
    });

    return enqueued;
  },
);

/**
 * Listens for completion of any agent job. When a 'gmail.classify' job
 * completes AND no more queued/assigned jobs remain for the workspace,
 * fires the follow-up event to rerun crossref + rebuild the pipeline graph.
 *
 * Single-fire per "wave": the concurrency key dedups overlapping triggers,
 * and the queued/assigned check inside means only the last completion
 * actually triggers the follow-up.
 */
export const gmailEnrichOnComplete = inngest.createFunction(
  {
    id: 'gmail-enrich-on-complete',
    name: 'Gmail · trigger follow-up when batch done',
    triggers: [{ event: 'agent/job.completed' }],
    concurrency: { key: 'event.data.workspace_id', limit: 1 },
  },
  async ({ event, step }: { event: { data: { job_id: string; kind?: string; params?: Record<string, unknown> } }; step: any }) => {
    if (event.data.kind !== 'gmail.classify') return { skipped: true } as const;

    // Read params from the agent_jobs row directly (event params may be stale).
    const result = await step.run('check-and-followup', async () => {
      await ensureSchemaAsync();
      const db = getLibsqlDb();
      const job = await db
        .prepare(`SELECT workspace_id FROM agent_jobs WHERE id = ?`)
        .get<{ workspace_id: string }>(event.data.job_id);
      if (!job) return { ok: false, reason: 'job_not_found' } as const;

      // Are there any in-flight gmail.classify jobs left for this workspace?
      const inFlight = await db
        .prepare(
          `SELECT COUNT(*) c FROM agent_jobs
           WHERE workspace_id = ? AND kind = 'gmail.classify'
             AND status IN ('queued', 'assigned')`,
        )
        .get<{ c: number }>(job.workspace_id);
      if ((inFlight?.c ?? 0) > 0) {
        return { ok: true, deferred: true, in_flight: inFlight?.c ?? 0 } as const;
      }

      // All jobs done — trigger follow-up.
      await inngest.send({
        name: 'gmail/enrich.wave-complete',
        data: { workspace_id: job.workspace_id },
      });
      return { ok: true, triggered: true } as const;
    });
    return result;
  },
);

/**
 * After a wave of gmail.classify jobs all complete, run crossref + pipeline
 * graph rebuild. These are the steps that turn the new tags/entities/summaries
 * into actual graph edges + hub nodes.
 */
export const gmailEnrichWaveComplete = inngest.createFunction(
  {
    id: 'gmail-enrich-wave-complete',
    name: 'Gmail · rebuild graph after enrich wave',
    triggers: [{ event: 'gmail/enrich.wave-complete' }],
    concurrency: { key: 'event.data.workspace_id', limit: 1 },
  },
  async ({ event, step }: { event: { data: { workspace_id: string } }; step: any }) => {
    const crossref = await step.run('crossref', async () => {
      const { createLinksForAll } = await import('@/lib/crossref');
      return createLinksForAll({});
    });

    const pipeline = await step.run('pipeline-graph', async () => {
      const { rebuildPipelineMatchesAndGraph } = await import('@/lib/pipelines/graph-sync');
      return rebuildPipelineMatchesAndGraph();
    });

    return { crossref, pipeline };
  },
);
