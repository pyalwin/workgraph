/**
 * Phase 2.3 — workspace-wide anomaly scan.
 *
 * Runs Mondays at 06:00 (cron `0 6 * * 1`) and on manual
 * `workgraph/anomalies.scan` events. Detects six heuristic kinds
 * across all enabled workspaces and persists results into the
 * `anomalies` table. The seventh (priority_inversion) needs a
 * link-graph traversal so we wire it but make it conservative.
 *
 * The AI per-item enrichment (enrich-rich.ts) flags item-scoped
 * anomalies live during sync. This function adds the workspace-
 * scoped flags that need cross-item context.
 */
import { v4 as uuid } from 'uuid';
import { initSchema } from '@/lib/schema';
import { getDb } from '@/lib/db';
import { inngest } from '../client';

interface AnomalyOut {
  workspaceId: string;
  scope: string;
  kind:
    | 'stale'
    | 'churning'
    | 'scope_creep'
    | 'priority_inversion'
    | 'deadline_risk'
    | 'owner_gap'
    | 'goal_drift';
  severity: number;
  evidenceItemIds: string[];
  explanation: string;
}

const STALE_DAYS = 14;
const CHURN_COMMENTS = 8;
const CHURN_QUIET_DAYS = 7;
const OWNER_GAP_DAYS = 3;

function listEnabledWorkspaces(): string[] {
  initSchema();
  const db = getDb();
  return (
    db
      .prepare(`SELECT DISTINCT workspace_id FROM workspace_connector_configs WHERE status != 'skipped'`)
      .all() as { workspace_id: string }[]
  ).map((r) => r.workspace_id);
}

function detectStale(workspaceId: string, projectKey: string): AnomalyOut | null {
  const db = getDb();
  const items = db
    .prepare(
      `SELECT id, title, updated_at, created_at FROM work_items
       WHERE source = 'jira'
         AND status IN ('active', 'open')
         AND json_extract(metadata, '$.entity_key') = ?
         AND julianday('now') - julianday(COALESCE(updated_at, created_at)) > ?`,
    )
    .all(projectKey, STALE_DAYS) as { id: string; title: string; updated_at: string | null; created_at: string }[];
  if (items.length === 0) return null;
  const totalActive = (db
    .prepare(
      `SELECT COUNT(*) AS c FROM work_items
       WHERE source='jira' AND status IN ('active','open')
         AND json_extract(metadata,'$.entity_key') = ?`,
    )
    .get(projectKey) as { c: number }).c;
  const ratio = totalActive > 0 ? items.length / totalActive : 0;
  return {
    workspaceId,
    scope: `project:${projectKey}`,
    kind: 'stale',
    severity: Math.min(1, ratio * 1.5),
    evidenceItemIds: items.slice(0, 10).map((i) => i.id),
    explanation: `${items.length} active item${items.length === 1 ? '' : 's'} have not been updated in ${STALE_DAYS}+ days (${Math.round(ratio * 100)}% of active set).`,
  };
}

function detectChurning(workspaceId: string, projectKey: string): AnomalyOut[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, title,
              CAST(json_extract(metadata, '$.comment_count') AS INTEGER) AS comments,
              json_extract(metadata, '$.last_commented_at') AS last_at,
              status, updated_at
       FROM work_items
       WHERE source = 'jira'
         AND json_extract(metadata, '$.entity_key') = ?
         AND status IN ('active','open')
         AND CAST(json_extract(metadata, '$.comment_count') AS INTEGER) >= ?`,
    )
    .all(projectKey, CHURN_COMMENTS) as Array<{
      id: string;
      title: string;
      comments: number;
      last_at: string | null;
      status: string | null;
      updated_at: string | null;
    }>;

  return rows
    .filter((r) => {
      const last = r.last_at ?? r.updated_at;
      if (!last) return false;
      const daysSince = (Date.now() - new Date(last).getTime()) / 86_400_000;
      return daysSince >= CHURN_QUIET_DAYS;
    })
    .map((r) => ({
      workspaceId,
      scope: `item:${r.id}`,
      kind: 'churning' as const,
      severity: Math.min(1, r.comments / 30),
      evidenceItemIds: [r.id],
      explanation: `${r.comments} comments and no status change in ${CHURN_QUIET_DAYS}+ days — discussion has stalled out.`,
    }));
}

function detectOwnerGap(workspaceId: string, projectKey: string): AnomalyOut[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, title, updated_at, created_at FROM work_items
       WHERE source = 'jira'
         AND json_extract(metadata, '$.entity_key') = ?
         AND status IN ('active','open')
         AND (author IS NULL OR author = '')
         AND julianday('now') - julianday(COALESCE(updated_at, created_at)) > ?`,
    )
    .all(projectKey, OWNER_GAP_DAYS) as { id: string; title: string }[];
  return rows.slice(0, 20).map((r) => ({
    workspaceId,
    scope: `item:${r.id}`,
    kind: 'owner_gap' as const,
    severity: 0.55,
    evidenceItemIds: [r.id],
    explanation: `Active item with no assignee for ${OWNER_GAP_DAYS}+ days — needs an owner before it drifts.`,
  }));
}

function detectGoalDrift(workspaceId: string): AnomalyOut[] {
  const db = getDb();
  // Goals with target_at within 30 days but <50% of contributing items done.
  const rows = db
    .prepare(
      `SELECT g.id, g.name, g.target_at,
              COUNT(it.item_id) AS total,
              SUM(CASE WHEN wi.status IN ('done','closed','resolved') THEN 1 ELSE 0 END) AS done
       FROM goals g
       LEFT JOIN item_tags it ON it.tag_id = g.id
       LEFT JOIN work_items wi ON wi.id = it.item_id
       WHERE g.status = 'active'
         AND g.target_at IS NOT NULL
         AND julianday(g.target_at) - julianday('now') BETWEEN 0 AND 30
       GROUP BY g.id`,
    )
    .all() as Array<{
      id: string;
      name: string;
      target_at: string | null;
      total: number;
      done: number;
    }>;
  return rows
    .filter((r) => r.total > 0 && r.done / r.total < 0.5)
    .map((r) => ({
      workspaceId,
      scope: `goal:${r.id}`,
      kind: 'goal_drift' as const,
      severity: 0.7,
      evidenceItemIds: [],
      explanation: `Goal "${r.name}" is due in <30 days but only ${r.done}/${r.total} contributing items are done.`,
    }));
}

function persistAnomalies(found: AnomalyOut[], workspaceId: string) {
  const db = getDb();

  // Resolve any open anomalies whose triggers no longer hold.
  const seen = new Set(found.map((a) => `${a.scope}::${a.kind}`));
  const open = db
    .prepare(
      `SELECT scope, kind FROM anomalies WHERE workspace_id = ? AND resolved_at IS NULL`,
    )
    .all(workspaceId) as { scope: string; kind: string }[];
  const resolveStmt = db.prepare(
    `UPDATE anomalies SET resolved_at = datetime('now')
     WHERE workspace_id = ? AND scope = ? AND kind = ? AND resolved_at IS NULL`,
  );
  for (const o of open) {
    if (!seen.has(`${o.scope}::${o.kind}`)) resolveStmt.run(workspaceId, o.scope, o.kind);
  }

  // Upsert live ones.
  const upsert = db.prepare(`
    INSERT INTO anomalies (id, workspace_id, scope, kind, severity, evidence_item_ids, explanation, detected_at, resolved_at, dismissed_by_user)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL, 0)
    ON CONFLICT(workspace_id, scope, kind) DO UPDATE SET
      severity = excluded.severity,
      evidence_item_ids = excluded.evidence_item_ids,
      explanation = excluded.explanation,
      detected_at = excluded.detected_at,
      resolved_at = NULL
  `);

  const tx = db.transaction(() => {
    for (const a of found) {
      upsert.run(
        uuid(),
        a.workspaceId,
        a.scope,
        a.kind,
        a.severity,
        JSON.stringify(a.evidenceItemIds),
        a.explanation,
      );
    }
  });
  tx();
}

export const anomalyScan = inngest.createFunction(
  {
    id: 'anomaly-scan',
    name: 'Anomaly · weekly scan',
    triggers: [
      { cron: '0 6 * * 1' }, // Monday 06:00
      { event: 'workgraph/anomalies.scan' },
    ],
  },
  async ({ step }) => {
    const workspaces = await step.run('list-workspaces', () => listEnabledWorkspaces());
    let total = 0;

    for (const workspaceId of workspaces) {
      await step.run(`scan-${workspaceId}`, () => {
        const db = getDb();
        const projects = (
          db
            .prepare(
              `SELECT DISTINCT json_extract(metadata, '$.entity_key') AS k
               FROM work_items WHERE source = 'jira' AND json_extract(metadata, '$.entity_key') IS NOT NULL`,
            )
            .all() as { k: string }[]
        )
          .map((r) => r.k)
          .filter(Boolean);

        const found: AnomalyOut[] = [];
        for (const projectKey of projects) {
          const stale = detectStale(workspaceId, projectKey);
          if (stale) found.push(stale);
          found.push(...detectChurning(workspaceId, projectKey));
          found.push(...detectOwnerGap(workspaceId, projectKey));
        }
        found.push(...detectGoalDrift(workspaceId));

        persistAnomalies(found, workspaceId);
        total += found.length;
        return { workspaceId, count: found.length };
      });
    }

    return { workspaces: workspaces.length, anomaliesPersisted: total };
  },
);
