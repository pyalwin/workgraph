import { config } from 'dotenv';
config({ path: '.env.local' });

import { existsSync } from 'fs';
import path from 'path';
import { getLibsqlDb } from '../src/lib/db/libsql';

async function scalar<T extends Record<string, unknown>>(sql: string): Promise<T> {
  const row = await getLibsqlDb().prepare(sql).get<T>();
  return (row ?? {}) as T;
}

async function main() {
  const defaultDb = path.join(process.cwd(), '..', 'workgraph.db');
  if (!process.env.DATABASE_URL && !existsSync(defaultDb)) {
    console.error('No DATABASE_URL is set and the default local DB does not exist:', defaultDb);
    process.exit(1);
  }

  const db = getLibsqlDb();

  console.log('=== Orphan PR matcher health ===');

  const trailCounts = await db
    .prepare(
      `SELECT match_status, kind, COUNT(*) AS count
       FROM issue_trails
       GROUP BY match_status, kind
       ORDER BY match_status, kind`,
    )
    .all<{ match_status: string; kind: string; count: number }>();
  console.log('\nissue_trails by status/kind');
  for (const r of trailCounts) console.log(`  ${r.match_status}/${r.kind}: ${r.count}`);

  const orphanStats = await scalar<{
    unmatched_opened: number;
    with_diff_text: number;
    with_functional_summary: number;
    with_candidates: number;
  }>(
    `SELECT
       COUNT(*) AS unmatched_opened,
       SUM(CASE WHEN diff_text IS NOT NULL THEN 1 ELSE 0 END) AS with_diff_text,
       SUM(CASE WHEN functional_summary IS NOT NULL THEN 1 ELSE 0 END) AS with_functional_summary,
       SUM(CASE WHEN EXISTS (
         SELECT 1 FROM orphan_pr_candidates c
         WHERE c.pr_ref = t.pr_ref AND c.dismissed_at IS NULL
       ) THEN 1 ELSE 0 END) AS with_candidates
     FROM issue_trails t
     WHERE match_status = 'unmatched' AND kind = 'pr_opened'`,
  );
  console.log('\nunmatched pr_opened rows');
  console.log(`  total: ${orphanStats.unmatched_opened ?? 0}`);
  console.log(`  with diff_text: ${orphanStats.with_diff_text ?? 0}`);
  console.log(`  with functional_summary: ${orphanStats.with_functional_summary ?? 0}`);
  console.log(`  with open candidates: ${orphanStats.with_candidates ?? 0}`);

  const chunkStats = await scalar<{
    jira_items: number;
    jira_items_with_chunks: number;
    jira_chunks: number;
    jira_vectors: number;
    all_vectors: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM work_items WHERE source = 'jira') AS jira_items,
       (SELECT COUNT(DISTINCT wi.id)
        FROM work_items wi JOIN item_chunks ic ON ic.item_id = wi.id
        WHERE wi.source = 'jira') AS jira_items_with_chunks,
       (SELECT COUNT(*)
        FROM item_chunks ic JOIN work_items wi ON wi.id = ic.item_id
        WHERE wi.source = 'jira') AS jira_chunks,
       (SELECT COUNT(*)
        FROM chunk_vectors cv
        JOIN item_chunks ic ON ic.id = cv.chunk_id
        JOIN work_items wi ON wi.id = ic.item_id
        WHERE wi.source = 'jira') AS jira_vectors,
       (SELECT COUNT(*) FROM chunk_vectors) AS all_vectors`,
  );
  console.log('\nJira vector coverage');
  console.log(`  Jira items: ${chunkStats.jira_items ?? 0}`);
  console.log(`  Jira items with chunks: ${chunkStats.jira_items_with_chunks ?? 0}`);
  console.log(`  Jira chunks: ${chunkStats.jira_chunks ?? 0}`);
  console.log(`  Jira vectors: ${chunkStats.jira_vectors ?? 0}`);
  console.log(`  all vectors: ${chunkStats.all_vectors ?? 0}`);

  const candidates = await db
    .prepare(
      `SELECT c.pr_ref, c.score, wi.source_id, wi.title
       FROM orphan_pr_candidates c
       JOIN work_items wi ON wi.id = c.candidate_item_id
       WHERE c.dismissed_at IS NULL
       ORDER BY c.computed_at DESC, c.score DESC
       LIMIT 10`,
    )
    .all<{ pr_ref: string; score: number; source_id: string; title: string }>();
  console.log('\nlatest open candidates');
  if (candidates.length === 0) console.log('  none');
  for (const c of candidates) {
    console.log(`  ${c.pr_ref} -> ${c.source_id} (${Math.round(c.score * 100)}%) ${c.title}`);
  }

  const samples = await db
    .prepare(
      `SELECT pr_ref, repo, title, actor, occurred_at,
              diff_text IS NOT NULL AS has_diff,
              functional_summary IS NOT NULL AS has_summary
       FROM issue_trails
       WHERE match_status = 'unmatched' AND kind = 'pr_opened'
       ORDER BY occurred_at DESC
       LIMIT 10`,
    )
    .all<{
      pr_ref: string;
      repo: string | null;
      title: string | null;
      actor: string | null;
      occurred_at: string;
      has_diff: number;
      has_summary: number;
    }>();
  console.log('\nlatest unmatched PRs');
  if (samples.length === 0) console.log('  none');
  for (const s of samples) {
    console.log(
      `  ${s.pr_ref} ${s.repo ?? ''} diff=${s.has_diff ? 'yes' : 'no'} summary=${s.has_summary ? 'yes' : 'no'} actor=${s.actor ?? '-'} ${s.title ?? ''}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
