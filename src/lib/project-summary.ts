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

export async function generateAndStore(projectKey: string, projectName: string): Promise<string> {
  const db = getDb();

  // Gather context for the summary
  const tickets = db.prepare(`
    SELECT source_id, title, status, body FROM work_items
    WHERE source = 'jira' AND json_extract(metadata, '$.project') = ?
      AND status IN ('done', 'closed', 'resolved')
    ORDER BY updated_at DESC
    LIMIT 30
  `).all(projectKey) as { source_id: string; title: string; status: string; body: string | null }[];

  // Find linked PRs for these tickets
  const allPRs = db.prepare(`
    SELECT source_id, title FROM work_items WHERE source = 'github'
  `).all() as { source_id: string; title: string }[];

  const ticketSummaries = tickets.map(t => {
    const linkedPRs = allPRs.filter(pr => {
      const text = pr.title + ' ' + pr.source_id;
      return text.includes(t.source_id);
    });
    const prList = linkedPRs.length > 0
      ? linkedPRs.map(pr => `  - PR: ${pr.title}`).join('\n')
      : '';
    return `${t.source_id}: ${t.title}${prList ? '\n' + prList : ''}`;
  }).join('\n');

  if (tickets.length === 0) {
    const fallback = `No recently completed tickets for ${projectName}.`;
    storeSummary(projectKey, projectName, fallback);
    return fallback;
  }

  // Generate via Claude Haiku
  try {
    const { text: summary } = await generateText({
      model: getModel('project-summary'),
      maxOutputTokens: 500,
      prompt: `You are writing a detailed project health summary for an engineering leadership dashboard. The audience is a VP of Engineering who wants to understand what's happening in this project at a glance.

Project: ${projectName} (${projectKey})

Recent completed tickets and their linked PRs:
${ticketSummaries}

Write a rich, descriptive summary using EXACTLY this structure. Each section MUST be its own paragraph separated by a blank line:

**What shipped:** Use bullet points to list 3-5 key deliverables. Each bullet should name the feature and briefly explain what it does or why it matters. Group related items.

**In progress:** 1-2 sentences about active work — what's being built next.

**Watch:** 1-2 sentences flagging risks — repeated bug fixes (instability), stale areas, or bottlenecks.

Example format:
**What shipped:**
- **Feature name** — what it does and why it matters
- **Another feature** — brief explanation
- **Bug fix area** — what was fixed and the impact

**In progress:** Description of active work.

**Watch:** Any risks or areas needing attention.

Rules:
- Each section header (**What shipped:**, **In progress:**, **Watch:**) must start on its own line with a blank line before it
- Use bullet points (- ) for the shipped section, not prose paragraphs
- Bold the feature/item name in each bullet with **name**
- Do NOT include a title or heading before the first section
- Do NOT repeat project name, ticket counts, completion %, or velocity — shown separately in dashboard
- 150-250 words total`,
    });

    storeSummary(projectKey, projectName, summary);
    return summary;
  } catch (e) {
    // Surface to dev-server stderr so the failure is debuggable.
    console.error(`[project-summary] AI call failed for ${projectKey}:`, (e as Error).message);
    return `${projectName}: ${tickets.length} tickets completed recently.`;
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
