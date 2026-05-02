/**
 * GET /api/orphan-prs
 *
 * Lists every orphan PR (issue_trails.match_status='unmatched', kind='pr_opened')
 * along with its top-K Jira candidates from orphan_pr_candidates. Optional
 * query params:
 *   - repo:    filter by repo (e.g. "owner/repo")
 *   - project: filter to candidates whose Jira project key matches
 *   - has_candidates: if 'true', only return PRs that have ≥1 reviewable candidate
 *
 * Used by the project-page orphan-PR review modal.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

interface OrphanPrRow {
  trail_id: string;
  pr_ref: string;
  pr_url: string | null;
  repo: string | null;
  title: string | null;
  body: string | null;
  functional_summary: string | null;
  diff_summary: string | null;
  occurred_at: string;
  actor: string | null;
}

interface CandidateRow {
  pr_ref: string;
  candidate_item_id: string;
  score: number;
  signals: string;
  source_id: string;
  jira_title: string;
  jira_status: string | null;
  jira_url: string | null;
  jira_project: string | null;
}

export async function GET(req: NextRequest) {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const repoFilter = req.nextUrl.searchParams.get('repo');
  const projectFilter = req.nextUrl.searchParams.get('project');
  const hasCandidates = req.nextUrl.searchParams.get('has_candidates') === 'true';

  // Pull the orphan PRs first (the pr_opened row is the canonical event for
  // diff_text and functional_summary; siblings are reviews/merges).
  const conds: string[] = [
    `match_status = 'unmatched'`,
    `kind = 'pr_opened'`,
  ];
  const params: (string | number)[] = [];
  if (repoFilter) {
    conds.push(`repo = ?`);
    params.push(repoFilter);
  }

  const prs = await db
    .prepare(
      `SELECT id AS trail_id, pr_ref, pr_url, repo, title, body, functional_summary,
              diff_summary, occurred_at, actor
       FROM issue_trails
       WHERE ${conds.join(' AND ')}
       ORDER BY occurred_at DESC
       LIMIT 200`,
    )
    .all<OrphanPrRow>(...params);

  if (prs.length === 0) {
    return NextResponse.json({ orphans: [], total: 0 });
  }

  // Pull candidates for these refs in a single query. Filter to non-dismissed.
  const refs = prs.map((p) => p.pr_ref);
  const placeholders = refs.map(() => '?').join(',');
  const candidates = await db
    .prepare(
      `SELECT c.pr_ref, c.candidate_item_id, c.score, c.signals,
              wi.source_id, wi.title AS jira_title, wi.status AS jira_status, wi.url AS jira_url,
              json_extract(wi.metadata, '$.entity_key') AS jira_project
       FROM orphan_pr_candidates c
       JOIN work_items wi ON wi.id = c.candidate_item_id
       WHERE c.pr_ref IN (${placeholders})
         AND c.dismissed_at IS NULL
       ORDER BY c.pr_ref, c.score DESC`,
    )
    .all<CandidateRow>(...refs);

  // Group candidates by pr_ref and optionally filter by project.
  const byRef = new Map<string, CandidateRow[]>();
  for (const c of candidates) {
    if (projectFilter && c.jira_project !== projectFilter) continue;
    if (!byRef.has(c.pr_ref)) byRef.set(c.pr_ref, []);
    byRef.get(c.pr_ref)!.push(c);
  }

  const orphans = prs
    .map((pr) => ({
      trail_id: pr.trail_id,
      pr_ref: pr.pr_ref,
      pr_url: pr.pr_url,
      repo: pr.repo,
      title: pr.title,
      body: pr.body,
      functional_summary: pr.functional_summary,
      diff_summary: pr.diff_summary ? safeJson(pr.diff_summary) : null,
      occurred_at: pr.occurred_at,
      actor: pr.actor,
      candidates: (byRef.get(pr.pr_ref) ?? []).map((c) => ({
        item_id: c.candidate_item_id,
        source_id: c.source_id,
        title: c.jira_title,
        status: c.jira_status,
        url: c.jira_url,
        project: c.jira_project,
        score: c.score,
        signals: safeJson(c.signals),
      })),
    }))
    .filter((o) => (hasCandidates ? o.candidates.length > 0 : true));

  return NextResponse.json({ orphans, total: orphans.length });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
