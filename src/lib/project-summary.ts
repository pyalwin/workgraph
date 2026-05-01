import { generateText } from 'ai';
import { getDb } from './db';
import { getModel } from './ai';
import { inngest } from '@/inngest/client';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface SummaryCache {
  recap: string | null;
  summary_generated_at: string | null;
}

function isCacheStale(generatedAt: string | null): boolean {
  if (!generatedAt) return true;
  const age = Date.now() - new Date(generatedAt).getTime();
  return age > CACHE_TTL_MS;
}

export async function getOrGenerateSummary(projectKey: string, projectName: string): Promise<string> {
  const db = getDb();

  // Check cache
  const cached = db.prepare(
    'SELECT recap, summary_generated_at FROM project_summaries WHERE project_key = ?'
  ).get(projectKey) as SummaryCache | undefined;

  // Hot cache — return as-is.
  if (cached?.recap && !isCacheStale(cached.summary_generated_at)) {
    return cached.recap;
  }

  // Stale or cold — dispatch a durable Inngest job to regenerate. The job
  // runs in a separate worker, survives request termination, and retries
  // on failure. We return the previous value (or a computed fallback) NOW
  // so the page is instant.
  await dispatchRegen(projectKey, projectName);

  if (cached?.recap) return cached.recap;
  return computeQuickFallback(projectKey, projectName);
}

async function dispatchRegen(projectKey: string, projectName: string): Promise<void> {
  try {
    await inngest.send({
      name: 'workgraph/project-summary.regen',
      data: { projectKey, projectName },
    });
  } catch (err) {
    // If Inngest is unreachable (dev server down, network), fall back to
    // an in-process fire-and-forget. Still better than blocking the page.
    console.warn(`[project-summary] inngest.send failed, falling back to in-process: ${(err as Error).message}`);
    void generateAndStore(projectKey, projectName).catch((e) =>
      console.error(`[project-summary] in-process regen failed for ${projectKey}:`, e),
    );
  }
}

function computeQuickFallback(projectKey: string, projectName: string): string {
  const db = getDb();
  try {
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('done','closed','resolved') THEN 1 ELSE 0 END) AS done
      FROM work_items
      WHERE source = 'jira' AND json_extract(metadata, '$.project') = ?
    `).get(projectKey) as { total: number; done: number };
    const pct = counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;
    return `**Generating summary…** ${counts.total} tickets tracked (${counts.done} done, ${pct}%). Refresh in a moment for the AI-written health snapshot.`;
  } catch {
    return `**Generating summary for ${projectName}…** Refresh in a moment.`;
  }
}

// Generous limits — Gemini 2.5 Flash Lite has a 1M context window so we can
// afford to ground the AI in the full project. A compact ticket line is
// 30-80 tokens; 250 lines = ~10-20k input tokens, well under budget.
const RECAP_DONE_LIMIT = 200;
const RECAP_ACTIVE_LIMIT = 100;

export async function generateAndStore(projectKey: string, projectName: string): Promise<string> {
  const db = getDb();

  // Pull both done AND active tickets so the recap can speak to "in progress"
  // and "watch" with real grounding. The schema uses both `metadata.project`
  // (legacy) and `metadata.entity_key` (new) — match either so older items
  // aren't silently dropped.
  const projectFilter = `(json_extract(metadata, '$.project') = ? OR json_extract(metadata, '$.entity_key') = ?)`;

  const doneTickets = db.prepare(`
    SELECT source_id, title, status, summary, body, updated_at
    FROM work_items
    WHERE source = 'jira' AND ${projectFilter}
      AND status IN ('done', 'closed', 'resolved')
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT ${RECAP_DONE_LIMIT}
  `).all(projectKey, projectKey) as Array<{
    source_id: string;
    title: string;
    status: string;
    summary: string | null;
    body: string | null;
    updated_at: string | null;
  }>;

  const activeTickets = db.prepare(`
    SELECT source_id, title, status, summary, priority,
           json_extract(metadata, '$.last_commented_at') AS last_at
    FROM work_items
    WHERE source = 'jira' AND ${projectFilter}
      AND status IN ('active', 'open', 'in_progress', 'to_do')
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT ${RECAP_ACTIVE_LIMIT}
  `).all(projectKey, projectKey) as Array<{
    source_id: string;
    title: string;
    status: string;
    summary: string | null;
    priority: string | null;
    last_at: string | null;
  }>;

  if (doneTickets.length === 0 && activeTickets.length === 0) {
    const fallback = `No tickets in scope for ${projectName} yet.`;
    storeSummary(projectKey, projectName, fallback);
    return fallback;
  }

  // Status breakdown — tells the AI the volume context.
  const statusBreakdown = db.prepare(`
    SELECT status, COUNT(*) AS c
    FROM work_items
    WHERE source = 'jira' AND ${projectFilter}
    GROUP BY status
    ORDER BY c DESC
  `).all(projectKey, projectKey) as Array<{ status: string | null; c: number }>;

  // Top entity themes for context (what the project is about)
  const themes = db.prepare(`
    SELECT e.canonical_form, COUNT(DISTINCT em.item_id) AS c
    FROM entities e
    JOIN entity_mentions em ON em.entity_id = e.id
    JOIN work_items wi ON wi.id = em.item_id
    WHERE e.entity_type IN ('theme', 'capability')
      AND wi.source = 'jira' AND ${projectFilter}
    GROUP BY e.id
    ORDER BY c DESC
    LIMIT 15
  `).all(projectKey, projectKey) as Array<{ canonical_form: string; c: number }>;

  // Linked PRs — find via cross-references in the links table (cheaper than
  // the loop-and-substring scan we used to do).
  const linkedPrs = db.prepare(`
    SELECT pr.title, t.source_id AS ticket_key
    FROM work_items pr
    JOIN links l ON (l.source_item_id = pr.id OR l.target_item_id = pr.id)
    JOIN work_items t ON (t.id = l.source_item_id OR t.id = l.target_item_id)
    WHERE pr.source = 'github'
      AND t.source = 'jira' AND ${projectFilter}
      AND t.status IN ('done', 'closed', 'resolved')
      AND t.id != pr.id
    LIMIT 200
  `).all(projectKey, projectKey) as Array<{ title: string; ticket_key: string }>;

  const prsByTicket = new Map<string, string[]>();
  for (const pr of linkedPrs) {
    const arr = prsByTicket.get(pr.ticket_key) ?? [];
    arr.push(pr.title);
    prsByTicket.set(pr.ticket_key, arr);
  }

  function ticketLine(t: { source_id: string; title: string; summary: string | null; body?: string | null }) {
    const blurb = t.summary
      ? ` — ${t.summary.slice(0, 200)}`
      : t.body
        ? ` — ${t.body.replace(/\s+/g, ' ').slice(0, 160)}`
        : '';
    return `${t.source_id}: ${t.title}${blurb}`;
  }

  const doneLines = doneTickets.map((t) => {
    const prs = prsByTicket.get(t.source_id) ?? [];
    const prSuffix = prs.length > 0 ? `\n    PRs: ${prs.slice(0, 3).join(' · ')}` : '';
    return `  ${ticketLine(t)}${prSuffix}`;
  }).join('\n');

  const activeLines = activeTickets.map((t) => {
    const pri = t.priority ? `[${t.priority.toUpperCase()}] ` : '';
    return `  ${pri}${ticketLine(t)}`;
  }).join('\n');

  const statusLine = statusBreakdown
    .filter((s) => s.status)
    .map((s) => `${s.status}: ${s.c}`)
    .join(' · ');
  const themeLine = themes.map((t) => `${t.canonical_form} (${t.c})`).join(', ') || '(none extracted yet)';

  // Generate
  try {
    const { text: summary } = await generateText({
      model: getModel('project-summary'),
      maxOutputTokens: 800,
      prompt: `You are writing a detailed project health summary for an engineering leadership dashboard. Audience: VP of Engineering who wants to understand what's happening in this project at a glance.

Project: ${projectName} (${projectKey})
Status breakdown: ${statusLine || '(none)'}
Top themes: ${themeLine}

═══════════════════════════════════════
Recently completed (${doneTickets.length} of ${doneTickets.length} shown):
${doneLines || '  (none)'}
═══════════════════════════════════════
In progress (${activeTickets.length} shown):
${activeLines || '  (none)'}
═══════════════════════════════════════

Write a summary using EXACTLY this structure. Each section MUST be its own paragraph separated by a blank line:

**What shipped:** Bullet points listing 4-6 key deliverables. Group related items into themes ("Auth & SSO: …", "Catalog: …"). Each bullet names the feature in bold and briefly explains what it does or why it matters. Reference specific tickets sparingly — only when calling out a notable individual deliverable.

**In progress:** 2-3 sentences naming the major work-streams active right now. Pull from the "In progress" list above. Be specific about WHAT is being built (capabilities, surfaces, integrations), not just project codes.

**Watch:** 1-2 sentences flagging real risks visible in the data: repeated bugs (instability), areas with high churn but no shipped output, blockers, deadline pressure. If nothing concerning is genuinely visible, say so honestly.

Rules:
- Section headers (**What shipped:**, **In progress:**, **Watch:**) on their own lines with a blank line before each
- Use bullet points (- ) for the shipped section
- Bold the feature/item name with **name**
- Do NOT include a title or heading before the first section
- Do NOT repeat project name, ticket counts, completion %, or velocity — those are shown separately
- 200-350 words total
- Be specific. "Improved performance" is bad; "p95 invoice ingestion latency reduced from 12s to 3s" is good.`,
    });

    storeSummary(projectKey, projectName, summary);
    return summary;
  } catch (e) {
    console.error(`[project-summary] AI call failed for ${projectKey}:`, (e as Error).message);
    return `${projectName}: ${doneTickets.length} tickets completed recently.`;
  }
}

export async function forceRegenerateSummary(projectKey: string, projectName: string): Promise<string> {
  // Skip the cache entirely and run synchronously — the explicit refresh
  // button is the user opting into the wait.
  const db = getDb();
  db.prepare('UPDATE project_summaries SET summary_generated_at = NULL WHERE project_key = ?').run(projectKey);
  return generateAndStore(projectKey, projectName);
}

function storeSummary(projectKey: string, projectName: string, recap: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO project_summaries (project_key, name, recap, summary_generated_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_key) DO UPDATE SET
      recap = excluded.recap,
      summary_generated_at = excluded.summary_generated_at,
      updated_at = excluded.updated_at
  `).run(projectKey, projectName, recap, now, now);
}
