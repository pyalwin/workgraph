/**
 * Project-level action items refresh.
 *
 * Triggered by `workgraph/project.action-items.refresh` which the JIRA
 * sync pipeline fans out (one event per distinct project_key seen in
 * the workspace) after enrichment finishes.
 *
 * Concurrency capped at 1 per project so two parallel requests collapse.
 */
import { generateProjectActionItems } from '@/lib/sync/project-actions';
import { inngest } from '../client';

export const projectActionsRefresh = inngest.createFunction(
  {
    id: 'project-actions-refresh',
    name: 'Project · refresh AI action items',
    triggers: [{ event: 'workgraph/project.action-items.refresh' }],
    concurrency: { key: 'event.data.projectKey', limit: 1 },
    retries: 1,
  },
  async ({ event, step }) => {
    const { projectKey } = event.data as { projectKey: string };
    const result = await step.run('generate-and-persist', () =>
      generateProjectActionItems(projectKey),
    );
    return result;
  },
);
