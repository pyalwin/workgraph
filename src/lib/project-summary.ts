import Anthropic from '@anthropic-ai/sdk';
import { getDb } from './db';

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

  if (cached?.recap && !isCacheStale(cached.summary_generated_at)) {
    return cached.recap;
  }

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
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are writing a detailed project health summary for an engineering leadership dashboard. The audience is a VP of Engineering who wants to understand what's happening in this project at a glance.

Project: ${projectName} (${projectKey})

Recent completed tickets and their linked PRs:
${ticketSummaries}

Write a rich, descriptive summary using this structure:

**What shipped:** 3-5 sentences describing the key features and improvements delivered. Group related work into themes (e.g., "infrastructure", "user-facing features", "bug fixes"). Name specific features, APIs, integrations, or systems that were built or improved. Explain *what* each feature does, not just its name.

**What's in progress:** 1-2 sentences about active work if evident from ticket titles — what's being built next and why it matters.

**Risks & attention areas:** 1-2 sentences flagging any concerning patterns — stale tickets, areas with repeated bug fixes (indicating instability), missing test coverage, or dependency bottlenecks.

Rules:
- Use markdown: **bold** for feature names and emphasis, bullet points where helpful for readability
- Do NOT include a title or heading — jump straight into "**What shipped:**"
- Do NOT repeat the project name, raw ticket counts, completion percentages, or velocity numbers — those are shown separately in the dashboard signals
- Write 150-250 words total
- Be specific and descriptive — a reader should understand what was actually built without looking at the ticket list`,
      }],
    });

    const summary = response.content[0].type === 'text' ? response.content[0].text : '';
    storeSummary(projectKey, projectName, summary);
    return summary;
  } catch (e) {
    // If API fails, return cached or fallback
    return cached?.recap || `${projectName}: ${tickets.length} tickets completed recently.`;
  }
}

export async function forceRegenerateSummary(projectKey: string, projectName: string): Promise<string> {
  // Clear the timestamp to force regeneration
  const db = getDb();
  db.prepare('UPDATE project_summaries SET summary_generated_at = NULL WHERE project_key = ?').run(projectKey);
  return getOrGenerateSummary(projectKey, projectName);
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
