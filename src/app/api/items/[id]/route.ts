import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

interface VersionRow {
  id: string;
  item_id: string;
  changed_fields: string;
  snapshot: string;
  changed_at: string;
}

interface LinkedItemRow {
  link_id: string;
  link_type: string;
  confidence: number;
  linked_item_id: string;
  title: string;
  body: string | null;
  source: string;
  source_id: string;
  item_type: string;
  author: string | null;
  status: string | null;
  url: string | null;
  created_at: string;
}

interface GoalRow {
  name: string;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureSchemaAsync();
    const { id } = await params;
    const db = getLibsqlDb();

    const itemRaw = await db
      .prepare(
        `SELECT id, source, source_id, item_type, title, body, summary, author, status,
                priority, url, metadata, created_at, updated_at,
                trace_role, substance, trace_event_at, enriched_at,
                pr_summary, pr_summary_generated_at,
                gap_analysis, gap_analysis_generated_at
         FROM work_items WHERE id = ?`,
      )
      .get<Record<string, unknown>>(id);

    if (!itemRaw) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    // gap_analysis is stored as a JSON string; parse it once here so the
    // drawer can render shipped/missing arrays without parsing client-side.
    const item = {
      ...itemRaw,
      gap_analysis: typeof itemRaw.gap_analysis === 'string' && itemRaw.gap_analysis
        ? safeJson(itemRaw.gap_analysis as string)
        : null,
    };

    // Version history
    const versions = await db
      .prepare(
        `SELECT id, item_id, changed_fields, snapshot, changed_at
         FROM work_item_versions
         WHERE item_id = ?
         ORDER BY changed_at DESC`,
      )
      .all<VersionRow>(id);

    // Linked items with full details, sorted chronologically.
    const linkedItems = await db
      .prepare(
        `WITH paired AS (
          SELECT l.id AS link_id, l.link_type, l.confidence,
            CASE WHEN l.source_item_id = ? THEN l.target_item_id ELSE l.source_item_id END AS linked_item_id
          FROM links l
          WHERE l.source_item_id = ? OR l.target_item_id = ?
        ),
        ranked AS (
          SELECT link_id, link_type, confidence, linked_item_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY linked_item_id, link_type
                   ORDER BY confidence DESC, link_id ASC
                 ) AS rn
          FROM paired
        )
        SELECT r.link_id, r.link_type, r.confidence, r.linked_item_id,
               wi.title, wi.body, wi.source, wi.source_id, wi.item_type, wi.author,
               wi.status, wi.url, wi.created_at
        FROM ranked r
        JOIN work_items wi ON wi.id = r.linked_item_id
        WHERE r.rn = 1
        ORDER BY wi.created_at ASC`,
      )
      .all<LinkedItemRow>(id, id, id);

    // Goal tags
    const goals = await db
      .prepare(
        `SELECT g.name FROM item_tags it JOIN goals g ON g.id = it.tag_id WHERE it.item_id = ?`,
      )
      .all<GoalRow>(id);

    // Workstream memberships
    const workstreamRows = await db
      .prepare(
        `SELECT ws.id, ws.narrative, ws.timeline_events, ws.earliest_at, ws.latest_at,
                wsi.is_seed, wsi.is_terminal, wsi.role_in_workstream
         FROM workstream_items wsi
         JOIN workstreams ws ON ws.id = wsi.workstream_id
         WHERE wsi.item_id = ?
         ORDER BY ws.latest_at DESC`,
      )
      .all<any>(id);
    const workstreams = workstreamRows.map((w) => ({
      ...w,
      timeline_events: w.timeline_events ? JSON.parse(w.timeline_events) : [],
    }));

    // Decisions this item is part of
    const decisionRows = await db
      .prepare(
        `SELECT d.id, d.item_id, d.title, d.decided_at, d.decided_by, d.status,
                d.summary, d.generated_at, di.relation
         FROM decisions d
         JOIN decision_items di ON di.decision_id = d.id
         WHERE di.item_id = ?
         ORDER BY d.decided_at DESC`,
      )
      .all<any>(id);
    const decisions = decisionRows.map((d) => ({
      ...d,
      summary: d.summary ? JSON.parse(d.summary) : null,
    }));

    // PR trail entries (issue_trails)
    const prTrailRows = await db
      .prepare(
        `SELECT id, pr_ref, pr_url, repo, kind, actor, title, body, state,
                diff_summary, occurred_at, match_status, match_confidence,
                functional_summary
         FROM issue_trails
         WHERE issue_item_id = ?
         ORDER BY occurred_at ASC`,
      )
      .all<any>(id);
    const prTrail = prTrailRows.map((t) => ({
      ...t,
      diff_summary: t.diff_summary ? JSON.parse(t.diff_summary) : null,
    }));

    // AI-extracted decisions from PR review threads.
    const prDecisions = await db
      .prepare(
        `SELECT id, trail_id, text, rationale, actor, decided_at, ai_confidence, derived_from
         FROM issue_decisions
         WHERE issue_item_id = ?
         ORDER BY decided_at ASC NULLS LAST, created_at ASC`,
      )
      .all(id);

    // PR-related anomalies for this item
    const prAnomalies = await db
      .prepare(
        `SELECT id, kind, severity, explanation, detected_at
         FROM anomalies
         WHERE scope = ? AND resolved_at IS NULL AND dismissed_by_user = 0
           AND kind IN ('impl_drift', 'incomplete_impl', 'unmerged_long')
         ORDER BY severity DESC`,
      )
      .all(`item:${id}`);

    return NextResponse.json({
      item,
      versions,
      linkedItems,
      goals,
      workstreams,
      decisions,
      prTrail,
      prDecisions,
      prAnomalies,
    });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
