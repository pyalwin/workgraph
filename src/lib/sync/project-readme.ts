/**
 * Project README — stable, descriptive document about WHAT a project is.
 *
 * Different from `project_summaries.recap` which is a rolling status update
 * (what shipped / in progress / watch). This is the *identity* of the
 * project: purpose, scope, key components, recurring themes, and the
 * people who live in it.
 *
 * Architecture: map-reduce. Stuffing 200+ tickets into a single LLM
 * prompt suffers from "lost-in-the-middle" — the model anchors on the
 * first/last items and skims the middle, even with a 1M-token window.
 *
 *   MAP    — chunk tickets (40 each), extract structured insights
 *            per chunk via generateObject + Zod (themes, capabilities,
 *            systems, notable items, 1-line summary)
 *   REDUCE — merge per-chunk insights + project aggregates into a final
 *            README via one generateText call. The reducer never sees
 *            raw tickets, only the high-signal extracted data, so it
 *            can produce a coherent narrative without losing items.
 *
 * Generated once on first sync, and on demand via the "Regenerate README"
 * action. The OKR generator uses this as grounding for its prompts.
 */
import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { getModel } from '../ai';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

const TICKET_LIMIT = 1000;        // hard ceiling per project
const CHUNK_SIZE = 40;            // tickets per map-call
const MAX_CHUNKS = 25;            // 25 × 40 = 1000 tickets max
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

async function gatherContext(projectKey: string): Promise<ReadmeContext | null> {
  const db = getLibsqlDb();

  const projectRow = await db
    .prepare(`SELECT title FROM work_items WHERE source='jira' AND source_id = ?`)
    .get<{ title: string }>(`project:${projectKey}`);
  if (!projectRow) return null;

  // Match BOTH metadata.project (legacy) and metadata.entity_key (Phase 1.2+)
  // so older tickets that only have the project field still surface. Excludes
  // the synthetic project hub + parent placeholders because neither field is
  // set on those derived rows.
  const projectFilter = `(json_extract(metadata, '$.project') = ? OR json_extract(metadata, '$.entity_key') = ?)`;

  const counts = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('done','closed','resolved') THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status IN ('active','open','in_progress','to_do') THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status='backlog' THEN 1 ELSE 0 END) AS backlog,
         MIN(created_at) AS earliest,
         MAX(COALESCE(updated_at, created_at)) AS latest
       FROM work_items
       WHERE source='jira' AND ${projectFilter}`,
    )
    .get<{ done: number; active: number; backlog: number; earliest: string | null; latest: string | null }>(
      projectKey,
      projectKey,
    );

  const tickets = await db
    .prepare(
      `SELECT source_id, title, status, summary, item_type
       FROM work_items
       WHERE source='jira' AND ${projectFilter}
       ORDER BY COALESCE(updated_at, created_at) DESC
       LIMIT ?`,
    )
    .all<{
      source_id: string;
      title: string;
      status: string | null;
      summary: string | null;
      item_type: string;
    }>(projectKey, projectKey, TICKET_LIMIT);

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
  async function topEntities(entityType: string) {
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
      .all<{ canonical: string; c: number }>(entityType, projectKey, ENTITY_LIMIT);
  }

  const topThemes = (await topEntities('theme')).map((r) => ({ canonical: r.canonical, count: r.c }));
  const topCapabilities = (await topEntities('capability')).map((r) => ({ canonical: r.canonical, count: r.c }));
  const topSystems = (await topEntities('system')).map((r) => ({ canonical: r.canonical, count: r.c }));

  // Most active people on this project (assignees + reporters)
  const actors = await db
    .prepare(
      `SELECT author AS name, COUNT(*) AS c
       FROM work_items
       WHERE source='jira' AND ${projectFilter}
         AND author IS NOT NULL AND author != ''
       GROUP BY author
       ORDER BY c DESC LIMIT 8`,
    )
    .all<{ name: string; c: number }>(projectKey, projectKey);

  const decisionRows = await db
    .prepare(
      `SELECT d.title, d.summary FROM decisions d
       JOIN work_items wi ON wi.id = d.item_id
       WHERE wi.source='jira'
         AND (json_extract(wi.metadata, '$.project') = ? OR json_extract(wi.metadata, '$.entity_key') = ?)
       ORDER BY d.decided_at DESC LIMIT 8`,
    )
    .all<{ title: string; summary: string | null }>(projectKey, projectKey);
  const recentDecisions = decisionRows.map(
    (d) => `- ${d.title}${d.summary ? ` — ${d.summary.slice(0, 200)}` : ''}`,
  );

  return {
    projectKey,
    projectName: projectRow.title,
    totalDone: counts?.done ?? 0,
    totalActive: counts?.active ?? 0,
    totalBacklog: counts?.backlog ?? 0,
    earliestActivity: counts?.earliest ?? null,
    latestActivity: counts?.latest ?? null,
    ticketLines,
    topThemes,
    topCapabilities,
    topSystems,
    topActors: actors.map((r) => ({ name: r.name, count: r.c })),
    recentDecisions,
  };
}

// ─── MAP step: per-chunk insight extraction ───────────────────────────────

const ChunkInsightSchema = z.object({
  themes: z
    .array(z.string())
    .describe('High-level topics this chunk reveals — short noun phrases.'),
  capabilities: z
    .array(z.string())
    .describe('Product capabilities or features touched in this chunk.'),
  systems: z
    .array(z.string())
    .describe('Technical surfaces / services / repos involved.'),
  notable_items: z
    .array(
      z.object({
        source_id: z.string().describe('e.g. OA-247'),
        why: z.string().describe('1 line on why this is notable for the project'),
      }),
    )
    .max(3)
    .describe('Up to 3 individual tickets that are notable on their own.'),
  chunk_summary: z
    .string()
    .describe(
      '1 sentence summarizing what this batch of tickets is collectively about. Concrete, specific.',
    ),
});

type ChunkInsight = z.infer<typeof ChunkInsightSchema>;

async function extractChunkInsights(
  chunkIdx: number,
  totalChunks: number,
  ticketLines: string[],
): Promise<ChunkInsight | null> {
  const system = `You read a chunk of project tickets and extract structured insights for a project README.

Output:
  - themes: short noun phrases describing recurring topics in THESE tickets
  - capabilities: product capabilities or features touched
  - systems: technical surfaces / services / repos involved
  - notable_items: up to 3 individual tickets that stand out (source_id + 1-line why)
  - chunk_summary: 1 sentence on what this batch is collectively about

Be specific. "Authentication" is too generic; "OAuth flow for Slack" is good.
Don't fabricate. If a category has nothing genuine, return an empty array.
This is one of ${totalChunks} chunks; another caller will merge them later — don't try to write the README itself.`;

  const user = `Chunk ${chunkIdx + 1} of ${totalChunks} (${ticketLines.length} tickets):

${ticketLines.join('\n')}`;

  try {
    const { object } = await generateObject({
      model: getModel('extract'),
      maxOutputTokens: 1200,
      system,
      schema: ChunkInsightSchema,
      prompt: user,
    });
    return object;
  } catch (err) {
    console.error(`[project-readme] chunk ${chunkIdx + 1}/${totalChunks} extract failed:`, (err as Error).message);
    return null;
  }
}

// ─── REDUCE step: synthesize chunk insights into the README ───────────────

interface ReduceInput {
  ctx: ReadmeContext;
  chunkInsights: ChunkInsight[];
}

function dedupeWithCounts(items: string[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const raw of items) {
    const name = raw.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

async function reduceToReadme(input: ReduceInput): Promise<string | null> {
  const { ctx, chunkInsights } = input;

  // Merge per-chunk extractions across all chunks. The reducer never sees
  // raw tickets — only these aggregated, ranked findings + the project-wide
  // entity counts we already pre-computed via SQL.
  const allChunkThemes = chunkInsights.flatMap((c) => c.themes);
  const allChunkCapabilities = chunkInsights.flatMap((c) => c.capabilities);
  const allChunkSystems = chunkInsights.flatMap((c) => c.systems);
  const allNotable = chunkInsights.flatMap((c) => c.notable_items);

  const mergedThemes = dedupeWithCounts(allChunkThemes).slice(0, 20);
  const mergedCapabilities = dedupeWithCounts(allChunkCapabilities).slice(0, 20);
  const mergedSystems = dedupeWithCounts(allChunkSystems).slice(0, 20);

  const chunkSummaries = chunkInsights
    .map((c, i) => `  ${i + 1}. ${c.chunk_summary}`)
    .join('\n');

  const system = `You write a project README — a STABLE, DESCRIPTIVE document about what a project is.

It is NOT a status update. Don't write about velocity, what shipped this sprint, what's in progress, or what to watch — that belongs in the rolling recap.

Structure (use these exact h2 headings):

  ## Purpose
  2–3 sentences explaining why the project exists and the user/business
  problem it solves. Concrete and specific, no platitudes.

  ## Scope
  What the project owns. Use sub-sections or bullets for major areas.
  If anything is conspicuously NOT in scope based on the data, call it
  out under "Out of scope".

  ## Key components
  The technical surfaces, products, or capabilities the project covers.
  Bullet list with short descriptions. Pull primarily from the merged
  capabilities and systems lists.

  ## Themes
  Recurring topics that run through the work — architecture choices,
  product directions, integration patterns, etc. Bullet list. Pull from
  the merged themes list and the chunk-by-chunk summaries.

  ## Owners and contributors
  The most active people on this project, with a one-line role guess
  based on what they tend to work on.

Length budget: 300–500 words total. Imperative voice. No emoji. Don't
reference Jira, ticket counts, prompt internals, or this instruction.`;

  const themeStr = mergedThemes.map((t) => `${t.name} (×${t.count})`).join(', ') || '(none)';
  const capStr = mergedCapabilities.map((t) => `${t.name} (×${t.count})`).join(', ') || '(none)';
  const sysStr = mergedSystems.map((t) => `${t.name} (×${t.count})`).join(', ') || '(none)';
  const aggThemes = ctx.topThemes.slice(0, 15).map((t) => `${t.canonical} (${t.count})`).join(', ') || '(none)';
  const aggCaps = ctx.topCapabilities.slice(0, 15).map((t) => `${t.canonical} (${t.count})`).join(', ') || '(none)';
  const aggSys = ctx.topSystems.slice(0, 15).map((t) => `${t.canonical} (${t.count})`).join(', ') || '(none)';
  const actorStr = ctx.topActors.map((a) => `${a.name} (${a.count})`).join(', ') || '(none)';
  const notableStr = allNotable.slice(0, 12).map((n) => `  - ${n.source_id}: ${n.why}`).join('\n') || '  (none)';

  const user = `Project: ${ctx.projectName} (${ctx.projectKey})
Lifetime: ${ctx.totalDone + ctx.totalActive + ctx.totalBacklog} items
  ${ctx.totalDone} done · ${ctx.totalActive} active · ${ctx.totalBacklog} backlog
Time span: ${ctx.earliestActivity ?? 'unknown'} → ${ctx.latestActivity ?? 'unknown'}

═════ Cross-chunk findings (extracted per-chunk, then merged with counts) ═════

Themes (×N = how many chunks raised this):
  ${themeStr}

Capabilities:
  ${capStr}

Systems:
  ${sysStr}

Notable individual items:
${notableStr}

Chunk-by-chunk summaries (each = ~${CHUNK_SIZE} tickets):
${chunkSummaries}

═════ Pre-extracted entity index (across the entire project, AI-tagged earlier) ═════

Top theme entities: ${aggThemes}
Top capability entities: ${aggCaps}
Top system entities: ${aggSys}
Most active people: ${actorStr}

${ctx.recentDecisions.length > 0
    ? `Recent decisions:\n${ctx.recentDecisions.join('\n')}`
    : '(no decisions logged)'}`;

  try {
    const { text } = await generateText({
      model: getModel('narrative'),
      maxOutputTokens: 2000,
      system,
      prompt: user,
    });
    return text.trim();
  } catch (err) {
    console.error(`[project-readme] reduce failed:`, (err as Error).message);
    return null;
  }
}

export async function generateProjectReadme(
  projectKey: string,
): Promise<{ ok: true; length: number; chunks: number } | { ok: false; reason: string }> {
  await ensureInit();

  const ctx = await gatherContext(projectKey);
  if (!ctx) return { ok: false, reason: 'project hub not found' };
  if (ctx.ticketLines.length === 0) return { ok: false, reason: 'no tickets in project' };

  // MAP — split tickets into chunks of CHUNK_SIZE, extract insights from each
  // in parallel.
  const chunks: string[][] = [];
  for (let i = 0; i < ctx.ticketLines.length && chunks.length < MAX_CHUNKS; i += CHUNK_SIZE) {
    chunks.push(ctx.ticketLines.slice(i, i + CHUNK_SIZE));
  }

  const chunkResults = await Promise.all(
    chunks.map((lines, idx) => extractChunkInsights(idx, chunks.length, lines)),
  );
  const chunkInsights = chunkResults.filter((c): c is ChunkInsight => c !== null);
  if (chunkInsights.length === 0) return { ok: false, reason: 'all chunk extractions failed' };

  // REDUCE — merge insights into the final README
  const readme = await reduceToReadme({ ctx, chunkInsights });
  if (!readme) return { ok: false, reason: 'reduce step failed' };

  const db = getLibsqlDb();
  await db
    .prepare(
      `INSERT INTO project_summaries (project_key, name, readme, readme_generated_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(project_key) DO UPDATE SET
         readme = excluded.readme,
         readme_generated_at = excluded.readme_generated_at,
         updated_at = excluded.updated_at`,
    )
    .run(projectKey, ctx.projectName, readme);

  return { ok: true, length: readme.length, chunks: chunkInsights.length };
}

export async function getProjectReadme(projectKey: string): Promise<{ readme: string | null; generatedAt: string | null }> {
  await ensureInit();
  const db = getLibsqlDb();
  const row = await db
    .prepare(`SELECT readme, readme_generated_at FROM project_summaries WHERE project_key = ?`)
    .get<{ readme: string | null; readme_generated_at: string | null }>(projectKey);
  return {
    readme: row?.readme ?? null,
    generatedAt: row?.readme_generated_at ?? null,
  };
}
