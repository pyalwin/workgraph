/**
 * Project README — stable, descriptive document about WHAT a project is.
 *
 * Different from `project_summaries.recap` which is a rolling status update
 * (what shipped / in progress / watch). This is the *identity* of the
 * project: purpose, scope, key components, recurring themes, and the
 * people who live in it.
 *
 * Generated once on first sync, and on demand via the "Regenerate README"
 * action. The OKR generator uses this as grounding for its prompts.
 */
import { generateText } from 'ai';
import { getDb } from '../db';
import { initSchema } from '../schema';
import { getModel } from '../ai';

// Generous — Gemini 2.5 Flash Lite has a 1M context window. Per-ticket
// lines are ~30-80 tokens, so 300 tickets is ~10-25k tokens of input,
// well under the practical budget. The point of the README is "what is
// this project" — needs to see most/all of the work to extract themes
// accurately.
const TICKET_LIMIT = 300;
const ENTITY_LIMIT = 30;

interface ReadmeContext {
  projectKey: string;
  projectName: string;
  totalDone: number;
  totalActive: number;
  totalBacklog: number;
  earliestActivity: string | null;
  latestActivity: string | null;
  ticketLines: string[];
  topThemes: Array<{ canonical: string; count: number }>;
  topCapabilities: Array<{ canonical: string; count: number }>;
  topSystems: Array<{ canonical: string; count: number }>;
  topActors: Array<{ name: string; count: number }>;
  recentDecisions: string[];
}

function gatherContext(projectKey: string): ReadmeContext | null {
  const db = getDb();

  const projectRow = db
    .prepare(`SELECT title FROM work_items WHERE source='jira' AND source_id = ?`)
    .get(`project:${projectKey}`) as { title: string } | undefined;
  if (!projectRow) return null;

  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('done','closed','resolved') THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status IN ('active','open','in_progress','to_do') THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status='backlog' THEN 1 ELSE 0 END) AS backlog,
         MIN(created_at) AS earliest,
         MAX(COALESCE(updated_at, created_at)) AS latest
       FROM work_items
       WHERE source='jira' AND json_extract(metadata, '$.entity_key') = ?`,
    )
    .get(projectKey) as { done: number; active: number; backlog: number; earliest: string | null; latest: string | null };

  const tickets = db
    .prepare(
      `SELECT source_id, title, status, summary, item_type
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
      item_type: string;
    }>;

  // Compact format — title + status. Use AI summary when present; otherwise
  // omit the body entirely. Per-ticket overhead drops from ~250 chars to
  // ~80 chars when there's no summary, letting us include 3-4× more tickets
  // in the same token budget.
  const ticketLines = tickets.map((t) => {
    const status = (t.status ?? 'unknown').padEnd(8);
    const blurb = t.summary ? ` — ${t.summary.slice(0, 180)}` : '';
    return `[${status}] ${t.source_id} (${t.item_type}): ${t.title}${blurb}`;
  });

  // Top entities by mention count, scoped to this project
  function topEntities(entityType: string) {
    return db
      .prepare(
        `SELECT e.canonical_form AS canonical, COUNT(DISTINCT em.item_id) AS c
         FROM entities e
         JOIN entity_mentions em ON em.entity_id = e.id
         JOIN work_items wi ON wi.id = em.item_id
         WHERE e.entity_type = ?
           AND wi.source='jira'
           AND json_extract(wi.metadata, '$.entity_key') = ?
         GROUP BY e.id
         ORDER BY c DESC
         LIMIT ?`,
      )
      .all(entityType, projectKey, ENTITY_LIMIT) as Array<{ canonical: string; c: number }>;
  }

  const topThemes = topEntities('theme').map((r) => ({ canonical: r.canonical, count: r.c }));
  const topCapabilities = topEntities('capability').map((r) => ({ canonical: r.canonical, count: r.c }));
  const topSystems = topEntities('system').map((r) => ({ canonical: r.canonical, count: r.c }));

  // Most active people on this project (assignees + reporters)
  const actors = db
    .prepare(
      `SELECT author AS name, COUNT(*) AS c
       FROM work_items
       WHERE source='jira' AND json_extract(metadata, '$.entity_key') = ?
         AND author IS NOT NULL AND author != ''
       GROUP BY author
       ORDER BY c DESC LIMIT 8`,
    )
    .all(projectKey) as Array<{ name: string; c: number }>;

  const recentDecisions = (
    db
      .prepare(
        `SELECT d.title, d.summary FROM decisions d
         JOIN work_items wi ON wi.id = d.item_id
         WHERE wi.source='jira' AND json_extract(wi.metadata, '$.entity_key') = ?
         ORDER BY d.decided_at DESC LIMIT 8`,
      )
      .all(projectKey) as Array<{ title: string; summary: string | null }>
  ).map((d) => `- ${d.title}${d.summary ? ` — ${d.summary.slice(0, 200)}` : ''}`);

  return {
    projectKey,
    projectName: projectRow.title,
    totalDone: counts.done ?? 0,
    totalActive: counts.active ?? 0,
    totalBacklog: counts.backlog ?? 0,
    earliestActivity: counts.earliest,
    latestActivity: counts.latest,
    ticketLines,
    topThemes,
    topCapabilities,
    topSystems,
    topActors: actors.map((r) => ({ name: r.name, count: r.c })),
    recentDecisions,
  };
}

function buildPrompt(ctx: ReadmeContext): { system: string; user: string } {
  const system = `You write a project README — a STABLE, DESCRIPTIVE document about what a project is.

It is NOT a status update. Don't write about velocity, what shipped this sprint, what's in progress, or what to watch. That belongs in the rolling recap, not the README.

Structure (use these exact h2 headings):

  ## Purpose
  2–3 sentences explaining why the project exists and the user/business
  problem it solves. Concrete and specific, no platitudes.

  ## Scope
  What the project owns. Use sub-sections or bullets for major areas.
  If anything is conspicuously NOT in scope based on the ticket data,
  call it out under "Out of scope".

  ## Key components
  The technical surfaces, products, or capabilities the project covers.
  Bullet list with short descriptions. Pull from the system + capability
  entities in the input.

  ## Themes
  Recurring topics that run through the work — architecture choices,
  product directions, integration patterns, etc. Bullet list.

  ## Owners and contributors
  The most active people on this project, with a one-line role guess
  based on what they tend to work on. Bullet list with names + role.

Length budget: 250–400 words total. Imperative voice when describing
what the project does. No emoji. Don't reference Jira, ticket counts,
or this prompt.`;

  const themeStr = ctx.topThemes.slice(0, 12).map((t) => `${t.canonical} (${t.count})`).join(', ') || '(none)';
  const capStr = ctx.topCapabilities.slice(0, 12).map((t) => `${t.canonical} (${t.count})`).join(', ') || '(none)';
  const sysStr = ctx.topSystems.slice(0, 12).map((t) => `${t.canonical} (${t.count})`).join(', ') || '(none)';
  const actorStr = ctx.topActors.map((a) => `${a.name} (${a.count})`).join(', ') || '(none)';

  const user = `Project: ${ctx.projectName} (${ctx.projectKey})
Lifetime activity: ${ctx.totalDone + ctx.totalActive + ctx.totalBacklog} items
  ${ctx.totalDone} done, ${ctx.totalActive} active, ${ctx.totalBacklog} in backlog
Earliest activity: ${ctx.earliestActivity ?? 'unknown'}
Most recent activity: ${ctx.latestActivity ?? 'unknown'}

Top recurring themes: ${themeStr}
Top capabilities touched: ${capStr}
Top systems involved: ${sysStr}
Most active people: ${actorStr}

Sample tickets (newest first, status + AI summary when available):
${ctx.ticketLines.slice(0, 50).join('\n')}

${ctx.recentDecisions.length > 0
    ? `Recent decisions:\n${ctx.recentDecisions.join('\n')}`
    : '(no decisions logged)'}`;

  return { system, user };
}

export async function generateProjectReadme(
  projectKey: string,
): Promise<{ ok: true; length: number } | { ok: false; reason: string }> {
  initSchema();

  const ctx = gatherContext(projectKey);
  if (!ctx) return { ok: false, reason: 'project hub not found' };
  if (ctx.ticketLines.length === 0) return { ok: false, reason: 'no tickets in project' };

  const { system, user } = buildPrompt(ctx);
  let readme: string;
  try {
    const { text } = await generateText({
      model: getModel('narrative'),
      maxOutputTokens: 1500,
      system,
      prompt: user,
    });
    readme = text.trim();
    if (!readme) return { ok: false, reason: 'AI returned empty content' };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO project_summaries (project_key, name, readme, readme_generated_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(project_key) DO UPDATE SET
       readme = excluded.readme,
       readme_generated_at = excluded.readme_generated_at,
       updated_at = excluded.updated_at`,
  ).run(projectKey, ctx.projectName, readme);

  return { ok: true, length: readme.length };
}

export function getProjectReadme(projectKey: string): { readme: string | null; generatedAt: string | null } {
  const db = getDb();
  const row = db
    .prepare(`SELECT readme, readme_generated_at FROM project_summaries WHERE project_key = ?`)
    .get(projectKey) as { readme: string | null; readme_generated_at: string | null } | undefined;
  return {
    readme: row?.readme ?? null,
    generatedAt: row?.readme_generated_at ?? null,
  };
}
