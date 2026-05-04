/**
 * Unit section generator — deterministic skeleton per functional unit.
 * Prose replaced by agent narration. Diagram fences emit lifespan_strip
 * blocks the Phase 5 renderer interprets.
 */
import type { UnitDossier } from '../dossier-builder';
import type { SectionOutput } from './cover';

export function buildUnitSection(ud: UnitDossier): SectionOutput {
  const title = ud.unit_name;

  const lifespanParams = {
    unit_id: ud.unit_id,
    events: ud.events.map((e) => ({ sha: e.sha, occurred_at: e.occurred_at, role: e.role })),
  };

  const diagramBlock = {
    type: 'lifespan_strip',
    params: lifespanParams,
  };

  const ticketList =
    ud.tickets.length === 0
      ? '_No linked Jira tickets._'
      : ud.tickets
          .map((t) => `| ${t.source_id} | ${t.title} | ${t.status ?? '—'} |`)
          .join('\n');

  const fileList =
    ud.files.length === 0
      ? '_No file lifecycle data available._'
      : ud.files
          .slice(0, 15)
          .map((f) => `| \`${f.path}\` | ${f.status} | ${f.churn} |`)
          .join('\n');

  const eventList = ud.events
    .map(
      (e) =>
        `| ${e.occurred_at.slice(0, 10)} | ${e.role} | ${e.sha.slice(0, 7)} | ${truncate(e.message, 80)} |`,
    )
    .join('\n');

  const decisionList =
    ud.decisions.length === 0
      ? '_No decisions recorded._'
      : ud.decisions
          .map(
            (d) =>
              `- ${d.text}${d.rationale ? ` — _${truncate(d.rationale, 120)}_` : ''}${d.decided_at ? ` _(${d.decided_at.slice(0, 10)})_` : ''}`,
          )
          .join('\n');

  const markdown = `## ${ud.unit_name} **[draft]**

${ud.unit_description ? `> ${ud.unit_description}\n` : ''}
${ud.keywords.length > 0 ? `**Keywords:** ${ud.keywords.join(', ')}\n` : ''}
**First seen:** ${ud.first_seen_at?.slice(0, 10) ?? '—'} · **Last active:** ${ud.last_active_at?.slice(0, 10) ?? '—'}

:::diagram type=lifespan_strip params=${JSON.stringify(lifespanParams)}:::

### Activity Summary

| Metric | Value |
|--------|-------|
| Total events | ${ud.counts.total_events} |
| Signal events | ${ud.counts.signal_events} |
| Files extant | ${ud.counts.files_extant} |
| Files deleted | ${ud.counts.files_deleted} |
| Tickets linked | ${ud.counts.tickets_linked} |

### Milestone Events

| Date | Role | SHA | Message |
|------|------|-----|---------|
${eventList || '_No events._'}

### Linked Tickets

| Key | Title | Status |
|-----|-------|--------|
${ticketList}

### Files

| Path | Status | Churn |
|------|--------|-------|
${fileList}

### Decisions

${decisionList}
`;

  const source_hash_inputs = {
    kind: 'unit',
    unit_id: ud.unit_id,
    counts: ud.counts,
    events: ud.events.map((e) => ({ sha: e.sha, occurred_at: e.occurred_at })),
    ticket_source_ids: ud.tickets.map((t) => t.source_id),
  };

  return { title, markdown, diagram_blocks: [diagramBlock], source_hash_inputs };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
