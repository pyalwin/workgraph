/**
 * Drift — unticketed work section.
 * Lists signal code events that have no linked Jira ticket.
 * Skeleton only; agent narration fills prose.
 */
import { getLibsqlDb } from '@/lib/db/libsql';
import type { ProjectDossier } from '../dossier-builder';
import type { SectionOutput } from './cover';

interface UnticketedEvent {
  sha: string;
  occurred_at: string;
  message: string | null;
  author_login: string | null;
  additions: number;
  deletions: number;
  unit_name: string | null;
}

export async function buildDriftUnticketedSection(
  workspaceId: string,
  projectKey: string,
  pd: ProjectDossier,
): Promise<SectionOutput> {
  const db = getLibsqlDb();

  const rows = await db
    .prepare(
      `SELECT ce.sha, ce.occurred_at, ce.message, ce.author_login,
              ce.additions, ce.deletions, fu.name AS unit_name
       FROM code_events ce
       LEFT JOIN functional_units fu ON fu.id = ce.functional_unit_id
       WHERE ce.workspace_id = ?
         AND ce.is_feature_evolution = 1
         AND ce.ticket_link_status = 'unlinked'
         AND ce.functional_unit_id IN (
           SELECT id FROM functional_units WHERE project_key = ? AND workspace_id = ?
         )
       ORDER BY ce.occurred_at DESC
       LIMIT 50`,
    )
    .all<UnticketedEvent>(workspaceId, projectKey, workspaceId);

  const diagramBlock = {
    type: 'drift_heatmap',
    params: {
      kind: 'unticketed',
      project_key: projectKey,
      event_count: pd.drift_unticketed,
    },
  };

  const eventTable =
    rows.length === 0
      ? '_No unticketed signal events found._'
      : rows
          .map(
            (r) =>
              `| ${r.occurred_at.slice(0, 10)} | ${r.sha.slice(0, 7)} | ${r.unit_name ?? '—'} | ${truncate(r.message ?? '', 80)} |`,
          )
          .join('\n');

  const markdown = `## Unticketed Work (Drift) **[draft]**

${pd.drift_unticketed === 0 ? '✓ No unticketed signal events found — full ticket coverage.' : `**${pd.drift_unticketed} signal events** have no linked Jira ticket.`}

:::diagram type=drift_heatmap params=${JSON.stringify(diagramBlock.params)}:::

### Events without Ticket Links (most recent 50)

| Date | SHA | Unit | Message |
|------|-----|------|---------|
${eventTable}
`;

  const source_hash_inputs = {
    kind: 'drift_unticketed',
    project_key: projectKey,
    drift_unticketed: pd.drift_unticketed,
    sampled_shas: rows.map((r) => r.sha),
  };

  return { title: 'Unticketed Work', markdown, diagram_blocks: [diagramBlock], source_hash_inputs };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
