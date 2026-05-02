/**
 * Chunk + embed pipeline — keeps the vector index current.
 *
 * Without this running, item_chunks stays empty, vec_chunks_text stays
 * empty, and downstream consumers that depend on embeddings silently
 * degrade:
 *   - unmatchedPrAiMatcher.ts produces zero matches (no candidates)
 *   - crossref.ts skips its embedding signal entirely
 *   - chat tool retrieval returns nothing
 *
 * Originally this lived only in scripts/process.ts as a CLI step. The
 * connector-sync comment ("downstream cron jobs (anomalies, embeddings)
 * pick them up on their own cadence") promised an embeddings cron that
 * was never written. This function fills that gap.
 *
 * Triggers:
 *   - cron 0,30 * * * * — every 30 minutes (cheap; only does pending work)
 *   - event workgraph/chunk-embed.run — fan-out after a sync completes
 */
import { inngest } from '../client';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { chunkAllPending } from '@/lib/chunking';
import { embedAllPending } from '@/lib/embeddings/embed';

export const chunkEmbedRun = inngest.createFunction(
  {
    id: 'chunk-embed-run',
    name: 'Embeddings · chunk & embed pending items',
    triggers: [
      // Half-hourly cadence keeps the matcher / cross-ref / chat tools
      // current without putting load on the embedding endpoint. If a sync
      // just landed, the next firing picks it up within 30 minutes; the
      // event trigger below short-circuits when fresher signal is needed.
      { cron: '0,30 * * * *' },
      { event: 'workgraph/chunk-embed.run' },
    ],
    // Single-flight — concurrent runs would chunk the same items and
    // duplicate embedding API calls.
    concurrency: { limit: 1 },
    retries: 1,
  },
  async ({ step }) => {
    await ensureSchemaAsync();

    const chunked = await step.run('chunk-pending', () =>
      chunkAllPending({ force: false }),
    );

    // No chunks pending and no chunks waiting on embeddings — early exit
    // saves an embedding-API round-trip that would have returned 0 work.
    const embedded = await step.run('embed-pending', async () => {
      // embedAllPending already filters to chunks lacking embedding meta.
      // Cap concurrency conservatively so we don't fan out hundreds of
      // simultaneous embedding requests on a back-filled DB.
      return embedAllPending({ concurrency: 4 });
    });

    return {
      chunked_items: chunked.items,
      chunked_chunks: chunked.chunks,
      embedded_chunks: embedded.embedded,
      failed_chunks: embedded.failed,
    };
  },
);
