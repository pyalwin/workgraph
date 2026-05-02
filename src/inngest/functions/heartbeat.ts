import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { inngest } from '../client';

/**
 * Heartbeat — fires every 5 minutes and writes one row to system_health.
 * Phase 0 sanity check: confirms the scheduling loop, the serve endpoint,
 * and the Drizzle write path all line up end-to-end.
 *
 * Also responds to a manual `workgraph/heartbeat.tick` event so we can
 * trigger it on demand from the Inngest dev UI.
 */
export const heartbeat = inngest.createFunction(
  {
    id: 'heartbeat',
    name: 'Workgraph heartbeat',
    triggers: [
      { cron: '*/5 * * * *' },
      { event: 'workgraph/heartbeat.tick' },
    ],
  },
  async ({ event, step }) => {
    const insertedId = await step.run('record-heartbeat', async () => {
      await ensureSchemaAsync();
      const db = getLibsqlDb();

      const detail = JSON.stringify({
        trigger: event.name === 'workgraph/heartbeat.tick' ? 'manual' : 'cron',
        node: process.version,
      });

      const result = await db
        .prepare(
          `INSERT INTO system_health (kind, detail) VALUES (?, ?) RETURNING id`,
        )
        .get<{ id: number }>('heartbeat', detail);

      // Bound the table — keep the last 1000 rows.
      await db
        .prepare(
          `DELETE FROM system_health WHERE id IN (
             SELECT id FROM system_health ORDER BY id DESC LIMIT -1 OFFSET 1000
           )`,
        )
        .run();

      // libsql can return ids as bigint — coerce so Inngest's JSON serialization
      // doesn't choke on it.
      return result?.id != null ? Number(result.id) : null;
    });

    return { ok: true, insertedId };
  },
);
