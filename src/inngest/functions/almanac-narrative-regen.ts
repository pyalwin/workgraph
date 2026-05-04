/**
 * Almanac · narrative regeneration (Phase 4 — KAN-46)
 *
 * Cron: 0 7 * * 1 (Monday 07:00 UTC — 1h after tickets-match at 06:00).
 * Manual: send event `workgraph/almanac.narrative.regen`.
 *
 * Steps:
 *   1. resolve-workspace   — from event.data.workspaceId or 'default'
 *   2. list-projects       — distinct project_keys with ≥1 functional_unit
 *   3. regenerate-{i}      — call regenerateSections() per project
 *
 * Concurrency: one run per workspace at a time.
 */
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { regenerateSections } from '@/lib/almanac/section-runner';
import { inngest } from '../client';

interface ProjectKeyRow {
  project_key: string;
}

export const almanacNarrativeRegen = inngest.createFunction(
  {
    id: 'almanac-narrative-regen',
    name: 'Almanac · narrative regeneration',
    triggers: [
      { cron: '0 7 * * 1' },                               // Monday 07:00 UTC
      { event: 'workgraph/almanac.narrative.regen' },      // manual trigger
    ],
    concurrency: [{ key: 'event.data.workspaceId', limit: 1 }],
  },
  async ({ event, step }) => {
    // Step 1 — resolve workspace from event payload or fall back to 'default'
    const workspaceId = await step.run('resolve-workspace', async () => {
      return (event.data as { workspaceId?: string })?.workspaceId ?? 'default';
    });

    // Step 2 — list all project_keys that have at least one functional_unit
    const projectKeys = await step.run('list-projects', async () => {
      await ensureSchemaAsync();
      const db = getLibsqlDb();
      const rows = await db
        .prepare(
          `SELECT DISTINCT project_key
           FROM functional_units
           WHERE workspace_id = ?
             AND project_key IS NOT NULL
             AND status = 'active'
           ORDER BY project_key ASC`,
        )
        .all<ProjectKeyRow>(workspaceId);
      return rows.map((r) => r.project_key);
    });

    if (projectKeys.length === 0) {
      console.log(`[almanac-narrative-regen] No projects with functional units for workspace ${workspaceId}`);
      return { ok: true, projects: 0 };
    }

    // Step 3..N — regenerate sections per project (one step each)
    const results: Record<string, unknown> = {};
    for (let i = 0; i < projectKeys.length; i++) {
      const projectKey = projectKeys[i];
      const result = await step.run(`regenerate-${i}`, async () => {
        try {
          const summary = await regenerateSections(workspaceId, projectKey);
          console.log(
            `[almanac-narrative-regen] project=${projectKey}`,
            summary,
          );
          return { ok: true, ...summary };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[almanac-narrative-regen] regenerateSections(${projectKey}) failed: ${msg}`);
          return { ok: false, error: msg };
        }
      });
      results[projectKey] = result;
    }

    return { ok: true, projects: projectKeys.length, results };
  },
);
