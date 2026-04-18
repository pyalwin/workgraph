/**
 * Decision extraction: for each work_item with trace_role='decision',
 * build a decision record with upstream (what led to it) + downstream
 * (what flowed from it) source items.
 *
 * Source items are collected via the link graph + workstream membership.
 * Relation values:
 *   - 'origin'      — seed(s) that triggered the workstream
 *   - 'discussion'  — items discussing the decision before it was made
 *   - 'self'        — the decision item itself
 *   - 'specification' — spec items derived from the decision
 *   - 'implementation' — PRs / commits implementing the spec
 *   - 'review'      — PR reviews
 *   - 'integration' — merged/shipped artifacts
 *   - 'follow_up'   — retrospective issues raised after integration
 */
import { getDb } from '../db';
import { v4 as uuid } from 'uuid';

interface ItemRow {
  id: string;
  source: string;
  item_type: string;
  title: string;
  author: string | null;
  trace_role: string | null;
  trace_event_at: string | null;
  created_at: string;
}

interface DecisionCore {
  id: string;
  item_id: string;
  workstream_id: string | null;
  title: string;
  decided_at: string;
  decided_by: string | null;
}

const UPSTREAM_ROLES = new Set(['seed', 'discussion']);
const DOWNSTREAM_ROLES: Record<string, 'specification' | 'implementation' | 'review' | 'integration' | 'follow_up'> = {
  specification: 'specification',
  implementation: 'implementation',
  review: 'review',
  integration: 'integration',
  follow_up: 'follow_up',
};

function loadItem(id: string): ItemRow | null {
  return getDb().prepare(`
    SELECT id, source, item_type, title, author, trace_role, trace_event_at, created_at
    FROM work_items WHERE id = ?
  `).get(id) as ItemRow | null;
}

function eventAtOf(item: ItemRow): string {
  return item.trace_event_at ?? item.created_at;
}

/**
 * Walk the link graph + workstream membership to gather related items,
 * bucketed by their role relative to the decision (upstream / downstream).
 */
function collectRelatedItems(decisionItem: ItemRow, workstreamId: string | null): Array<{ item: ItemRow; relation: string }> {
  const db = getDb();
  const out = new Map<string, { item: ItemRow; relation: string }>();

  // Workstream members first (most authoritative)
  if (workstreamId) {
    const members = db.prepare(`
      SELECT wi.id FROM workstream_items wsi
      JOIN work_items wi ON wi.id = wsi.item_id
      WHERE wsi.workstream_id = ? AND wi.id != ?
    `).all(workstreamId, decisionItem.id) as { id: string }[];
    for (const m of members) {
      const item = loadItem(m.id);
      if (!item) continue;
      const rel = classifyRelation(item, decisionItem);
      if (rel) out.set(item.id, { item, relation: rel });
    }
  }

  // Direct link neighbors (catch items not in the workstream but linked)
  const neighbors = db.prepare(`
    SELECT target_item_id AS id FROM links WHERE source_item_id = ? AND confidence >= 0.6
    UNION
    SELECT source_item_id AS id FROM links WHERE target_item_id = ? AND confidence >= 0.6
  `).all(decisionItem.id, decisionItem.id) as { id: string }[];
  for (const n of neighbors) {
    if (n.id === decisionItem.id || out.has(n.id)) continue;
    const item = loadItem(n.id);
    if (!item) continue;
    const rel = classifyRelation(item, decisionItem);
    if (rel) out.set(item.id, { item, relation: rel });
  }

  return [...out.values()];
}

function classifyRelation(candidate: ItemRow, decisionItem: ItemRow): string | null {
  if (!candidate.trace_role) return null;
  const cTime = eventAtOf(candidate);
  const dTime = eventAtOf(decisionItem);

  if (candidate.trace_role === 'seed') return 'origin';
  if (UPSTREAM_ROLES.has(candidate.trace_role)) {
    return cTime <= dTime ? 'discussion' : null;
  }
  const downstream = DOWNSTREAM_ROLES[candidate.trace_role];
  if (downstream) {
    return cTime >= dTime ? downstream : null;
  }
  return null;
}

function inferStatus(related: Array<{ item: ItemRow; relation: string }>): 'active' | 'implemented' | 'superseded' | 'reversed' {
  const hasIntegration = related.some(r => r.relation === 'integration');
  if (hasIntegration) return 'implemented';
  // Simple heuristic for v1; future: parse decision title for "cancelled"/"superseded"/"deprecated"
  return 'active';
}

export function extractDecisions(): { decisions: number; relations: number } {
  const db = getDb();
  const decisionItems = db.prepare(`
    SELECT wi.id, wi.source, wi.item_type, wi.title, wi.author, wi.trace_role,
           wi.trace_event_at, wi.created_at
    FROM work_items wi WHERE wi.trace_role = 'decision'
  `).all() as ItemRow[];

  const wipeDI = db.prepare('DELETE FROM decision_items');
  const wipeD = db.prepare('DELETE FROM decisions');
  const insertD = db.prepare(`
    INSERT INTO decisions (id, item_id, workstream_id, title, decided_at, decided_by, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertDI = db.prepare(`
    INSERT INTO decision_items (decision_id, item_id, relation, event_at)
    VALUES (?, ?, ?, ?)
  `);

  let relations = 0;

  const tx = db.transaction(() => {
    wipeDI.run();
    wipeD.run();

    for (const item of decisionItems) {
      // A decision may belong to multiple workstreams (multi-membership); pick one to anchor
      const wsRow = db.prepare(`SELECT workstream_id FROM workstream_items WHERE item_id = ? LIMIT 1`).get(item.id) as { workstream_id: string } | undefined;
      const workstreamId = wsRow?.workstream_id ?? null;

      const related = collectRelatedItems(item, workstreamId);
      const status = inferStatus(related);

      const decisionId = uuid();
      insertD.run(
        decisionId,
        item.id,
        workstreamId,
        item.title,
        eventAtOf(item),
        item.author,
        status,
      );

      // Self-relation so UI can retrieve the decision item via the same join
      insertDI.run(decisionId, item.id, 'self', eventAtOf(item));
      relations++;

      for (const r of related) {
        insertDI.run(decisionId, r.item.id, r.relation, eventAtOf(r.item));
        relations++;
      }
    }
  });
  tx();

  return { decisions: decisionItems.length, relations };
}

export interface DecisionSummary {
  id: string;
  item_id: string;
  workstream_id: string | null;
  title: string;
  decided_at: string;
  decided_by: string | null;
  status: string;
  summary: string | null;
  generated_at: string | null;
  item_count: number;
}

export function listDecisions(): DecisionSummary[] {
  return getDb().prepare(`
    SELECT d.id, d.item_id, d.workstream_id, d.title, d.decided_at, d.decided_by,
           d.status, d.summary, d.generated_at, COUNT(di.item_id) AS item_count
    FROM decisions d
    LEFT JOIN decision_items di ON di.decision_id = d.id
    GROUP BY d.id
    ORDER BY d.decided_at DESC
  `).all() as DecisionSummary[];
}

export interface DecisionItem extends ItemRow {
  relation: string;
  event_at: string | null;
  summary: string | null;
  body: string | null;
  url: string | null;
}

export function getDecisionItems(decisionId: string): DecisionItem[] {
  return getDb().prepare(`
    SELECT wi.id, wi.source, wi.item_type, wi.title, wi.author, wi.trace_role,
           wi.trace_event_at, wi.created_at, wi.summary, wi.body, wi.url,
           di.relation, di.event_at
    FROM decision_items di
    JOIN work_items wi ON wi.id = di.item_id
    WHERE di.decision_id = ?
    ORDER BY CASE di.relation
      WHEN 'origin' THEN 1
      WHEN 'discussion' THEN 2
      WHEN 'self' THEN 3
      WHEN 'specification' THEN 4
      WHEN 'implementation' THEN 5
      WHEN 'review' THEN 6
      WHEN 'integration' THEN 7
      WHEN 'follow_up' THEN 8
      ELSE 9
    END ASC, COALESCE(di.event_at, wi.created_at) ASC
  `).all(decisionId) as DecisionItem[];
}
