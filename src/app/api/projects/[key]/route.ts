import { NextRequest, NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { getProjectDetail } from '@/lib/project-queries';
import { getOrGenerateSummary } from '@/lib/project-summary';
import { getProjectReadme } from '@/lib/sync/project-readme';
import { getProjectOKRs, type ProjectOKR } from '@/lib/sync/project-okrs';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';

const PROJECT_NAMES: Record<string, string> = {
  ALPHA: 'Alpha Initiative',
  BETA: 'Beta Platform',
  GAMMA: 'Gamma Workflow',
};

interface AnomalyEvidence {
  id: string;
  source_id: string;
  title: string;
  url: string | null;
}

interface ProjectAnomaly {
  id: string;
  scope: string;
  kind: string;
  severity: number;
  explanation: string | null;
  evidence_item_ids: string[];
  evidence: AnomalyEvidence[];
  detected_at: string;
}

interface ProjectActionItem {
  id: string;
  source_item_id: string;
  source_id: string;
  source_title: string;
  text: string;
  assignee: string | null;
  ai_priority: string | null;
  user_priority: string | null;
  due_at: string | null;
}

async function getProjectAnomalies(projectKey: string): Promise<ProjectAnomaly[]> {
  const db = getLibsqlDb();
  // project-scoped anomalies + item-scoped anomalies for items in this project.
  const rows = await db
    .prepare(
      `SELECT id, scope, kind, severity, explanation, evidence_item_ids, detected_at,
              action_item_id, jira_issue_key, handled_at, dismissed_by_user
       FROM anomalies
       WHERE resolved_at IS NULL
         AND (
           (dismissed_by_user = 0 AND handled_at IS NULL)
           OR (handled_at IS NOT NULL AND datetime(handled_at) > datetime('now', '-7 days'))
         )
         AND (
           scope = ?
           OR scope IN (
             SELECT 'item:' || id FROM work_items
             WHERE source = 'jira' AND json_extract(metadata, '$.entity_key') = ?
           )
           OR (kind = 'orphan_pr_batch' AND scope LIKE 'repo:%')
         )
       ORDER BY handled_at IS NULL DESC, severity DESC LIMIT 30`,
    )
    .all<{
      id: string;
      scope: string;
      kind: string;
      severity: number;
      explanation: string | null;
      evidence_item_ids: string;
      detected_at: string;
      action_item_id: string | null;
      jira_issue_key: string | null;
      handled_at: string | null;
      dismissed_by_user: number;
    }>(`project:${projectKey}`, projectKey);

  const parsed = rows.map((r) => ({
    ...r,
    evidence_item_ids: safeParse<string[]>(r.evidence_item_ids, []),
  }));

  // Collect every distinct work_item id we need to resolve into a source link.
  const allIds = new Set<string>();
  for (const a of parsed) {
    for (const id of a.evidence_item_ids) allIds.add(id);
    if (a.scope.startsWith('item:')) allIds.add(a.scope.slice('item:'.length));
  }

  const evidenceMap = new Map<string, AnomalyEvidence>();
  if (allIds.size > 0) {
    const placeholders = Array.from(allIds).map(() => '?').join(',');
    const items = await db
      .prepare(
        `SELECT id, source_id, title, url FROM work_items WHERE id IN (${placeholders})`,
      )
      .all<AnomalyEvidence>(...allIds);
    for (const it of items) evidenceMap.set(it.id, it);
  }

  return parsed.map((a) => {
    // For item-scoped anomalies, prefer the scope target as the primary link.
    const ids = a.scope.startsWith('item:')
      ? [a.scope.slice('item:'.length), ...a.evidence_item_ids]
      : a.evidence_item_ids;
    const seen = new Set<string>();
    const evidence: AnomalyEvidence[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const hit = evidenceMap.get(id);
      if (hit) evidence.push(hit);
    }
    return { ...a, evidence };
  });
}

async function getProjectActionItems(projectKey: string): Promise<ProjectActionItem[]> {
  const db = getLibsqlDb();
  return db
    .prepare(
      `SELECT ai.id, ai.source_item_id, wi.source_id, wi.title AS source_title,
              ai.text, ai.assignee, ai.ai_priority, ai.user_priority, ai.due_at
       FROM action_items ai
       JOIN work_items wi ON wi.id = ai.source_item_id
       WHERE ai.state = 'open'
         AND wi.source = 'jira'
         AND (
           wi.source_id = ?
           OR json_extract(wi.metadata, '$.entity_key') = ?
         )
       ORDER BY COALESCE(ai.user_priority, ai.ai_priority, 'p9') ASC,
                ai.due_at ASC NULLS LAST
       LIMIT 30`,
    )
    .all<ProjectActionItem>(`project:${projectKey}`, projectKey);
}

function safeParse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export async function GET(req: NextRequest, props: { params: Promise<{ key: string }> }) {
  const params = await props.params;
  await ensureSchemaAsync();

  const period = req.nextUrl.searchParams.get('period') || '30d';
  const projectKey = params.key.toUpperCase();
  const projectName = PROJECT_NAMES[projectKey] || projectKey;

  const baseDetail = await getProjectDetail(projectKey, period);
  const detail = baseDetail as Awaited<ReturnType<typeof getProjectDetail>> & {
    anomalies?: ProjectAnomaly[];
    actionItems?: ProjectActionItem[];
    readme?: { content: string | null; generatedAt: string | null };
    okrs?: ProjectOKR[];
  };

  // Generate or fetch cached summary
  const summary = await getOrGenerateSummary(projectKey, projectName);
  detail.health.summary = summary;

  // Phase 2.6 — anomalies + action items for this project
  detail.anomalies = await getProjectAnomalies(projectKey);
  detail.actionItems = await getProjectActionItems(projectKey);

  // README — stable descriptive doc. If missing, kick off generation in the
  // background; the next reload will see it.
  const readme = await getProjectReadme(projectKey);
  if (!readme.readme) {
    inngest
      .send({ name: 'workgraph/project.readme.refresh', data: { projectKey } })
      .catch(() => { /* swallow — best-effort */ });
  }
  detail.readme = { content: readme.readme, generatedAt: readme.generatedAt };

  // OKRs — anchored on the README. Auto-seed when README exists but no OKRs do.
  detail.okrs = await getProjectOKRs(projectKey);
  if (readme.readme && detail.okrs.length === 0) {
    inngest
      .send({ name: 'workgraph/project.okrs.refresh', data: { projectKey } })
      .catch(() => { /* swallow */ });
  }

  return NextResponse.json(detail);
}
