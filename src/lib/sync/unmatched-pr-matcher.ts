/**
 * Long-tail attach: find Jira tickets for issue_trails rows that didn't carry
 * a Jira key in title/branch/body. Uses chunk-embedding similarity (the same
 * vector index crossref.ts uses for cross-source linking) plus a few cheap
 * structural signals.
 *
 * Runs weekly. Rows that flip to `match_status='ai_matched'` get their
 * sibling pr_review/pr_merged/pr_closed rows attached too, and a
 * workgraph/issue.pr-summary.refresh event is fan-out per matched ticket.
 */
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { searchChunks } from '../embeddings/embed';

const MATCH_THRESHOLD = 0.65;
// Below the auto-attach threshold but still plausible — surface for user
// review instead of dropping. Tuning: anything under ~0.4 tends to be
// noise (random text co-occurrence) so we keep that as the lower floor.
const REVIEW_THRESHOLD = 0.4;
const TOP_K_FOR_REVIEW = 3;
const SEARCH_K = 20;
const RECENT_DAYS_FOR_TEMPORAL = 60;

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

interface UnmatchedRow {
  id: string;
  pr_ref: string;
  repo: string | null;
  title: string | null;
  body: string | null;
  actor: string | null;
  occurred_at: string;
  diff_summary: string | null;
  diff_text: string | null;
  functional_summary: string | null;
}

interface CandidateScore {
  itemId: string;
  embedding: number;
  repo: number;
  temporal: number;
  total: number;
}

export interface UnmatchedMatcherResult {
  ok: boolean;
  scanned: number;
  matched: number;
  /** PRs that landed in orphan_pr_candidates for user review. */
  reviewable: number;
  errors: string[];
  movedIssueIds: string[];
}

function toScore(distance: number): number {
  // libSQL vector_distance_cos returns [0, 2] (1 - cosine_similarity).
  // Map to [0, 1] where 1 is most similar.
  return 1 - Math.min(1, Math.max(0, distance));
}

async function loadRecentRepoToProjects(): Promise<Map<string, Set<string>>> {
  const db = getLibsqlDb();
  const rows = await db
    .prepare(
      `SELECT t.repo AS repo, json_extract(w.metadata, '$.project') AS project
       FROM issue_trails t
       JOIN work_items w ON w.id = t.issue_item_id
       WHERE t.match_status = 'matched' AND w.source = 'jira'
       GROUP BY t.repo, project
       HAVING COUNT(*) >= 2`,
    )
    .all<{ repo: string | null; project: string | null }>();
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.repo || !r.project) continue;
    if (!map.has(r.repo)) map.set(r.repo, new Set());
    map.get(r.repo)!.add(r.project);
  }
  return map;
}

async function loadItemMeta(itemIds: string[]): Promise<Map<string, { project: string | null; updated_at: string | null }>> {
  if (itemIds.length === 0) return new Map();
  const db = getLibsqlDb();
  const placeholders = itemIds.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT id,
              json_extract(metadata, '$.project') AS project,
              updated_at
       FROM work_items WHERE id IN (${placeholders})`,
    )
    .all<{ id: string; project: string | null; updated_at: string | null }>(...itemIds);
  return new Map(rows.map((r) => [r.id, { project: r.project, updated_at: r.updated_at }]));
}

function temporalScore(prOccurred: string, ticketUpdated: string | null): number {
  if (!ticketUpdated) return 0;
  const a = Date.parse(prOccurred);
  const b = Date.parse(ticketUpdated);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  const days = Math.abs(a - b) / 86_400_000;
  if (days <= 7) return 1;
  if (days <= 30) return 0.7;
  if (days <= RECENT_DAYS_FOR_TEMPORAL) return 0.3;
  return 0;
}

function buildPrQueryText(row: UnmatchedRow): string {
  const parts: string[] = [];
  if (row.title) parts.push(row.title);
  if (row.body) parts.push(row.body);
  if (row.functional_summary) parts.push(row.functional_summary);
  if (row.diff_summary) {
    try {
      const d = JSON.parse(row.diff_summary);
      if (d.branch) parts.push(`branch ${d.branch}`);
    } catch {
      // ignore
    }
  }
  if (row.diff_text) parts.push(row.diff_text.slice(0, 2000));
  return parts.join('\n').slice(0, 6000);
}

export async function runUnmatchedPrMatcher(): Promise<UnmatchedMatcherResult> {
  await ensureInit();
  const db = getLibsqlDb();

  const rows = await db
    .prepare(
      `SELECT id, pr_ref, repo, title, body, actor, occurred_at, diff_summary,
              diff_text, functional_summary
       FROM issue_trails
       WHERE match_status = 'unmatched' AND kind = 'pr_opened'
       ORDER BY occurred_at DESC
       LIMIT 200`,
    )
    .all<UnmatchedRow>();

  if (rows.length === 0) {
    return { ok: true, scanned: 0, matched: 0, reviewable: 0, errors: [], movedIssueIds: [] };
  }

  const repoToProjects = await loadRecentRepoToProjects();
  const errors: string[] = [];
  const moved = new Set<string>();
  let matchedCount = 0;
  let reviewableCount = 0;

  const wipeCandidatesSql = `DELETE FROM orphan_pr_candidates WHERE pr_ref = ? AND dismissed_at IS NULL`;
  const insertCandidateSql = `INSERT OR REPLACE INTO orphan_pr_candidates
       (pr_ref, candidate_item_id, score, signals, computed_at, dismissed_at)
     VALUES (?, ?, ?, ?, datetime('now'), NULL)`;

  for (const row of rows) {
    const queryText = buildPrQueryText(row);
    if (queryText.trim().length < 20) continue;

    let hits;
    try {
      hits = await searchChunks(queryText, SEARCH_K, { source: 'jira' });
    } catch (err: any) {
      errors.push(`${row.pr_ref}: searchChunks: ${err.message}`);
      continue;
    }

    // Aggregate to per-item: keep best chunk distance per candidate item id.
    const byItem = new Map<string, number>();
    for (const h of hits) {
      const prev = byItem.get(h.item_id);
      if (prev == null || h.distance < prev) byItem.set(h.item_id, h.distance);
    }
    if (byItem.size === 0) continue;

    // Filter to Jira items only. The search itself is source-scoped too;
    // this remains as a defensive guard in case an older search backend
    // ignores the filter.
    const candidateIds = [...byItem.keys()];
    const placeholders = candidateIds.map(() => '?').join(',');
    const jiraRows = await db
      .prepare(
        `SELECT id FROM work_items WHERE id IN (${placeholders}) AND source = 'jira'`,
      )
      .all<{ id: string }>(...candidateIds);
    const jiraSet = new Set(jiraRows.map((r) => r.id));
    if (jiraSet.size === 0) continue;
    const jiraCandidateIds = [...jiraSet];

    const meta = await loadItemMeta(jiraCandidateIds);
    const allowedProjects = row.repo ? repoToProjects.get(row.repo) ?? null : null;

    const scored: CandidateScore[] = [];
    for (const itemId of jiraCandidateIds) {
      const distance = byItem.get(itemId)!;
      const m = meta.get(itemId);

      const embedding = toScore(distance);
      const repo = allowedProjects && m?.project && allowedProjects.has(m.project) ? 1 : 0;
      const temporal = temporalScore(row.occurred_at, m?.updated_at ?? null);
      const total = embedding * 0.65 + repo * 0.15 + temporal * 0.2;
      scored.push({ itemId, embedding, repo, temporal, total });
    }
    scored.sort((a, b) => b.total - a.total);
    const best = scored[0];
    if (!best) continue;

    if (best.total >= MATCH_THRESHOLD) {
      const evidence = JSON.stringify({
        source: 'ai_matcher',
        embedding: Number(best.embedding.toFixed(3)),
        repo: best.repo,
        temporal: best.temporal,
        total: Number(best.total.toFixed(3)),
      });
      await db
        .prepare(
          `UPDATE issue_trails
           SET issue_item_id = ?, match_status = 'ai_matched', match_confidence = ?, match_evidence = ?
           WHERE pr_ref = ? AND match_status = 'unmatched'`,
        )
        .run(best.itemId, Number(best.total.toFixed(3)), evidence, row.pr_ref);
      await db.prepare(wipeCandidatesSql).run(row.pr_ref);
      matchedCount++;
      moved.add(best.itemId);
      continue;
    }

    const reviewable = scored
      .filter((s) => s.total >= REVIEW_THRESHOLD)
      .slice(0, TOP_K_FOR_REVIEW);
    if (reviewable.length === 0) continue;

    await db.prepare(wipeCandidatesSql).run(row.pr_ref);
    for (const cand of reviewable) {
      await db.prepare(insertCandidateSql).run(
        row.pr_ref,
        cand.itemId,
        Number(cand.total.toFixed(3)),
        JSON.stringify({
          embedding: Number(cand.embedding.toFixed(3)),
          repo: cand.repo,
          temporal: cand.temporal,
        }),
      );
    }
    reviewableCount++;
  }

  return {
    ok: errors.length === 0,
    scanned: rows.length,
    matched: matchedCount,
    reviewable: reviewableCount,
    errors,
    movedIssueIds: [...moved],
  };
}
