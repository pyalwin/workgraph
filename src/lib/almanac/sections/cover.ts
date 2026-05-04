/**
 * Cover section generator — deterministic skeleton only.
 * The agent narration job will rewrite the prose, but the skeleton is stored
 * immediately so Phase 5 UI can render something before narration completes.
 */
import crypto from 'crypto';
import type { ProjectDossier } from '../dossier-builder';

export interface SectionOutput {
  title: string;
  markdown: string;
  diagram_blocks: unknown[];
  source_hash_inputs: unknown;
}

export function buildCoverSection(pd: ProjectDossier): SectionOutput {
  const title = `${pd.project_key} — Almanac`;

  const diagramBlock = {
    type: 'project_summary_bar',
    params: {
      project_key: pd.project_key,
      unit_count: pd.unit_count,
      total_signal_events: pd.total_signal_events,
      drift_unticketed: pd.drift_unticketed,
      drift_unbuilt: pd.drift_unbuilt,
    },
  };

  const markdown = `# ${title}

> Auto-generated technical narrative. Sections marked **[draft]** are awaiting
> LLM narration; they already contain structured data you can read directly.

:::diagram type=project_summary_bar params=${JSON.stringify(diagramBlock.params)}:::

## At a Glance

| Metric | Value |
|--------|-------|
| Functional units | ${pd.unit_count} |
| Signal events | ${pd.total_signal_events} |
| Unticketed drift | ${pd.drift_unticketed} events |
| Unbuilt tickets | ${pd.drift_unbuilt} tickets |
| Decisions recorded | ${pd.decisions.length} |

## Units Overview

${pd.units_summary
  .slice(0, 20)
  .map((u) => `- **${u.name}** — ${u.signal_events} signal events`)
  .join('\n')}
`;

  const source_hash_inputs = {
    kind: 'cover',
    project_key: pd.project_key,
    unit_count: pd.unit_count,
    units: pd.units_summary.map((u) => u.unit_id),
  };

  return { title, markdown, diagram_blocks: [diagramBlock], source_hash_inputs };
}

export function sourcehash(inputs: unknown): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(inputs))
    .digest('hex');
}
