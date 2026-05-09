/**
 * project-backlog.refresh — listens for `workgraph/project.backlog.refresh`,
 * queues one `almanac.backlog` agent job per github repo bound to the project.
 *
 * The agent then runs Claude over each repo and POSTs items to
 * `/api/projects/<key>/backlog/ingest` (idempotent on stable id).
 *
 * Skips silently when:
 *   - the project has no github bindings (nothing to scan)
 *   - the project has no workspace_id we can resolve
 */

import { v4 as uuid } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { resolveAlmanacWorkspaceId } from '@/lib/almanac/workspace-resolver';
import { listProjectConnectors } from '@/lib/project-connectors';
import { inngest } from '../client';

export const projectBacklogRefresh = inngest.createFunction(
  {
    id: 'project-backlog-refresh',
    name: 'Project · backlog refresh',
    triggers: [{ event: 'workgraph/project.backlog.refresh' }],
    concurrency: { key: 'event.data.projectKey', limit: 1 },
  },
  async ({ event, step }) => {
    const data = event.data as { projectKey: string };
    const projectKey = (data.projectKey || '').toUpperCase();
    if (!projectKey) return { skipped: 'no projectKey' };

    const workspaceId = await step.run('resolve-workspace', () =>
      resolveAlmanacWorkspaceId(projectKey),
    );

    const githubBindings = await step.run('list-github-bindings', async () => {
      const all = await listProjectConnectors(workspaceId, projectKey);
      return all.filter((c) => c.kind === 'github');
    });

    if (githubBindings.length === 0) {
      return { skipped: 'no-github-bindings', projectKey };
    }

    const queued = await step.run('queue-jobs', async () => {
      await ensureSchemaAsync();
      const db = getLibsqlDb();
      const ids: string[] = [];
      for (const binding of githubBindings) {
        const repoKey = binding.ref;
        const ref = (binding.config?.['defaultBranch'] as string | undefined) ?? 'main';
        const params = JSON.stringify({ workspaceId, projectKey, repoKey, ref });
        const jobId = uuid();
        await db
          .prepare(
            `INSERT INTO agent_jobs (id, workspace_id, kind, status, params)
             VALUES (?, ?, 'almanac.backlog', 'queued', ?)`,
          )
          .run(jobId, workspaceId, params);
        ids.push(jobId);
      }
      return ids;
    });

    return { projectKey, repos: githubBindings.length, jobIds: queued };
  },
);
