/**
 * POST /api/orphan-tickets/[id]/match
 *   Re-run the ticket-code matcher on demand for one Jira ticket.
 *   Path param `id` = work_items.id.
 *
 * PATCH /api/orphan-tickets/[id]/match
 *   Accept or dismiss a specific candidate.
 *   Body: { candidate_id: number, action: 'accept' | 'dismiss' }
 */
import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { matchTicket, type OrphanTicket } from '@/lib/sync/ticket-code-matcher';

export const dynamic = 'force-dynamic';

// ─── shared helpers ──────────────────────────────────────────────────────────

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Re-fetch open candidates for a ticket and return the wire-format array. */
async function fetchCandidates(issueItemId: string) {
  const db = getLibsqlDb();
  interface CandRow {
    id: number;
    evidence_kind: string;
    tier_reached: string;
    candidate_ref: string;
    score: number;
    signals: string;
    computed_at: string;
    dismissed_at: string | null;
    accepted_at: string | null;
  }
  const rows = await db
    .prepare(
      `SELECT id, evidence_kind, tier_reached, candidate_ref, score, signals,
              computed_at, dismissed_at, accepted_at
       FROM orphan_ticket_candidates
       WHERE issue_item_id = ?
         AND dismissed_at IS NULL
         AND accepted_at IS NULL
       ORDER BY score DESC`,
    )
    .all<CandRow>(issueItemId);

  return rows.map((r) => ({
    id: r.id,
    evidence_kind: r.evidence_kind,
    tier_reached: r.tier_reached,
    candidate_ref: r.candidate_ref,
    score: r.score,
    signals: safeJson(r.signals),
    computed_at: r.computed_at,
    dismissed_at: r.dismissed_at,
    accepted_at: r.accepted_at,
  }));
}

// ─── POST — on-demand matcher run ────────────────────────────────────────────

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const { id } = await props.params;

  const workspaceId =
    (req.url ? new URL(req.url).searchParams.get('workspaceId') : null) ?? 'default';

  // Confirm the ticket exists and is a Jira work item.
  interface WorkItemRow {
    id: string;
    source_id: string;
    title: string;
    body: string | null;
    author: string | null;
    status: string | null;
    created_at: string;
    updated_at: string | null;
    metadata: string | null;
  }
  const row = await db
    .prepare(
      `SELECT id, source_id, title, body, author, status, created_at, updated_at, metadata
       FROM work_items
       WHERE id = ? AND source = 'jira'`,
    )
    .get<WorkItemRow>(id);

  if (!row) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  // Build the OrphanTicket shape expected by the matcher.
  const meta = row.metadata ? (safeJson(row.metadata) as Record<string, unknown> | null) : null;
  const ticket: OrphanTicket = {
    id: row.id,
    source_id: row.source_id,
    title: row.title,
    body: row.body ?? null,
    assignee: row.author ?? null,
    status: row.status ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
    project_key: (typeof meta?.entity_key === 'string' ? meta.entity_key : null) ?? row.source_id.replace(/-\d+$/, ''),
  };

  // Run the matcher; it writes candidates to orphan_ticket_candidates and may
  // auto-attach Tier-A hits — we re-fetch afterward to pick up any changes.
  await matchTicket(workspaceId, ticket);

  const candidates = await fetchCandidates(id);

  return NextResponse.json({
    issue_item_id: id,
    issue_key: row.source_id,
    candidates,
  });
}

// ─── PATCH — accept / dismiss a candidate ────────────────────────────────────

interface PatchBody {
  candidate_id?: unknown;
  action?: unknown;
}

export async function PATCH(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const { id: issueItemId } = await props.params;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const candidateId = typeof body.candidate_id === 'number' ? body.candidate_id : null;
  const action = body.action === 'accept' || body.action === 'dismiss' ? body.action : null;

  if (candidateId === null || action === null) {
    return NextResponse.json(
      { error: 'candidate_id (number) and action ("accept"|"dismiss") are required' },
      { status: 400 },
    );
  }

  interface CandidateRow {
    id: number;
    issue_item_id: string;
    evidence_kind: string;
    tier_reached: string;
    candidate_ref: string;
    score: number;
    signals: string;
    computed_at: string;
    dismissed_at: string | null;
    accepted_at: string | null;
  }

  // Verify the candidate belongs to this ticket.
  const candidate = await db
    .prepare(
      `SELECT id, issue_item_id, evidence_kind, tier_reached, candidate_ref,
              score, signals, computed_at, dismissed_at, accepted_at
       FROM orphan_ticket_candidates
       WHERE id = ? AND issue_item_id = ?`,
    )
    .get<CandidateRow>(candidateId, issueItemId);

  if (!candidate) {
    return NextResponse.json({ error: 'Candidate not found' }, { status: 404 });
  }

  // Guard against re-processing an already-resolved candidate.
  if (candidate.dismissed_at !== null || candidate.accepted_at !== null) {
    return NextResponse.json(
      { error: 'Candidate already accepted or dismissed' },
      { status: 409 },
    );
  }

  if (action === 'dismiss') {
    await db
      .prepare(
        `UPDATE orphan_ticket_candidates
         SET dismissed_at = datetime('now')
         WHERE id = ?`,
      )
      .run(candidateId);

    const updated = await db
      .prepare(`SELECT * FROM orphan_ticket_candidates WHERE id = ?`)
      .get<CandidateRow>(candidateId);

    return NextResponse.json({ candidate: updated });
  }

  // ── accept ────────────────────────────────────────────────────────────────

  // Stamp accepted_at first; we'll roll it back (null) if the code_event
  // is already linked to a different ticket.
  await db
    .prepare(
      `UPDATE orphan_ticket_candidates
       SET accepted_at = datetime('now')
       WHERE id = ?`,
    )
    .run(candidateId);

  // Resolve a code_events row from the candidate_ref, then link it.
  // Ref formats:
  //   PR:     "owner/repo#123"   → repo="owner/repo", pr_number=123
  //   commit: "owner/repo@<sha>" → repo="owner/repo", sha=<sha>
  //   branch: "owner/repo:<branch>" — no code_events row; accept is recorded only.
  const ref = candidate.candidate_ref;
  const prMatch = ref.match(/^(.+)#(\d+)$/);
  const commitMatch = !prMatch ? ref.match(/^(.+)@([0-9a-f]{7,40})$/i) : null;

  if (prMatch || commitMatch) {
    interface CodeEventRow {
      id: string;
      linked_item_id: string | null;
    }

    let ceRow: CodeEventRow | undefined;

    if (prMatch) {
      const [, repo, prNumStr] = prMatch;
      ceRow =
        (await db
          .prepare(
            `SELECT id, linked_item_id FROM code_events
             WHERE repo = ? AND pr_number = ?
             LIMIT 1`,
          )
          .get<CodeEventRow>(repo, parseInt(prNumStr, 10))) ?? undefined;
    } else if (commitMatch) {
      const [, repo, sha] = commitMatch;
      ceRow =
        (await db
          .prepare(
            `SELECT id, linked_item_id FROM code_events
             WHERE repo = ? AND sha = ?
             LIMIT 1`,
          )
          .get<CodeEventRow>(repo, sha)) ?? undefined;
    }

    if (ceRow) {
      // Conflict: the code event is already linked to a different ticket.
      if (ceRow.linked_item_id !== null && ceRow.linked_item_id !== issueItemId) {
        // Roll back the accepted_at stamp so the candidate remains reviewable.
        await db
          .prepare(
            `UPDATE orphan_ticket_candidates
             SET accepted_at = NULL
             WHERE id = ?`,
          )
          .run(candidateId);

        return NextResponse.json(
          { error: 'code_event_already_linked' },
          { status: 409 },
        );
      }

      // Link the code event to this ticket.
      await db
        .prepare(
          `UPDATE code_events
           SET linked_item_id       = ?,
               link_confidence      = ?,
               link_evidence        = ?,
               ticket_link_status   = 'human_linked'
           WHERE id = ?`,
        )
        .run(
          issueItemId,
          candidate.score,
          candidate.signals, // already JSON-encoded in the DB column
          ceRow.id,
        );
    }
  }
  // Branch evidence (no code_events row) — accepted_at already stamped above.

  const updated = await db
    .prepare(`SELECT * FROM orphan_ticket_candidates WHERE id = ?`)
    .get<CandidateRow>(candidateId);

  return NextResponse.json({ candidate: updated });
}
