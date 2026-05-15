import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { rebuildPipelineMatchesAndGraph } from '@/lib/pipelines/graph-sync';

export const dynamic = 'force-dynamic';

/**
 * Full rebuild: re-runs pipeline matching against every existing gmail/gcal/
 * gdrive item (matching normally only fires at ingest time), then
 * materializes synthetic work_items + edges for every deal/investor/candidate
 * row. Idempotent.
 */
export async function POST() {
  await ensureSchemaAsync();
  const result = await rebuildPipelineMatchesAndGraph();
  return NextResponse.json({ ok: true, ...result });
}
