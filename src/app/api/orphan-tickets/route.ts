/**
 * GET /api/orphan-tickets
 *
 * Lists Jira tickets that have at least one un-resolved code candidate
 * (dismissed_at IS NULL AND accepted_at IS NULL) in orphan_ticket_candidates.
 * The inverse of GET /api/orphan-prs: here the ticket is the orphan and the
 * code event (PR/branch/commit) is the candidate.
 *
 * Query params:
 *   - workspaceId: workspace filter (default 'default')
 *   - limit:       max tickets to return (default 50, cap 200)
 */
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export const dynamic = 'force-dynamic';

interface CandidateRow {
  id: number;
  issue_item_id: string;
  issue_key: string;
  title: string;
  status: string | null;
  project_key: string | null;
  evidence_kind: string;
  tier_reached: string;
  candidate_ref: string;
  score: number;
  signals: string;
  computed_at: string;
  dismissed_at: string | null;
  accepted_at: string | null;
}

export async function GET(req: NextRequest) {
  // Require a browser session — this is a human review surface.
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const workspaceId = req.nextUrl.searchParams.get('workspaceId') ?? 'default';
  const limitParam = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10);
  const limit = Math.min(isNaN(limitParam) ? 50 : limitParam, 200);

  // Single JOIN: pull all open candidates with their ticket metadata in one
  // pass; JS grouping avoids N+1 queries.
  const rows = await db
    .prepare(
      `SELECT
         c.id,
         c.issue_item_id,
         wi.source_id                               AS issue_key,
         wi.title,
         wi.status,
         json_extract(wi.metadata, '$.entity_key') AS project_key,
         c.evidence_kind,
         c.tier_reached,
         c.candidate_ref,
         c.score,
         c.signals,
         c.computed_at,
         c.dismissed_at,
         c.accepted_at
       FROM orphan_ticket_candidates c
       JOIN work_items wi
         ON wi.id = c.issue_item_id
        AND wi.source = 'jira'
       WHERE c.dismissed_at IS NULL
         AND c.accepted_at IS NULL
       ORDER BY c.score DESC
       LIMIT ?`,
    )
    .all<CandidateRow>(limit * 10); // fetch extra rows so grouping doesn't truncate tickets

  if (rows.length === 0) {
    return NextResponse.json({ tickets: [] });
  }

  // Group candidates by issue_item_id; preserve ticket order by max(score) DESC
  // (the ORDER BY c.score DESC above already surfaces highest-scored rows first,
  // so the first time we see an issue_item_id is always at its top score).
  const ticketOrder: string[] = [];
  const byTicket = new Map<
    string,
    {
      issue_item_id: string;
      issue_key: string;
      title: string;
      status: string | null;
      project_key: string | null;
      candidates: Array<{
        id: number;
        evidence_kind: string;
        tier_reached: string;
        candidate_ref: string;
        score: number;
        signals: unknown;
        computed_at: string;
        dismissed_at: string | null;
        accepted_at: string | null;
      }>;
    }
  >();

  for (const row of rows) {
    if (!byTicket.has(row.issue_item_id)) {
      ticketOrder.push(row.issue_item_id);
      byTicket.set(row.issue_item_id, {
        issue_item_id: row.issue_item_id,
        issue_key: row.issue_key,
        title: row.title,
        status: row.status,
        project_key: row.project_key ?? '',
        candidates: [],
      });
    }
    byTicket.get(row.issue_item_id)!.candidates.push({
      id: row.id,
      evidence_kind: row.evidence_kind,
      tier_reached: row.tier_reached,
      candidate_ref: row.candidate_ref,
      score: row.score,
      signals: safeJson(row.signals),
      computed_at: row.computed_at,
      dismissed_at: row.dismissed_at,
      accepted_at: row.accepted_at,
    });
  }

  // Apply the caller-supplied limit at the ticket level, not the row level.
  const tickets = ticketOrder.slice(0, limit).map((id) => byTicket.get(id)!);

  return NextResponse.json({ tickets });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
