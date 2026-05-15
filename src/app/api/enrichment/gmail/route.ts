import { NextRequest, NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { enrichAllGmailItems } from '@/lib/enrichment/gmail';
import { createLinksForAll } from '@/lib/crossref';
import { chunkAllPending } from '@/lib/chunking';
import { embedAllPending } from '@/lib/embeddings/embed';
import { listWorkspaceConfigs } from '@/lib/workspace-config';
import { rebuildPipelineMatchesAndGraph } from '@/lib/pipelines/graph-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // allow long backfill — LLM-bound

/**
 * GET — observability snapshot. Returns counts that prove the LLM
 * enrichment pipeline has actually been delivered for Gmail items. Lets
 * the UI render an audit card without triggering work.
 */
export async function GET() {
  await ensureSchemaAsync();
  const { getLibsqlDb } = await import('@/lib/db/libsql');
  const db = getLibsqlDb();
  const [
    totalGmailRow,
    enrichedRow,
    chunkedRow,
    embeddedRow,
    entityRow,
    topicRow,
    categoryRow,
    summaryRow,
    linksRow,
  ] = await Promise.all([
    db.prepare(`SELECT COUNT(*) c FROM work_items WHERE source='gmail'`).get<{ c: number }>(),
    db.prepare(`SELECT COUNT(*) c FROM work_items WHERE source='gmail' AND enriched_at IS NOT NULL`).get<{ c: number }>(),
    db.prepare(`SELECT COUNT(DISTINCT wi.id) c FROM work_items wi JOIN item_chunks ic ON ic.item_id=wi.id WHERE wi.source='gmail'`).get<{ c: number }>(),
    db.prepare(`SELECT COUNT(DISTINCT wi.id) c FROM work_items wi JOIN item_chunks ic ON ic.item_id=wi.id JOIN chunk_embeddings_meta ce ON ce.chunk_id=ic.id WHERE wi.source='gmail'`).get<{ c: number }>(),
    db.prepare(`SELECT COUNT(*) c FROM entity_mentions em JOIN work_items wi ON wi.id=em.item_id WHERE wi.source='gmail'`).get<{ c: number }>(),
    db.prepare(`SELECT COUNT(*) c FROM tags WHERE category='topic'`).get<{ c: number }>(),
    db.prepare(`SELECT COUNT(*) c FROM tags WHERE category='gmail_category'`).get<{ c: number }>(),
    db.prepare(`SELECT COUNT(*) c FROM work_items WHERE source='gmail' AND summary IS NOT NULL AND summary != ''`).get<{ c: number }>(),
    db.prepare(`SELECT COUNT(*) c FROM links l JOIN work_items a ON a.id=l.source_item_id JOIN work_items b ON b.id=l.target_item_id WHERE a.source='gmail' OR b.source='gmail'`).get<{ c: number }>(),
  ]);
  return NextResponse.json({
    totalGmail: totalGmailRow?.c ?? 0,
    enriched: enrichedRow?.c ?? 0,
    chunked: chunkedRow?.c ?? 0,
    embedded: embeddedRow?.c ?? 0,
    entityMentions: entityRow?.c ?? 0,
    topicTags: topicRow?.c ?? 0,
    gmailCategoryTags: categoryRow?.c ?? 0,
    withSummary: summaryRow?.c ?? 0,
    gmailLinks: linksRow?.c ?? 0,
  });
}

/**
 * Backfill Gmail enrichment for every Gmail item:
 *
 *   1. Normalize authors, extract participant + domain entities (deterministic).
 *   2. LLM-classify category, topics, summary per thread.
 *   3. Rerun crossref against all items so the new entity/topic signals
 *      become actual graph edges.
 *   4. Re-materialize pipeline_links → graph edges so deals/investors/
 *      candidates see the freshly-classified threads.
 *
 * Optional query params:
 *   ?force=true       — re-enrich items already enriched
 *   ?skipLlm=true     — only run steps 1, 3, 4 (cheap, no LLM cost)
 *   ?skipCrossref=true — skip step 3 (faster turnaround)
 *   ?limit=N          — cap items processed
 */
export async function POST(req: NextRequest) {
  await ensureSchemaAsync();

  const url = new URL(req.url);
  const force = url.searchParams.get('force') === 'true';
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : 500;

  // Pick the first founder-shaped workspace (with deals/investors/candidates).
  // Falls back to the first enabled workspace if no founder preset present.
  const workspaces = await listWorkspaceConfigs();
  const target =
    workspaces.find((w) =>
      (w.customTables ?? []).some((t) =>
        ['deals', 'investors', 'people'].includes(t.id),
      ),
    ) || workspaces.find((w) => w.enabled) || workspaces[0];
  if (!target) {
    return NextResponse.json({ error: 'no_workspace' }, { status: 404 });
  }

  // Chunk + embed run inline — fast (no LLM, no rate-limit risk on local
  // embed) and required for the 40%-weighted similarity signal in crossref.
  let chunkResult: { items: number; chunks: number } | null = null;
  let embedResult: { embedded?: number; failed?: number } | null = null;
  try {
    chunkResult = await chunkAllPending({});
  } catch {
    chunkResult = { items: 0, chunks: 0 };
  }
  try {
    const r = await embedAllPending({});
    embedResult = { embedded: (r as any).embedded ?? 0, failed: (r as any).failed ?? 0 };
  } catch {
    embedResult = { embedded: 0, failed: 0 };
  }

  // LLM classification → dispatched to the local agent via Inngest. The
  // orchestrator fans out one agent_job per un-enriched thread (or all
  // when force=true). The agent polls, classifies via claude CLI, posts
  // result; the result handler writes tags/entities/summary and emits
  // agent/job.completed. The wave-complete listener then fires crossref
  // + pipeline graph rebuild — so the user just gets the enqueued count
  // here and watches the audit endpoint to track progress.
  const { inngest } = await import('@/inngest/client');
  await inngest.send({
    name: 'gmail/enrich.requested',
    data: { workspace_id: target.id, force, limit },
  });

  // How many will be enqueued? Quick read for the immediate response.
  const { getLibsqlDb } = await import('@/lib/db/libsql');
  const db = getLibsqlDb();
  const where = force ? '' : 'AND (enriched_at IS NULL)';
  const pendingRow = await db
    .prepare(
      `SELECT COUNT(*) c FROM (
         SELECT id FROM work_items WHERE source = 'gmail' ${where}
         ORDER BY created_at DESC LIMIT ?
       )`,
    )
    .get<{ c: number }>(limit);

  return NextResponse.json({
    ok: true,
    workspace: target.id,
    dispatched: pendingRow?.c ?? 0,
    chunk: chunkResult,
    embed: embedResult,
    note: 'Classification dispatched to local agent. Watch the green agent stream and the audit card for progress; crossref + pipeline rebuild fire automatically when the wave completes.',
  });
}
