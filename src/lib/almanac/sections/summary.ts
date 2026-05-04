/**
 * Summary section generator — deterministic skeleton.
 * Prose content replaced by agent narration job when available.
 */
import type { ProjectDossier } from '../dossier-builder';
import type { SectionOutput } from './cover';

export function buildSummarySection(pd: ProjectDossier): SectionOutput {
  const title = `Project Summary`;

  const diagramBlock = {
    type: 'signal_timeline',
    params: {
      project_key: pd.project_key,
      units: pd.units_summary.map((u) => ({ unit_id: u.unit_id, signal_events: u.signal_events })),
    },
  };

  const unitList = pd.units_summary
    .sort((a, b) => b.signal_events - a.signal_events)
    .map((u) => `| ${u.name} | ${u.signal_events} |`)
    .join('\n');

  const markdown = `## Project Summary **[draft]**

_This section will be replaced with an LLM-generated narrative once the agent
narration job completes. The structured data below is available immediately._

:::diagram type=signal_timeline params=${JSON.stringify(diagramBlock.params)}:::

### Activity by Functional Unit

| Unit | Signal Events |
|------|--------------|
${unitList}

### Drift Summary

- **Unticketed work**: ${pd.drift_unticketed} signal events have no linked Jira ticket
- **Unbuilt tickets**: ${pd.drift_unbuilt} done tickets have no linked code events

### Key Decisions

${
  pd.decisions.length === 0
    ? '_No decisions recorded for this project._'
    : pd.decisions
        .slice(0, 5)
        .map((d) => `- ${d.text}${d.decided_at ? ` _(${d.decided_at.slice(0, 10)})_` : ''}`)
        .join('\n')
}
`;

  const source_hash_inputs = {
    kind: 'summary',
    project_key: pd.project_key,
    total_signal_events: pd.total_signal_events,
    drift_unticketed: pd.drift_unticketed,
    drift_unbuilt: pd.drift_unbuilt,
    decision_ids: pd.decisions.map((d) => d.id),
    units: pd.units_summary.map((u) => ({ unit_id: u.unit_id, signal_events: u.signal_events })),
  };

  return { title, markdown, diagram_blocks: [diagramBlock], source_hash_inputs };
}
