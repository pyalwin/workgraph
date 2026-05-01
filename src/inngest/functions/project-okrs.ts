/**
 * Project OKRs refresh — durable AI generation via Inngest.
 *
 * Triggered by `workgraph/project.okrs.refresh`. Requires the project
 * README to exist; the JIRA pipeline therefore fans this out only AFTER
 * project-readme has had a chance to write one.
 */
import { generateProjectOKRs } from '@/lib/sync/project-okrs';
import { inngest } from '../client';

export const projectOkrsRefresh = inngest.createFunction(
  {
    id: 'project-okrs-refresh',
    name: 'Project · regenerate OKRs',
    triggers: [{ event: 'workgraph/project.okrs.refresh' }],
    concurrency: { key: 'event.data.projectKey', limit: 1 },
    retries: 1,
  },
  async ({ event, step }) => {
    const { projectKey } = event.data as { projectKey: string };
    const result = await step.run('generate-and-persist', () =>
      generateProjectOKRs(projectKey),
    );
    return result;
  },
);
