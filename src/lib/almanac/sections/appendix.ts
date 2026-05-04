/**
 * Appendix section — file lifecycle table + full ticket list.
 * Purely tabular; no LLM narration expected here.
 */
import { getLibsqlDb } from '@/lib/db/libsql';
import type { ProjectDossier } from '../dossier-builder';
import type { SectionOutput } from './cover';

interface FileRow {
  path: string;
  status: string;
  churn: number;
  first_at: string | null;
  last_at: string | null;
}

interface TicketRow {
  source_id: string;
  title: string | null;
  status: string | null;
  created_at: string | null;
}

export async function buildAppendixSection(
  workspaceId: string,
  projectKey: string,
  pd: ProjectDossier,
): Promise<SectionOutput> {
  const db = getLibsqlDb();

  // Top 100 files by churn across all project units
  const unitIds = pd.units_summary.map((u) => u.unit_id);
  let fileRows: FileRow[] = [];
  if (unitIds.length > 0) {
    // Get all file paths from code_events for the project
    const placeholders = unitIds.map(() => '?').join(',');
    const pathRows = await db
      .prepare(
        `SELECT DISTINCT value AS path
         FROM code_events, json_each(code_events.files_touched)
         WHERE code_events.workspace_id = ?
           AND code_events.functional_unit_id IN (${placeholders})
           AND code_events.is_feature_evolution = 1
         LIMIT 500`,
      )
      .all<{ path: string }>(workspaceId, ...unitIds);

    if (pathRows.length > 0) {
      const paths = pathRows.map((r) => r.path).slice(0, 200);
      const filePlaceholders = paths.map(() => '?').join(',');
      fileRows = await db
        .prepare(
          `SELECT path, status, churn, first_at, last_at
           FROM file_lifecycle
           WHERE path IN (${filePlaceholders})
           ORDER BY churn DESC
           LIMIT 100`,
        )
        .all<FileRow>(...paths);
    }
  }

  // All project tickets (not capped — appendix is a reference section)
  const ticketRows = await db
    .prepare(
      `SELECT wi.source_id, wi.title, wi.status, wi.created_at
       FROM work_items wi
       WHERE wi.source = 'jira'
         AND wi.source_id LIKE ?
       ORDER BY wi.created_at ASC`,
    )
    .all<TicketRow>(`${projectKey}-%`);

  const fileTable =
    fileRows.length === 0
      ? '_No file lifecycle data available._'
      : fileRows
          .map((f) => `| \`${f.path}\` | ${f.status} | ${f.churn} | ${f.first_at?.slice(0, 10) ?? '—'} | ${f.last_at?.slice(0, 10) ?? '—'} |`)
          .join('\n');

  const ticketTable =
    ticketRows.length === 0
      ? '_No tickets found._'
      : ticketRows
          .map((t) => `| ${t.source_id} | ${truncate(t.title ?? '', 80)} | ${t.status ?? '—'} | ${t.created_at?.slice(0, 10) ?? '—'} |`)
          .join('\n');

  const markdown = `## Appendix

### File Lifecycle (top ${fileRows.length} by churn)

| Path | Status | Churn | First Seen | Last Seen |
|------|--------|-------|-----------|----------|
${fileTable}

### All Tickets (${ticketRows.length})

| Key | Title | Status | Created |
|-----|-------|--------|---------|
${ticketTable}
`;

  const source_hash_inputs = {
    kind: 'appendix',
    project_key: projectKey,
    file_count: fileRows.length,
    ticket_count: ticketRows.length,
    unit_ids: unitIds,
  };

  return { title: 'Appendix', markdown, diagram_blocks: [], source_hash_inputs };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
