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
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { inngest } from '../client';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

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
    | 'goal_drift'
    | 'ticket_no_pr'
    | 'orphan_pr_batch';
  severity: number;
  evidenceItemIds: string[];
  explanation: string;
}

const STALE_DAYS = 14;
const CHURN_COMMENTS = 8;
const CHURN_QUIET_DAYS = 7;
const OWNER_GAP_DAYS = 3;
// "Done without code" — only flag tickets that closed > 1 day ago to avoid
// false positives during the window where a PR was just merged but the
// trail sync hasn't caught up.
const TICKET_NO_PR_MIN_AGE_DAYS = 1;
// Don't yell about every single tracker ticket — many tickets legitimately
// don't need code (process work, doc updates, partner asks). Bucket per-
// project and only raise an anomaly when the no-PR ratio is significant.
const TICKET_NO_PR_MIN_RATIO = 0.30;
const TICKET_NO_PR_MIN_COUNT = 5;
// Same logic for orphan PRs — one orphan is noise, a batch from one repo is
// signal that either the matcher is misfiring or the repo isn't using Jira
// keys in PR titles/branches.
const ORPHAN_PR_MIN_BATCH = 5;
const ORPHAN_PR_MIN_AGE_DAYS = 7; // give the AI matcher a week to attach

async function listEnabledWorkspaces(): Promise<string[]> {
  await ensureInit();
  const db = getLibsqlDb();
  const rows = await db
    .prepare(
      `SELECT DISTINCT workspace_id FROM workspace_connector_configs WHERE status != 'skipped'`,
    )
    .all<{ workspace_id: string }>();
  return rows.map((r) => r.workspace_id);
}

async function detectStale(workspaceId: string, projectKey: string): Promise<AnomalyOut | null> {
  const db = getLibsqlDb();
  const items = await db
    .prepare(
      `SELECT id, title, updated_at, created_at FROM work_items
       WHERE source = 'jira'
         AND status IN ('active', 'open')
         AND json_extract(metadata, '$.entity_key') = ?
         AND julianday('now') - julianday(COALESCE(updated_at, created_at)) > ?`,
    )
    .all<{ id: string; title: string; updated_at: string | null; created_at: string }>(projectKey, STALE_DAYS);
  if (items.length === 0) return null;
  const totalActiveRow = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM work_items
       WHERE source='jira' AND status IN ('active','open')
         AND json_extract(metadata,'$.entity_key') = ?`,
    )
    .get<{ c: number }>(projectKey);
  const totalActive = totalActiveRow?.c ?? 0;
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

async function detectChurning(workspaceId: string, projectKey: string): Promise<AnomalyOut[]> {
  const db = getLibsqlDb();
  const rows = await db
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
    .all<{
      id: string;
      title: string;
      comments: number;
      last_at: string | null;
      status: string | null;
      updated_at: string | null;
    }>(projectKey, CHURN_COMMENTS);

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

async function detectOwnerGap(workspaceId: string, projectKey: string): Promise<AnomalyOut[]> {
  const db = getLibsqlDb();
  const rows = await db
    .prepare(
      `SELECT id, title, updated_at, created_at FROM work_items
       WHERE source = 'jira'
         AND json_extract(metadata, '$.entity_key') = ?
         AND status IN ('active','open')
         AND (author IS NULL OR author = '')
         AND julianday('now') - julianday(COALESCE(updated_at, created_at)) > ?`,
    )
    .all<{ id: string; title: string }>(projectKey, OWNER_GAP_DAYS);
  return rows.slice(0, 20).map((r) => ({
    workspaceId,
    scope: `item:${r.id}`,
    kind: 'owner_gap' as const,
    severity: 0.55,
    evidenceItemIds: [r.id],
    explanation: `Active item with no assignee for ${OWNER_GAP_DAYS}+ days — needs an owner before it drifts.`,
  }));
}

async function detectTicketsWithoutPRs(workspaceId: string, projectKey: string): Promise<AnomalyOut | null> {
  const db = getLibsqlDb();
  const allClosed = await db
    .prepare(
      `SELECT wi.id, wi.source_id, wi.title, wi.updated_at,
              EXISTS(SELECT 1 FROM issue_trails t WHERE t.issue_item_id = wi.id) AS has_trail
       FROM work_items wi
       WHERE wi.source = 'jira'
         AND wi.status IN ('done', 'closed', 'resolved')
         AND json_extract(wi.metadata, '$.entity_key') = ?
         AND julianday('now') - julianday(COALESCE(wi.updated_at, wi.created_at)) >= ?`,
    )
    .all<{
      id: string;
      source_id: string;
      title: string;
      updated_at: string | null;
      has_trail: number;
    }>(projectKey, TICKET_NO_PR_MIN_AGE_DAYS);

  const noPr = allClosed.filter((r) => r.has_trail === 0);
  if (allClosed.length < TICKET_NO_PR_MIN_COUNT) return null;
  if (noPr.length < TICKET_NO_PR_MIN_COUNT) return null;
  const ratio = noPr.length / allClosed.length;
  if (ratio < TICKET_NO_PR_MIN_RATIO) return null;

  const severity = Math.min(1, 0.4 + ratio * 0.6);
  const ordered = noPr
    .slice()
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  return {
    workspaceId,
    scope: `project:${projectKey}`,
    kind: 'ticket_no_pr',
    severity,
    evidenceItemIds: ordered.slice(0, 10).map((r) => r.id),
    explanation: `${noPr.length} of ${allClosed.length} closed ${projectKey} tickets (${Math.round(ratio * 100)}%) have no linked PRs — either the PRs aren't reaching the graph or the work shipped without code.`,
  };
}

async function detectOrphanPrBatches(workspaceId: string): Promise<AnomalyOut[]> {
  const db = getLibsqlDb();
  const rows = await db
    .prepare(
      `SELECT repo, COUNT(*) AS cnt,
              GROUP_CONCAT(pr_ref, '|') AS sample_refs
       FROM issue_trails
       WHERE match_status = 'unmatched'
         AND kind = 'pr_opened'
         AND repo IS NOT NULL
         AND julianday('now') - julianday(occurred_at) >= ?
       GROUP BY repo
       HAVING cnt >= ?`,
    )
    .all<{
      repo: string;
      cnt: number;
      sample_refs: string;
    }>(ORPHAN_PR_MIN_AGE_DAYS, ORPHAN_PR_MIN_BATCH);

  return rows.map((r) => {
    const samples = (r.sample_refs ?? '').split('|').filter(Boolean).slice(0, 5);
    const sampleStr = samples.length > 0 ? ` Examples: ${samples.join(', ')}.` : '';
    return {
      workspaceId,
      scope: `repo:${r.repo}`,
      kind: 'orphan_pr_batch' as const,
      severity: Math.min(1, 0.4 + (r.cnt / 30) * 0.5),
      evidenceItemIds: [],
      explanation: `${r.cnt} unmatched PRs in ${r.repo} have been open for ${ORPHAN_PR_MIN_AGE_DAYS}+ days — neither title, branch, nor body referenced a Jira key.${sampleStr}`,
    };
  });
}

async function detectGoalDrift(workspaceId: string): Promise<AnomalyOut[]> {
  const db = getLibsqlDb();
  const rows = await db
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
    .all<{
      id: string;
      name: string;
      target_at: string | null;
      total: number;
      done: number;
    }>();
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

async function persistAnomalies(found: AnomalyOut[], workspaceId: string): Promise<void> {
  const db = getLibsqlDb();

  // Resolve any open anomalies whose triggers no longer hold.
  const seen = new Set(found.map((a) => `${a.scope}::${a.kind}`));
  const open = await db
    .prepare(
      `SELECT scope, kind FROM anomalies WHERE workspace_id = ? AND resolved_at IS NULL`,
    )
    .all<{ scope: string; kind: string }>(workspaceId);
  const resolveSql = `UPDATE anomalies SET resolved_at = datetime('now')
     WHERE workspace_id = ? AND scope = ? AND kind = ? AND resolved_at IS NULL`;
  for (const o of open) {
    if (!seen.has(`${o.scope}::${o.kind}`)) {
      await db.prepare(resolveSql).run(workspaceId, o.scope, o.kind);
    }
  }

  // Upsert live ones. Sequential async — each upsert is independent.
  const upsertSql = `INSERT INTO anomalies (id, workspace_id, scope, kind, severity, evidence_item_ids, explanation, detected_at, resolved_at, dismissed_by_user)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL, 0)
    ON CONFLICT(workspace_id, scope, kind) DO UPDATE SET
      severity = excluded.severity,
      evidence_item_ids = excluded.evidence_item_ids,
      explanation = excluded.explanation,
      detected_at = excluded.detected_at,
      resolved_at = NULL`;
  for (const a of found) {
    await db.prepare(upsertSql).run(
      uuid(),
      a.workspaceId,
      a.scope,
      a.kind,
      a.severity,
      JSON.stringify(a.evidenceItemIds),
      a.explanation,
    );
  }
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
      const result = await step.run(`scan-${workspaceId}`, async () => {
        const db = getLibsqlDb();
        const projectRows = await db
          .prepare(
            `SELECT DISTINCT json_extract(metadata, '$.entity_key') AS k
             FROM work_items WHERE source = 'jira' AND json_extract(metadata, '$.entity_key') IS NOT NULL`,
          )
          .all<{ k: string }>();
        const projects = projectRows.map((r) => r.k).filter(Boolean);

        const found: AnomalyOut[] = [];
        for (const projectKey of projects) {
          const stale = await detectStale(workspaceId, projectKey);
          if (stale) found.push(stale);
          found.push(...(await detectChurning(workspaceId, projectKey)));
          found.push(...(await detectOwnerGap(workspaceId, projectKey)));
          const noPr = await detectTicketsWithoutPRs(workspaceId, projectKey);
          if (noPr) found.push(noPr);
        }
        found.push(...(await detectGoalDrift(workspaceId)));
        found.push(...(await detectOrphanPrBatches(workspaceId)));

        await persistAnomalies(found, workspaceId);
        return { workspaceId, count: found.length };
      });
      total += result.count;
    }

    return { workspaces: workspaces.length, anomaliesPersisted: total };
  },
);
