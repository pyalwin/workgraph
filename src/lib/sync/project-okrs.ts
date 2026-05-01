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
import { getDb } from '../db';
import { initSchema } from '../schema';
import { getModel } from '../ai';
import { getProjectReadme } from './project-readme';

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

function gatherContext(projectKey: string): OKRContext | null {
  const db = getDb();

  const projectRow = db
    .prepare(`SELECT title FROM work_items WHERE source='jira' AND source_id = ?`)
    .get(`project:${projectKey}`) as { title: string } | undefined;
  if (!projectRow) return null;

  const { readme } = getProjectReadme(projectKey);
  if (!readme) return null;

  const tickets = db
    .prepare(
      `SELECT source_id, title, status, summary
       FROM work_items
       WHERE source='jira' AND json_extract(metadata, '$.entity_key') = ?
       ORDER BY COALESCE(updated_at, created_at) DESC
       LIMIT ?`,
    )
    .all(projectKey, TICKET_LIMIT) as Array<{
      source_id: string;
      title: string;
      status: string | null;
      summary: string | null;
    }>;

  const ticketLines = tickets.map((t) => {
    const status = (t.status ?? 'unknown').padEnd(8);
    const blurb = t.summary ?? '';
    return `[${status}] ${t.source_id}: ${t.title}${blurb ? ` — ${blurb.slice(0, 200)}` : ''}`;
  });

  const recentDecisions = (
    db
      .prepare(
        `SELECT d.title, d.summary FROM decisions d
         JOIN work_items wi ON wi.id = d.item_id
         WHERE wi.source='jira' AND json_extract(wi.metadata, '$.entity_key') = ?
         ORDER BY d.decided_at DESC LIMIT 5`,
      )
      .all(projectKey) as Array<{ title: string; summary: string | null }>
  ).map((d) => `- ${d.title}${d.summary ? ` — ${d.summary.slice(0, 200)}` : ''}`);

  const now = new Date();
  return {
    projectKey,
    projectName: projectRow.title,
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
  - Restating the README ("Build Otti Assistant")
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

function persist(projectKey: string, projectName: string, okrs: OKRs): PersistedOKR[] {
  const db = getDb();

  // Wipe AI-generated OKRs for this project so we start fresh. User-
  // edited rows (derived_from='manual') survive — even if the AI
  // suggested them originally and the user has since edited them.
  const aiObjectiveIds = (db
    .prepare(
      `SELECT id FROM goals WHERE project_key = ? AND kind='objective' AND derived_from='ai_okr'`,
    )
    .all(projectKey) as { id: string }[]).map((r) => r.id);

  if (aiObjectiveIds.length > 0) {
    const placeholders = aiObjectiveIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM goals WHERE parent_id IN (${placeholders}) AND derived_from='ai_okr'`).run(...aiObjectiveIds);
    db.prepare(`DELETE FROM goals WHERE id IN (${placeholders}) AND derived_from='ai_okr'`).run(...aiObjectiveIds);
  }

  const insertGoal = db.prepare(`
    INSERT INTO goals (
      id, name, description, status, origin, kind, parent_id,
      project_key, target_metric, target_value, target_at,
      ai_confidence, derived_from, keywords
    ) VALUES (?, ?, ?, 'active', 'inferred', ?, ?, ?, ?, ?, ?, ?, 'ai_okr', '[]')
  `);

  const out: PersistedOKR[] = [];
  const tx = db.transaction(() => {
    for (const obj of okrs.objectives) {
      const objId = uuid();
      insertGoal.run(
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
      );

      const krIds: string[] = [];
      for (const kr of obj.key_results) {
        const krId = uuid();
        insertGoal.run(
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
        );
        krIds.push(krId);
      }
      out.push({ objectiveId: objId, keyResultIds: krIds });
    }
  });
  tx();

  void projectName; // currently unused — could be stored alongside if we want a denormalized name
  return out;
}

export async function generateProjectOKRs(
  projectKey: string,
): Promise<{ ok: true; objectives: number; keyResults: number } | { ok: false; reason: string }> {
  initSchema();

  const ctx = gatherContext(projectKey);
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

  const persisted = persist(projectKey, ctx.projectName, result);
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

export function getProjectOKRs(projectKey: string): ProjectOKR[] {
  const db = getDb();
  const objectives = db
    .prepare(
      `SELECT id, name, description, ai_confidence, derived_from
       FROM goals
       WHERE project_key = ? AND kind = 'objective' AND status = 'active'
       ORDER BY created_at ASC`,
    )
    .all(projectKey) as Array<{
      id: string;
      name: string;
      description: string | null;
      ai_confidence: number | null;
      derived_from: string;
    }>;

  if (objectives.length === 0) return [];

  const krStmt = db.prepare(
    `SELECT id, name, description, target_metric, target_value, target_at,
            ai_confidence, derived_from
     FROM goals
     WHERE parent_id = ? AND kind = 'key_result' AND status = 'active'
     ORDER BY created_at ASC`,
  );

  return objectives.map((o) => {
    const krs = krStmt.all(o.id) as Array<{
      id: string;
      name: string;
      description: string | null;
      target_metric: string | null;
      target_value: number | null;
      target_at: string | null;
      ai_confidence: number | null;
      derived_from: string;
    }>;
    return {
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
    };
  });
}
