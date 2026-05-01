/**
 * Project README refresh — durable AI generation via Inngest.
 *
 * Triggered by `workgraph/project.readme.refresh`. The README is stable
 * (we don't auto-refresh it on every sync), so the JIRA pipeline only
 * fires this for projects that don't have a README yet. The user can
 * trigger a regeneration manually via the project page.
 */
import { generateProjectReadme } from '@/lib/sync/project-readme';
import { inngest } from '../client';

export const projectReadmeRefresh = inngest.createFunction(
  {
    id: 'project-readme-refresh',
    name: 'Project · regenerate README',
    triggers: [{ event: 'workgraph/project.readme.refresh' }],
    concurrency: { key: 'event.data.projectKey', limit: 1 },
    retries: 2,
  },
  async ({ event, step }) => {
    const { projectKey } = event.data as { projectKey: string };
    const result = await step.run('generate-and-persist', () =>
      generateProjectReadme(projectKey),
    );
    return result;
  },
);
