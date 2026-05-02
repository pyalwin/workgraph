/**
 * Generic connector sync — for sources without a dedicated pipeline.
 *
 * The Jira flow (jira-sync.ts) does rich post-sync work (enrichment,
 * anomaly detection, project README/OKR/action-item fan-outs). For all
 * other sources (slack, github, notion, gdrive, …) we just want the items
 * pulled into the graph; downstream cron jobs (anomalies, embeddings)
 * pick them up on their own cadence.
 */
import { runConnectorSync } from '@/lib/connectors/sync-runner';
import { inngest } from '../client';

export const connectorSyncWorkspace = inngest.createFunction(
  {
    id: 'connector-sync-workspace',
    name: 'Connector · sync for one workspace+slot',
    triggers: [{ event: 'workgraph/connector.sync.workspace' }],
    concurrency: { key: 'event.data.workspaceId + "::" + event.data.slot', limit: 1 },
  },
  async ({ event, step }) => {
    const data = event.data as {
      workspaceId: string;
      slot: string;
      source: string;
      since?: string | null;
    };

    const result = await step.run('run-sync', async () => {
      const r = await runConnectorSync(data.workspaceId, data.slot, data.source, {
        since: data.since ?? null,
      });
      return {
        ok: r.ok,
        itemsSynced: r.itemsSynced,
        itemsUpdated: r.itemsUpdated,
        itemsSkipped: r.itemsSkipped,
        errors: r.errors,
      };
    });

    // Fresh items need to be chunked + embedded so the matcher / cross-ref /
    // chat retrieval pick them up. Half-hourly cron is the safety net; this
    // event makes the latency closer to "minutes after sync" instead of "up
    // to 30 minutes." The chunk-embed function is single-flight so concurrent
    // syncs collapse to one run.
    if (result.ok && (result.itemsSynced > 0 || result.itemsUpdated > 0)) {
      await step.sendEvent('fan-out-chunk-embed', {
        name: 'workgraph/chunk-embed.run',
        data: { from: 'connector-sync', workspaceId: data.workspaceId, slot: data.slot },
      });
    }

    return { ...data, sync: result };
  },
);
