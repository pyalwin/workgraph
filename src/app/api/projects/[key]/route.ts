import { NextRequest, NextResponse } from 'next/server';
import { initSchema, migrateProjectSummaries } from '@/lib/schema';
import { getDb } from '@/lib/db';
import { getProjectDetail } from '@/lib/project-queries';
import { getOrGenerateSummary } from '@/lib/project-summary';
import { getProjectReadme } from '@/lib/sync/project-readme';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';

const PROJECT_NAMES: Record<string, string> = {
  OA: 'Otti Assistant',
  PEX: 'Partner Experience',
  INT: 'Integrations',
};

interface ProjectAnomaly {
  id: string;
  scope: string;
  kind: string;
  severity: number;
  explanation: string | null;
  evidence_item_ids: string[];
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

function getProjectAnomalies(projectKey: string): ProjectAnomaly[] {
  const db = getDb();
  // project-scoped anomalies + item-scoped anomalies for items in this project
  const rows = db
    .prepare(
      `SELECT id, scope, kind, severity, explanation, evidence_item_ids, detected_at
       FROM anomalies
       WHERE resolved_at IS NULL AND dismissed_by_user = 0
         AND (
           scope = ?
           OR scope IN (
             SELECT 'item:' || id FROM work_items
             WHERE source = 'jira' AND json_extract(metadata, '$.entity_key') = ?
           )
         )
       ORDER BY severity DESC LIMIT 30`,
    )
    .all(`project:${projectKey}`, projectKey) as Array<{
      id: string;
      scope: string;
      kind: string;
      severity: number;
      explanation: string | null;
      evidence_item_ids: string;
      detected_at: string;
    }>;
  return rows.map((r) => ({
    ...r,
    evidence_item_ids: safeParse<string[]>(r.evidence_item_ids, []),
  }));
}

function getProjectActionItems(projectKey: string): ProjectActionItem[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT ai.id, ai.source_item_id, wi.source_id, wi.title AS source_title,
              ai.text, ai.assignee, ai.ai_priority, ai.user_priority, ai.due_at
       FROM action_items ai
       JOIN work_items wi ON wi.id = ai.source_item_id
       WHERE ai.state = 'open'
         AND wi.source = 'jira'
         AND json_extract(wi.metadata, '$.entity_key') = ?
       ORDER BY COALESCE(ai.user_priority, ai.ai_priority, 'p9') ASC,
                ai.due_at ASC NULLS LAST
       LIMIT 30`,
    )
    .all(projectKey) as ProjectActionItem[];
}

function safeParse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export async function GET(req: NextRequest, props: { params: Promise<{ key: string }> }) {
  const params = await props.params;
  initSchema();
  migrateProjectSummaries();

  const period = req.nextUrl.searchParams.get('period') || '30d';
  const projectKey = params.key.toUpperCase();
  const projectName = PROJECT_NAMES[projectKey] || projectKey;

  const detail = getProjectDetail(projectKey, period) as ReturnType<typeof getProjectDetail> & {
    anomalies?: ProjectAnomaly[];
    actionItems?: ProjectActionItem[];
    readme?: { content: string | null; generatedAt: string | null };
  };

  // Generate or fetch cached summary
  const summary = await getOrGenerateSummary(projectKey, projectName);
  detail.health.summary = summary;

  // Phase 2.6 — anomalies + action items for this project
  detail.anomalies = getProjectAnomalies(projectKey);
  detail.actionItems = getProjectActionItems(projectKey);

  // README — stable descriptive doc. If missing, kick off generation in the
  // background; the next reload will see it.
  const readme = getProjectReadme(projectKey);
  if (!readme.readme) {
    inngest
      .send({ name: 'workgraph/project.readme.refresh', data: { projectKey } })
      .catch(() => { /* swallow — best-effort */ });
  }
  detail.readme = { content: readme.readme, generatedAt: readme.generatedAt };

  return NextResponse.json(detail);
}
