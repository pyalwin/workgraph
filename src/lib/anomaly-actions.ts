/**
 * Server-side helpers for "act on an anomaly" — turn an open anomaly into
 * either a tracked action item or a real Jira ticket, after the user has
 * verified the auto-flagged content.
 */
import { getLibsqlDb } from './db/libsql';

export interface AnomalyRow {
  id: string;
  workspace_id: string;
  scope: string;
  kind: string;
  severity: number;
  evidence_item_ids: string;
  explanation: string | null;
  detected_at: string;
  resolved_at: string | null;
  dismissed_by_user: number;
  action_item_id: string | null;
  jira_issue_key: string | null;
  handled_at: string | null;
  handled_note: string | null;
}

export async function loadAnomaly(anomalyId: string): Promise<AnomalyRow | null> {
  const db = getLibsqlDb();
  const row = await db
    .prepare(
      `SELECT id, workspace_id, scope, kind, severity, evidence_item_ids,
              explanation, detected_at, resolved_at, dismissed_by_user,
              action_item_id, jira_issue_key, handled_at, handled_note
       FROM anomalies WHERE id = ?`,
    )
    .get<AnomalyRow>(anomalyId);
  return row ?? null;
}

export async function resolveProjectKeyForAnomaly(anomaly: AnomalyRow): Promise<string | null> {
  if (anomaly.scope.startsWith('project:')) {
    const key = anomaly.scope.slice('project:'.length).trim();
    return key || null;
  }
  if (anomaly.scope.startsWith('item:')) {
    const itemId = anomaly.scope.slice('item:'.length);
    const db = getLibsqlDb();
    const row = await db
      .prepare(
        `SELECT json_extract(metadata, '$.entity_key') AS project_key
         FROM work_items WHERE id = ?`,
      )
      .get<{ project_key: string | null }>(itemId);
    return row?.project_key ?? null;
  }
  return null;
}

export async function resolveProjectHubId(projectKey: string): Promise<string | null> {
  const db = getLibsqlDb();
  const row = await db
    .prepare(`SELECT id FROM work_items WHERE source = 'jira' AND source_id = ?`)
    .get<{ id: string }>(`project:${projectKey}`);
  return row?.id ?? null;
}

export interface AnomalyEvidenceRow {
  id: string;
  source_id: string;
  title: string;
  url: string | null;
}

export async function loadAnomalyEvidence(anomaly: AnomalyRow): Promise<AnomalyEvidenceRow[]> {
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(anomaly.evidence_item_ids ?? '[]');
    if (Array.isArray(parsed)) ids = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // ignore malformed evidence
  }
  if (anomaly.scope.startsWith('item:')) ids.unshift(anomaly.scope.slice('item:'.length));
  if (ids.length === 0) return [];
  const db = getLibsqlDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT id, source_id, title, url FROM work_items WHERE id IN (${placeholders})`)
    .all<AnomalyEvidenceRow>(...ids);
  const map = new Map(rows.map((r) => [r.id, r]));
  const ordered: AnomalyEvidenceRow[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const hit = map.get(id);
    if (hit) ordered.push(hit);
  }
  return ordered;
}

export async function markAnomalyHandled(
  anomalyId: string,
  fields: {
    action_item_id?: string | null;
    jira_issue_key?: string | null;
    handled_note?: string | null;
    dismiss?: boolean;
  },
): Promise<void> {
  const db = getLibsqlDb();
  const sets: string[] = ["handled_at = datetime('now')"];
  const args: (string | number | null)[] = [];
  if (fields.action_item_id !== undefined) {
    sets.push('action_item_id = ?');
    args.push(fields.action_item_id);
  }
  if (fields.jira_issue_key !== undefined) {
    sets.push('jira_issue_key = ?');
    args.push(fields.jira_issue_key);
  }
  if (fields.handled_note !== undefined) {
    sets.push('handled_note = ?');
    args.push(fields.handled_note);
  }
  if (fields.dismiss) sets.push('dismissed_by_user = 1');
  args.push(anomalyId);
  await db.prepare(`UPDATE anomalies SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}
