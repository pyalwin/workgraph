/**
 * POST /api/issue-trails/by-pr-ref/[ref]/attach
 *
 * The user has chosen which Jira ticket an orphan PR addresses. Flips
 * every issue_trails row for this pr_ref from match_status='unmatched'
 * to match_status='user_matched', sets issue_item_id, records the
 * choice as match_evidence, and clears the candidate review queue for
 * this PR.
 *
 * After attach, fans out an issue.pr-summary.refresh event so the new
 * Jira ticket's delivery summary picks up the freshly-attached PR.
 *
 * Body: { issue_item_id: string }
 *
 * The :ref param is URL-encoded ("owner%2Frepo%23123" →
 * "owner/repo#123"). Next.js decodes that for us.
 */
import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';

interface Body {
  issue_item_id?: unknown;
}

export async function POST(
  req: Request,
  props: { params: Promise<{ ref: string }> },
) {
  const params = await props.params;
  await ensureSchemaAsync();

  const prRef = decodeURIComponent(params.ref);
  if (!prRef.includes('#')) {
    return NextResponse.json(
      { ok: false, error: `Invalid pr_ref: ${prRef}` },
      { status: 400 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  const issueItemId = typeof body.issue_item_id === 'string' ? body.issue_item_id.trim() : '';
  if (!issueItemId) {
    return NextResponse.json({ ok: false, error: 'issue_item_id required' }, { status: 400 });
  }

  const db = getLibsqlDb();
  // Confirm the target ticket exists and is a Jira item — guards against
  // stale candidate lists pointing at deleted/migrated rows.
  const target = await db
    .prepare(`SELECT id, source FROM work_items WHERE id = ?`)
    .get<{ id: string; source: string }>(issueItemId);
  if (!target) {
    return NextResponse.json(
      { ok: false, error: 'Target work_item not found' },
      { status: 404 },
    );
  }
  if (target.source !== 'jira') {
    return NextResponse.json(
      { ok: false, error: 'Target must be a Jira work_item' },
      { status: 400 },
    );
  }

  const trailRows = await db
    .prepare(`SELECT id, kind, match_status FROM issue_trails WHERE pr_ref = ?`)
    .all<{ id: string; kind: string; match_status: string }>(prRef);
  if (trailRows.length === 0) {
    return NextResponse.json({ ok: false, error: `No trail rows for ${prRef}` }, { status: 404 });
  }

  // Look up the candidate row's signals so the new evidence carries them
  // forward — useful for auditing why the user picked this match.
  const candidate = await db
    .prepare(
      `SELECT score, signals FROM orphan_pr_candidates
       WHERE pr_ref = ? AND candidate_item_id = ?`,
    )
    .get<{ score: number; signals: string }>(prRef, issueItemId);

  const evidence = JSON.stringify({
    source: 'user_attach',
    chosen_at: new Date().toISOString(),
    candidate_score: candidate?.score ?? null,
    signals: candidate?.signals ? safeJson(candidate.signals) : null,
  });

  // Sequential async — original wrapped in db.transaction(). The two writes
  // are both idempotent on retry (UPDATE ... WHERE match_status='unmatched'
  // is a no-op the second time, DELETE is idempotent), so atomicity isn't
  // load-bearing here.
  await db
    .prepare(
      `UPDATE issue_trails
       SET issue_item_id = ?,
           match_status = 'user_matched',
           match_confidence = ?,
           match_evidence = ?
       WHERE pr_ref = ? AND match_status = 'unmatched'`,
    )
    .run(issueItemId, candidate?.score ?? 1.0, evidence, prRef);
  await db.prepare(`DELETE FROM orphan_pr_candidates WHERE pr_ref = ?`).run(prRef);

  // Refresh the destination ticket's delivery summary so it picks up the
  // newly-attached PR. Same event the AI matcher fans out.
  try {
    const workspaceId = await db
      .prepare(`SELECT DISTINCT workspace_id FROM workspace_user_aliases LIMIT 1`)
      .get<{ workspace_id: string }>();
    if (workspaceId) {
      await inngest.send({
        name: 'workgraph/issue.pr-summary.refresh',
        data: { issueItemId, workspaceId: workspaceId.workspace_id },
      });
    }
  } catch {
    // best-effort — the trail attach succeeded regardless
  }

  return NextResponse.json({
    ok: true,
    pr_ref: prRef,
    issue_item_id: issueItemId,
    rows_updated: trailRows.length,
  });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
