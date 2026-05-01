/**
 * Phase 1.4 follow-up — durable background regeneration for project AI summaries.
 *
 * The project page used to fire-and-forget the AI call via `void promise()`.
 * Next.js may end the request handler before the promise resolves, killing
 * the AI call mid-flight. Result: "Generating summary…" forever.
 *
 * Fix: dispatch a `workgraph/project-summary.regen` event from the page,
 * let Inngest run the AI call durably (with retries on failure), and write
 * the cache when done. Next page load reads the fresh value.
 */
import { generateAndStore } from '@/lib/project-summary';
import { inngest } from '../client';

export const projectSummaryRegen = inngest.createFunction(
  {
    id: 'project-summary-regen',
    name: 'Project · regenerate AI summary',
    triggers: [{ event: 'workgraph/project-summary.regen' }],
    // One regen per project at a time — concurrent triggers collapse.
    concurrency: { key: 'event.data.projectKey', limit: 1 },
    retries: 2,
  },
  async ({ event, step }) => {
    const data = event.data as { projectKey: string; projectName: string };
    const projectKey = data.projectKey;
    const projectName = data.projectName ?? projectKey;

    const summary = await step.run('generate-and-store', () =>
      generateAndStore(projectKey, projectName),
    );

    return { projectKey, length: summary.length };
  },
);
