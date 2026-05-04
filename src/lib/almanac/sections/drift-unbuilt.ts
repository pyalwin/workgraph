/**
 * Drift — unbuilt tickets section.
 * Lists "done" Jira tickets that have no linked code events.
 * Skeleton only; agent narration fills prose.
 */
import { getLibsqlDb } from '@/lib/db/libsql';
import type { ProjectDossier } from '../dossier-builder';
import type { SectionOutput } from './cover';

interface UnbuiltTicket {
  source_id: string;
  title: string | null;
  status: string | null;
  created_at: string | null;
  resolved_at: string | null;   // proxied from work_items.updated_at — there is no resolved_at column
}

export async function buildDriftUnbuiltSection(
  workspaceId: string,
  projectKey: string,
  pd: ProjectDossier,
): Promise<SectionOutput> {
  const db = getLibsqlDb();

  // work_items has no resolved_at column; use updated_at as the proxy for
  // "when the ticket reached done state". Filter to project_key by source_id prefix.
  const rows = await db
    .prepare(
      `SELECT wi.source_id, wi.title, wi.status, wi.created_at, wi.updated_at AS resolved_at
       FROM work_items wi
       WHERE wi.source = 'jira'
         AND wi.status = 'done'
         AND wi.source_id LIKE ?
         AND NOT EXISTS (
           SELECT 1 FROM code_events ce WHERE ce.linked_item_id = wi.id
         )
       ORDER BY wi.updated_at DESC
       LIMIT 50`,
    )
    .all<UnbuiltTicket>(`${projectKey}-%`);

  const diagramBlock = {
    type: 'drift_heatmap',
    params: {
      kind: 'unbuilt',
      project_key: projectKey,
      ticket_count: pd.drift_unbuilt,
    },
  };

  const ticketTable =
    rows.length === 0
      ? '_No unbuilt tickets found — all done tickets have linked code._'
      : rows
          .map(
            (r) =>
              `| ${r.source_id} | ${truncate(r.title ?? '', 80)} | ${r.resolved_at?.slice(0, 10) ?? '—'} |`,
          )
          .join('\n');

  const markdown = `## Unbuilt Tickets (Drift) **[draft]**

${pd.drift_unbuilt === 0 ? '✓ All done tickets have linked code events.' : `**${pd.drift_unbuilt} done tickets** have no linked code events.`}

:::diagram type=drift_heatmap params=${JSON.stringify(diagramBlock.params)}:::

### Done Tickets without Code Links (most recent 50)

| Key | Title | Resolved |
|-----|-------|----------|
${ticketTable}
`;

  const source_hash_inputs = {
    kind: 'drift_unbuilt',
    project_key: projectKey,
    drift_unbuilt: pd.drift_unbuilt,
    sampled_keys: rows.map((r) => r.source_id),
  };

  return { title: 'Unbuilt Tickets', markdown, diagram_blocks: [diagramBlock], source_hash_inputs };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
