/**
 * Project OKRs — measurable goals via the OKR technique.
 *
 * Inputs:
 *   - The project README (stable identity — what the project is)
 *   - Recent active work + recent decisions
 *   - The current quarter / time horizon
 *
 * Output:
 *   - 1-3 Objectives per project (qualitative, aspirational)
 *   - 2-4 Key Results per Objective (measurable, time-bound)
 *
 * Stored in the existing `goals` table:
 *   - Objective row:  kind='objective', parent_id=NULL, project_key='<KEY>', target_metric=NULL
 *   - Key Result row: kind='key_result', parent_id=<objective.id>, target_metric, target_value, target_at
 *
 * User-edited rows (any with origin='manual' or derived_from='manual')
 * are NEVER overwritten. Only AI-generated rows (derived_from='ai_okr')
 * get refreshed on regeneration.
 */
import { generateObject } from 'ai';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { getModel } from '../ai';
import { getProjectReadme } from './project-readme';
import { buildProjectItemFilter } from '../project-connectors';
import { resolveAlmanacWorkspaceId } from '../almanac/workspace-resolver';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

const TICKET_LIMIT = 60;
const MAX_OBJECTIVES = 3;
const MAX_KEY_RESULTS_PER_OBJECTIVE = 4;

const KeyResultSchema = z.object({
  text: z.string().describe('Measurable, time-bound key result. Imperative.'),
  why: z.string().describe('1-line rationale anchored in the README/scope.'),
  target_metric: z
    .string()
    .describe(
      'Short snake_case metric handle (pct_done, item_count, p95_latency_ms, days_to_resolution, …). Use a concrete name even if synthetic.',
    ),
  target_value: z.number().describe('Numeric goal. Direction implied by metric.'),
  target_at: z
    .string()
    .describe('ISO date for when this should be achieved (e.g. 2026-09-30 for end-of-Q3).'),
});

const ObjectiveSchema = z.object({
  title: z.string().describe('Aspirational, qualitative objective. ≤ 12 words.'),
  why: z.string().describe('1–2 sentences on why this matters now, anchored in the README.'),
  key_results: z.array(KeyResultSchema).min(2).max(MAX_KEY_RESULTS_PER_OBJECTIVE),
});

const OKRSchema = z.object({
  objectives: z.array(ObjectiveSchema).max(MAX_OBJECTIVES),
});

type OKRs = z.infer<typeof OKRSchema>;

interface OKRContext {
  projectKey: string;
  projectName: string;
  readme: string;
  ticketLines: string[];
  recentDecisions: string[];
  thisQuarterEndsAt: string;
  nextQuarterEndsAt: string;
}

function endOfQuarter(d: Date, addQuarters = 0): string {
  const month = d.getUTCMonth();
  const quarterIdx = Math.floor(month / 3) + addQuarters;
  const year = d.getUTCFullYear() + Math.floor(quarterIdx / 4);
  const qInYear = ((quarterIdx % 4) + 4) % 4;
  const endMonth = qInYear * 3 + 2; // 2/5/8/11
  const last = new Date(Date.UTC(year, endMonth + 1, 0));
  return last.toISOString().slice(0, 10);
}

async function gatherContext(projectKey: string): Promise<OKRContext | null> {
  const db = getLibsqlDb();

  const projectRow = await db
    .prepare(`SELECT title FROM work_items WHERE source='jira' AND source_id = ?`)
    .get<{ title: string }>(`project:${projectKey}`);
  const summaryRow = await db
    .prepare(`SELECT name FROM project_summaries WHERE project_key = ?`)
    .get<{ name: string }>(projectKey);
  const projectTitle = projectRow?.title ?? summaryRow?.name ?? null;
  if (!projectTitle) return null;

  const { readme } = await getProjectReadme(projectKey);
  if (!readme) return null;

  const workspaceId = await resolveAlmanacWorkspaceId(projectKey);
  const filter = await buildProjectItemFilter(workspaceId, projectKey);
  const filterWi = await buildProjectItemFilter(workspaceId, projectKey, 'wi');

  const tickets = await db
    .prepare(
      `SELECT source_id, title, status, summary
       FROM work_items
       WHERE ${filter.sql}
       ORDER BY COALESCE(updated_at, created_at) DESC
       LIMIT ?`,
    )
    .all<{
      source_id: string;
      title: string;
      status: string | null;
      summary: string | null;
    }>(...filter.params, TICKET_LIMIT);

  const ticketLines = tickets.map((t) => {
    const status = (t.status ?? 'unknown').padEnd(8);
    const blurb = t.summary ?? '';
    return `[${status}] ${t.source_id}: ${t.title}${blurb ? ` — ${blurb.slice(0, 200)}` : ''}`;
  });

  const decisionRows = await db
    .prepare(
      `SELECT d.title, d.summary FROM decisions d
       JOIN work_items wi ON wi.id = d.item_id
       WHERE ${filterWi.sql}
       ORDER BY d.decided_at DESC LIMIT 5`,
    )
    .all<{ title: string; summary: string | null }>(...filterWi.params);
  const recentDecisions = decisionRows.map(
    (d) => `- ${d.title}${d.summary ? ` — ${d.summary.slice(0, 200)}` : ''}`,
  );

  const now = new Date();
  return {
    projectKey,
    projectName: projectTitle,
    readme,
    ticketLines,
    recentDecisions,
    thisQuarterEndsAt: endOfQuarter(now, 0),
    nextQuarterEndsAt: endOfQuarter(now, 1),
  };
}

function buildPrompt(ctx: OKRContext): { system: string; user: string } {
  const system = `You generate OKRs (Objectives and Key Results) for a project, anchored in the project's README.

Rules:
  - Produce 1–${MAX_OBJECTIVES} Objectives. Prefer fewer high-quality ones.
  - Each Objective is QUALITATIVE and aspirational — what success looks like in plain language. ≤ 12 words.
  - Each Key Result is MEASURABLE and TIME-BOUND. Use concrete numbers, percentages, or named deliverables. Always set a target_at.
  - 2–${MAX_KEY_RESULTS_PER_OBJECTIVE} Key Results per Objective.
  - Anchor every OKR in the README purpose/scope. If the data doesn't support an OKR, return fewer or none — don't fabricate.
  - Time horizons: prefer end-of-this-quarter (${ctx.thisQuarterEndsAt}) for near-term work, end-of-next-quarter (${ctx.nextQuarterEndsAt}) for ambitious bets.

target_metric guidelines:
  - Use snake_case. Examples: pct_done, item_count, p95_latency_ms,
    days_to_resolution, weekly_active_users, integrations_landed, design_partners.
  - Pick a metric that can plausibly be measured from the system, even if
    proxied. Don't invent unmeasurable abstractions.

Anti-patterns to avoid:
  - Vague objectives ("Improve the platform")
  - Restating the README ("Build the product")
  - Effort metrics as KRs ("Spend 50 hours on X") — measure outcomes, not effort
  - Pure ticket counts ("Close 100 tickets") unless the count is the genuine outcome`;

  const user = `Project: ${ctx.projectName} (${ctx.projectKey})

Project README:
\`\`\`
${ctx.readme}
\`\`\`

Recent active work (most recent first):
${ctx.ticketLines.join('\n')}

${ctx.recentDecisions.length > 0
    ? `Recent decisions:\n${ctx.recentDecisions.join('\n')}`
    : '(no decisions logged)'}

Time horizons:
  This quarter ends: ${ctx.thisQuarterEndsAt}
  Next quarter ends: ${ctx.nextQuarterEndsAt}

Generate OKRs aligned with the README. Return ONLY the objectives array.`;

  return { system, user };
}

interface PersistedOKR {
  objectiveId: string;
  keyResultIds: string[];
}

async function persist(workspaceId: string, projectKey: string, projectName: string, okrs: OKRs): Promise<PersistedOKR[]> {
  const db = getLibsqlDb();

  // Wipe AI-generated OKRs for this project so we start fresh. User-
  // edited rows (derived_from='manual') survive — even if the AI
  // suggested them originally and the user has since edited them.
  const aiObjectiveRows = await db
    .prepare(
      `SELECT id FROM goals WHERE project_key = ? AND workspace_id = ? AND kind='objective' AND derived_from='ai_okr'`,
    )
    .all<{ id: string }>(projectKey, workspaceId);
  const aiObjectiveIds = aiObjectiveRows.map((r) => r.id);

  if (aiObjectiveIds.length > 0) {
    const placeholders = aiObjectiveIds.map(() => '?').join(',');
    await db
      .prepare(
        `DELETE FROM goals WHERE parent_id IN (${placeholders}) AND derived_from='ai_okr' AND workspace_id = ?`,
      )
      .run(...aiObjectiveIds, workspaceId);
    await db
      .prepare(
        `DELETE FROM goals WHERE id IN (${placeholders}) AND derived_from='ai_okr' AND workspace_id = ?`,
      )
      .run(...aiObjectiveIds, workspaceId);
  }

  const insertSql = `
    INSERT INTO goals (
      id, name, description, status, origin, kind, parent_id,
      project_key, target_metric, target_value, target_at,
      ai_confidence, derived_from, keywords, workspace_id
    ) VALUES (?, ?, ?, 'active', 'inferred', ?, ?, ?, ?, ?, ?, ?, 'ai_okr', '[]', ?)`;

  const out: PersistedOKR[] = [];
  for (const obj of okrs.objectives) {
    const objId = uuid();
    await db.prepare(insertSql).run(
      objId,
      obj.title,
      obj.why,
      'objective',
      null,
      projectKey,
      null,
      null,
      null,
      0.8,
      workspaceId,
    );

    const krIds: string[] = [];
    for (const kr of obj.key_results) {
      const krId = uuid();
      await db.prepare(insertSql).run(
        krId,
        kr.text,
        kr.why,
        'key_result',
        objId,
        projectKey,
        kr.target_metric,
        kr.target_value,
        kr.target_at,
        0.75,
        workspaceId,
      );
      krIds.push(krId);
    }
    out.push({ objectiveId: objId, keyResultIds: krIds });
  }

  void projectName; // currently unused — could be stored alongside if we want a denormalized name
  return out;
}

export async function generateProjectOKRs(
  projectKey: string,
): Promise<{ ok: true; objectives: number; keyResults: number } | { ok: false; reason: string }> {
  await ensureInit();

  const ctx = await gatherContext(projectKey);
  if (!ctx) return { ok: false, reason: 'project README missing — generate it first' };
  if (ctx.ticketLines.length === 0) return { ok: false, reason: 'no tickets in project' };

  const { system, user } = buildPrompt(ctx);
  let result: OKRs;
  try {
    const { object } = await generateObject({
      model: getModel('extract'),
      maxOutputTokens: 2000,
      system,
      schema: OKRSchema,
      prompt: user,
    });
    result = object;
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  const workspaceId = await resolveAlmanacWorkspaceId(projectKey);
  const persisted = await persist(workspaceId, projectKey, ctx.projectName, result);
  return {
    ok: true,
    objectives: persisted.length,
    keyResults: persisted.reduce((acc, p) => acc + p.keyResultIds.length, 0),
  };
}

export interface ProjectOKR {
  id: string;
  title: string;
  why: string | null;
  ai_confidence: number | null;
  derived_from: string;
  key_results: ProjectKeyResult[];
}

export interface ProjectKeyResult {
  id: string;
  text: string;
  why: string | null;
  target_metric: string | null;
  target_value: number | null;
  target_at: string | null;
  ai_confidence: number | null;
  derived_from: string;
}

export async function getProjectOKRs(projectKey: string): Promise<ProjectOKR[]> {
  await ensureInit();
  const db = getLibsqlDb();
  const workspaceId = await resolveAlmanacWorkspaceId(projectKey);
  const objectives = await db
    .prepare(
      `SELECT id, name, description, ai_confidence, derived_from
       FROM goals
       WHERE project_key = ? AND workspace_id = ? AND kind = 'objective' AND status = 'active'
       ORDER BY created_at ASC`,
    )
    .all<{
      id: string;
      name: string;
      description: string | null;
      ai_confidence: number | null;
      derived_from: string;
    }>(projectKey, workspaceId);

  if (objectives.length === 0) return [];

  const krSql = `SELECT id, name, description, target_metric, target_value, target_at,
            ai_confidence, derived_from
     FROM goals
     WHERE parent_id = ? AND workspace_id = ? AND kind = 'key_result' AND status = 'active'
     ORDER BY created_at ASC`;

  const out: ProjectOKR[] = [];
  for (const o of objectives) {
    const krs = await db.prepare(krSql).all<{
      id: string;
      name: string;
      description: string | null;
      target_metric: string | null;
      target_value: number | null;
      target_at: string | null;
      ai_confidence: number | null;
      derived_from: string;
    }>(o.id, workspaceId);
    out.push({
      id: o.id,
      title: o.name,
      why: o.description,
      ai_confidence: o.ai_confidence,
      derived_from: o.derived_from,
      key_results: krs.map((kr) => ({
        id: kr.id,
        text: kr.name,
        why: kr.description,
        target_metric: kr.target_metric,
        target_value: kr.target_value,
        target_at: kr.target_at,
        ai_confidence: kr.ai_confidence,
        derived_from: kr.derived_from,
      })),
    });
  }
  return out;
}
