/**
 * End-to-end verification for the GSuite knowledge-graph fixes.
 *
 * Run:   bun run scripts/gmail-graph-validate.ts
 *
 * What it does:
 *   1. Reports BEFORE counts (work_items by source, links, entity_mentions
 *      and tags for Gmail, embedding coverage)
 *   2. Runs the full enrichment pipeline: chunk → embed → LLM classify →
 *      crossref rerun → pipeline materialization
 *   3. Reports AFTER counts and the delta
 *
 * No HTTP, no auth — uses the libSQL DB the app uses. Same code paths the
 * `/api/enrichment/gmail` endpoint runs, just bypassing the auth layer.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

import { getLibsqlDb } from '../src/lib/db/libsql';
import { ensureSchemaAsync } from '../src/lib/db/init-schema-async';
import { chunkAllPending } from '../src/lib/chunking';
import { embedAllPending } from '../src/lib/embeddings/embed';
import { enrichAllGmailItems } from '../src/lib/enrichment/gmail';
import { createLinksForAll } from '../src/lib/crossref';
import { rebuildPipelineMatchesAndGraph } from '../src/lib/pipelines/graph-sync';
import { listWorkspaceConfigs } from '../src/lib/workspace-config';

interface Snapshot {
  workItemsBySource: Array<{ source: string; count: number }>;
  totalLinks: number;
  linksByType: Array<{ link_type: string; count: number }>;
  entityMentionsGmail: number;
  tagsByCategory: Array<{ category: string; count: number }>;
  gmailEnrichedCount: number;
  gmailWithChunks: number;
  gmailWithEmbeddings: number;
  pipelineLinks: number;
  pipelineNodes: number;
}

async function snapshot(label: string): Promise<Snapshot> {
  const db = getLibsqlDb();
  const workItemsBySource = await db
    .prepare(`SELECT source, COUNT(*) as count FROM work_items GROUP BY source ORDER BY count DESC`)
    .all<{ source: string; count: number }>();
  const totalLinksRow = await db.prepare(`SELECT COUNT(*) AS c FROM links`).get<{ c: number }>();
  const linksByType = await db
    .prepare(`SELECT link_type, COUNT(*) as count FROM links GROUP BY link_type ORDER BY count DESC`)
    .all<{ link_type: string; count: number }>();
  const entityMentionsGmail = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM entity_mentions em
       JOIN work_items wi ON wi.id = em.item_id WHERE wi.source = 'gmail'`,
    )
    .get<{ c: number }>();
  const tagsByCategory = await db
    .prepare(
      `SELECT category, COUNT(*) as count FROM tags
       WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC`,
    )
    .all<{ category: string; count: number }>();
  const gmailEnrichedRow = await db
    .prepare(`SELECT COUNT(*) AS c FROM work_items WHERE source='gmail' AND enriched_at IS NOT NULL`)
    .get<{ c: number }>();
  const gmailWithChunksRow = await db
    .prepare(
      `SELECT COUNT(DISTINCT wi.id) AS c FROM work_items wi
       JOIN item_chunks ic ON ic.item_id = wi.id WHERE wi.source='gmail'`,
    )
    .get<{ c: number }>();
  const gmailWithEmbedRow = await db
    .prepare(
      `SELECT COUNT(DISTINCT wi.id) AS c FROM work_items wi
       JOIN item_chunks ic ON ic.item_id = wi.id
       JOIN chunk_embeddings_meta ce ON ce.chunk_id = ic.id
       WHERE wi.source='gmail'`,
    )
    .get<{ c: number }>();
  const pipelineLinksRow = await db
    .prepare(`SELECT COUNT(*) AS c FROM pipeline_links`)
    .get<{ c: number }>()
    .catch(() => ({ c: 0 }));
  const pipelineNodesRow = await db
    .prepare(`SELECT COUNT(*) AS c FROM work_items WHERE source='pipeline'`)
    .get<{ c: number }>();

  console.log(`\n━━━━━ ${label} ━━━━━`);
  console.log('work_items by source:');
  workItemsBySource.forEach((r) => console.log(`  ${r.source.padEnd(12)} ${r.count}`));
  console.log(`links total:        ${totalLinksRow?.c ?? 0}`);
  if (linksByType.length) {
    console.log('links by type:');
    linksByType.forEach((r) => console.log(`  ${r.link_type.padEnd(20)} ${r.count}`));
  }
  console.log(`entity_mentions on gmail items: ${entityMentionsGmail?.c ?? 0}`);
  console.log('tags by category:');
  tagsByCategory.forEach((r) => console.log(`  ${r.category.padEnd(20)} ${r.count}`));
  console.log(`gmail enriched_at set:   ${gmailEnrichedRow?.c ?? 0}`);
  console.log(`gmail with chunks:       ${gmailWithChunksRow?.c ?? 0}`);
  console.log(`gmail with embeddings:   ${gmailWithEmbedRow?.c ?? 0}`);
  console.log(`pipeline_links rows:     ${pipelineLinksRow?.c ?? 0}`);
  console.log(`synthetic pipeline nodes:${pipelineNodesRow?.c ?? 0}`);

  return {
    workItemsBySource,
    totalLinks: totalLinksRow?.c ?? 0,
    linksByType,
    entityMentionsGmail: entityMentionsGmail?.c ?? 0,
    tagsByCategory,
    gmailEnrichedCount: gmailEnrichedRow?.c ?? 0,
    gmailWithChunks: gmailWithChunksRow?.c ?? 0,
    gmailWithEmbeddings: gmailWithEmbedRow?.c ?? 0,
    pipelineLinks: pipelineLinksRow?.c ?? 0,
    pipelineNodes: pipelineNodesRow?.c ?? 0,
  };
}

async function main() {
  await ensureSchemaAsync();

  const workspaces = await listWorkspaceConfigs();
  const target =
    workspaces.find((w) =>
      (w.customTables ?? []).some((t) => ['deals', 'investors', 'candidates'].includes(t.id)),
    ) || workspaces.find((w) => w.enabled) || workspaces[0];
  if (!target) {
    console.error('No workspace found.');
    process.exit(1);
  }
  console.log(`Workspace: ${target.id} (preset=${target.preset})`);

  const before = await snapshot('BEFORE');

  // 1. Enrich
  console.log('\n[1/4] Gmail enrichment (LLM classify + extract)…');
  const enrichArgs: Parameters<typeof enrichAllGmailItems>[1] = {};
  if (process.argv.includes('--force')) enrichArgs.force = true;
  if (process.argv.includes('--skip-llm')) enrichArgs.skipLlm = true;
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  if (limitArg) enrichArgs.limit = Number(limitArg.split('=')[1]);
  const er = await enrichAllGmailItems(target.id, enrichArgs);
  console.log(`   scanned=${er.scanned} enriched=${er.enriched} skipped=${er.skipped}`);

  // 2. Chunk + embed
  console.log('\n[2/4] Chunk + embed…');
  const chunk = await chunkAllPending({}).catch((e) => {
    console.error('   chunk error:', e.message);
    return { items: 0, chunks: 0 };
  });
  console.log(`   chunks: items=${chunk.items} chunks=${chunk.chunks}`);
  const embed = await embedAllPending({}).catch((e) => {
    console.error('   embed error:', e.message);
    return { embedded: 0, failed: 0 } as any;
  });
  console.log(`   embed:  ${JSON.stringify(embed)}`);

  // 3. Crossref rerun
  console.log('\n[3/4] Crossref rerun (all items)…');
  const start = Date.now();
  const cr = await createLinksForAll({});
  console.log(`   items=${cr.items} links=${cr.links} elapsed=${((Date.now() - start) / 1000).toFixed(1)}s`);

  // 4. Pipeline graph materialization
  console.log('\n[4/4] Pipeline graph materialization…');
  const pg = await rebuildPipelineMatchesAndGraph();
  console.log(`   itemsMatched=${pg.itemsMatched} scanned=${pg.scanned} synced=${pg.synced}`);

  const after = await snapshot('AFTER');

  console.log('\n━━━━━ DELTA ━━━━━');
  console.log(`links:                 ${before.totalLinks} → ${after.totalLinks}  (Δ ${after.totalLinks - before.totalLinks})`);
  console.log(`entity_mentions gmail: ${before.entityMentionsGmail} → ${after.entityMentionsGmail}  (Δ ${after.entityMentionsGmail - before.entityMentionsGmail})`);
  console.log(`gmail enriched:        ${before.gmailEnrichedCount} → ${after.gmailEnrichedCount}  (Δ ${after.gmailEnrichedCount - before.gmailEnrichedCount})`);
  console.log(`gmail chunked:         ${before.gmailWithChunks} → ${after.gmailWithChunks}  (Δ ${after.gmailWithChunks - before.gmailWithChunks})`);
  console.log(`gmail embedded:        ${before.gmailWithEmbeddings} → ${after.gmailWithEmbeddings}  (Δ ${after.gmailWithEmbeddings - before.gmailWithEmbeddings})`);
  console.log(`pipeline_links:        ${before.pipelineLinks} → ${after.pipelineLinks}  (Δ ${after.pipelineLinks - before.pipelineLinks})`);
  console.log(`pipeline nodes:        ${before.pipelineNodes} → ${after.pipelineNodes}  (Δ ${after.pipelineNodes - before.pipelineNodes})`);

  // Sample a few new gmail-gmail links to show the quality
  const db = getLibsqlDb();
  const newGmailLinks = await db
    .prepare(
      `SELECT l.confidence, l.link_type,
              a.title AS a_title, a.source AS a_src,
              b.title AS b_title, b.source AS b_src
       FROM links l
       JOIN work_items a ON a.id = l.source_item_id
       JOIN work_items b ON b.id = l.target_item_id
       WHERE a.source = 'gmail' AND b.source = 'gmail'
       ORDER BY l.created_at DESC
       LIMIT 10`,
    )
    .all<{ confidence: number; link_type: string; a_title: string; a_src: string; b_title: string; b_src: string }>();
  if (newGmailLinks.length > 0) {
    console.log('\nSample gmail↔gmail links (most recent 10):');
    for (const r of newGmailLinks) {
      console.log(`  [${r.confidence.toFixed(2)}] ${r.a_title.slice(0, 50)}  ↔  ${r.b_title.slice(0, 50)}`);
    }
  } else {
    console.log('\nNo gmail↔gmail links yet. Possible reasons:');
    console.log(' • LLM call failed (check OPENROUTER_API_KEY / AI_GATEWAY_API_KEY)');
    console.log(' • Embedding generation failed (check the embed: line above)');
    console.log(' • All gmail items share a single sender — check tags by category for "topic" entries');
  }

  const goalMet = after.totalLinks > before.totalLinks || after.entityMentionsGmail > before.entityMentionsGmail;
  console.log(`\nGOAL VERIFICATION: ${goalMet ? '✅ PASS' : '❌ NO CHANGE'} — ${goalMet ? 'enrichment produced new graph signal' : 'no new signal; investigate above'}`);
  process.exit(goalMet ? 0 : 2);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
