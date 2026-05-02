/**
 * Project-level action items.
 *
 * Each project gets a single curated list (5–8 items) synthesized from the
 * full ticket set — open issues, recent decisions, AI-extracted summaries,
 * and active themes. This replaces the per-ticket extraction that produced
 * 30 redundant variants of "review the v2 schema".
 *
 * Storage: `action_items` table with source_item_id pointing at the
 * synthetic project hub item (`source='jira', source_id='project:<KEY>'`).
 * User-edited items (with user_priority set) survive regeneration.
 */
import { generateObject } from 'ai';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { getModel } from '../ai';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

const PROMPT_TICKET_LIMIT = 60; // recent active + recent done
const OUTPUT_LIMIT = 8;

const ProjectActionItemsSchema = z.object({
  action_items: z
    .array(
      z.object({
        text: z
          .string()
          .describe('Concrete next step that moves the project forward. Imperative, specific, owner-actionable.'),
        evidence_source_ids: z
          .array(z.string())
          .describe('Source IDs (e.g. "ALPHA-123") of tickets that prompted this action. Empty if cross-cutting.'),
        assignee: z
          .string()
          .nullable()
          .describe('Best-effort assignee — only when clearly named in source text.'),
        due_at: z
          .string()
          .nullable()
          .describe('ISO date if mentioned. Null otherwise.'),
        ai_priority: z.enum(['p0', 'p1', 'p2', 'p3']),
      }),
    )
    .max(OUTPUT_LIMIT)
    .describe('Curated, deduped action items at the project level. 5–8 max. Empty when nothing genuine.'),
});

type ProjectActions = z.infer<typeof ProjectActionItemsSchema>;

interface ProjectContext {
  projectKey: string;
  projectName: string;
  totalOpen: number;
  totalDone: number;
  ticketLines: string[];
  recentDecisions: string[];
}

async function gatherContext(projectKey: string): Promise<ProjectContext | null> {
  const db = getLibsqlDb();

  const projectRow = await db
    .prepare(
      `SELECT title FROM work_items
       WHERE source = 'jira' AND source_id = ?`,
    )
    .get<{ title: string }>(`project:${projectKey}`);

  if (!projectRow) return null;

  const counts = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('done','closed','resolved') THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status IN ('active','open','backlog') THEN 1 ELSE 0 END) AS open
       FROM work_items
       WHERE source='jira' AND json_extract(metadata, '$.entity_key') = ?`,
    )
    .get<{ done: number; open: number }>(projectKey);

  // Pull the most recently active + the just-shipped, both with summaries when present.
  const tickets = await db
    .prepare(
      `SELECT source_id, title, status, summary, priority,
              json_extract(metadata, '$.last_commented_at') AS last_at
       FROM work_items
       WHERE source = 'jira' AND json_extract(metadata, '$.entity_key') = ?
       ORDER BY COALESCE(updated_at, created_at) DESC
       LIMIT ?`,
    )
    .all<{
      source_id: string;
      title: string;
      status: string | null;
      summary: string | null;
      priority: string | null;
      last_at: string | null;
    }>(projectKey, PROMPT_TICKET_LIMIT);

  const ticketLines = tickets.map((t) => {
    const status = (t.status ?? 'unknown').padEnd(8);
    const pri = t.priority ? `${t.priority.toUpperCase()} ` : '';
    const blurb = t.summary ?? '';
    return `[${status}] ${t.source_id}: ${pri}${t.title}${blurb ? ` — ${blurb.slice(0, 200)}` : ''}`;
  });

  const decisionRows = await db
    .prepare(
      `SELECT d.title, d.summary FROM decisions d
       JOIN work_items wi ON wi.id = d.item_id
       WHERE wi.source='jira' AND json_extract(wi.metadata, '$.entity_key') = ?
       ORDER BY d.decided_at DESC LIMIT 5`,
    )
    .all<{ title: string; summary: string | null }>(projectKey);
  const recentDecisions = decisionRows.map(
    (d) => `- ${d.title}${d.summary ? ` — ${d.summary.slice(0, 200)}` : ''}`,
  );

  return {
    projectKey,
    projectName: projectRow.title,
    totalOpen: counts?.open ?? 0,
    totalDone: counts?.done ?? 0,
    ticketLines,
    recentDecisions,
  };
}

function buildPrompt(ctx: ProjectContext): { system: string; user: string } {
  const system = `You produce a SHORT, CURATED list of project-level action items.

Each action must be:
  - Imperative ("Decide on X", "Unblock Y", "Document Z" — not "X is unclear")
  - Concrete enough that a reasonable engineer could pick it up tomorrow
  - Genuinely cross-cutting OR sufficiently important on its own — never
    a paraphrase of a single ticket's title
  - Maximum ${OUTPUT_LIMIT} items. Prefer fewer high-quality ones over filler.
  - Empty list is acceptable when nothing genuine is needed.

ai_priority guide:
  - p0: outage, blocker for the goal, customer escalation
  - p1: deadline within a sprint, unblocks another work-stream
  - p2: should-do this quarter
  - p3: nice-to-have / backlog hygiene

Return ONLY the action_items array. No prose, no explanation.`;

  const user = `Project: ${ctx.projectName} (${ctx.projectKey})
${ctx.totalOpen} open / ${ctx.totalDone} done

Recent tickets (newest first, status + priority + AI summary when available):
${ctx.ticketLines.join('\n')}

${ctx.recentDecisions.length > 0
    ? `Recent decisions:\n${ctx.recentDecisions.join('\n')}`
    : '(no recent decisions logged)'}`;

  return { system, user };
}

async function persist(projectKey: string, hubId: string, items: ProjectActions['action_items']): Promise<void> {
  const db = getLibsqlDb();
  // Replace AI-generated open items for this project hub. Keep user-edited
  // items (any non-null user_priority) and items in non-open states.
  await db
    .prepare(
      `DELETE FROM action_items
       WHERE source_item_id = ?
         AND state = 'open'
         AND user_priority IS NULL`,
    )
    .run(hubId);

  // Also clean up the legacy per-ticket AI items for tickets in this project.
  // They were the noise the user was seeing — replaced by this project-level set.
  await db
    .prepare(
      `DELETE FROM action_items
       WHERE state = 'open'
         AND user_priority IS NULL
         AND source_item_id IN (
           SELECT id FROM work_items
           WHERE source='jira'
             AND json_extract(metadata, '$.entity_key') = ?
             AND id != ?
         )`,
    )
    .run(projectKey, hubId);

  // Sequential async — each insert is independent. Atomicity across the loop
  // isn't required (idempotent project-hub regeneration).
  for (const a of items) {
    const text = a.text.trim();
    if (!text) continue;
    await db
      .prepare(
        `INSERT INTO action_items (id, source_item_id, text, assignee, due_at, ai_priority, state)
         VALUES (?, ?, ?, ?, ?, ?, 'open')`,
      )
      .run(uuid(), hubId, text, a.assignee, a.due_at, a.ai_priority);
  }
}

export async function generateProjectActionItems(
  projectKey: string,
): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
  await ensureInit();

  const ctx = await gatherContext(projectKey);
  if (!ctx) return { ok: false, reason: 'project hub not found' };
  if (ctx.ticketLines.length === 0) return { ok: false, reason: 'no tickets in project' };

  const db = getLibsqlDb();
  const hub = await db
    .prepare(`SELECT id FROM work_items WHERE source='jira' AND source_id = ?`)
    .get<{ id: string }>(`project:${projectKey}`);
  if (!hub) return { ok: false, reason: 'project hub row missing' };

  const { system, user } = buildPrompt(ctx);
  let result: ProjectActions;
  try {
    const { object } = await generateObject({
      model: getModel('extract'),
      maxOutputTokens: 1500,
      system,
      schema: ProjectActionItemsSchema,
      prompt: user,
    });
    result = object;
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  await persist(projectKey, hub.id, result.action_items);
  return { ok: true, count: result.action_items.length };
}
