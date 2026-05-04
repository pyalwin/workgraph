/**
 * Decisions section — project-wide decisions extracted from PR reviews.
 * Skeleton only; agent narration fills prose grouping/commentary.
 */
import type { ProjectDossier } from '../dossier-builder';
import type { SectionOutput } from './cover';

export function buildDecisionsSection(pd: ProjectDossier): SectionOutput {
  const title = 'Key Decisions';

  const decisionList =
    pd.decisions.length === 0
      ? '_No decisions recorded for this project._'
      : pd.decisions
          .map(
            (d, i) => `### Decision ${i + 1}${d.decided_at ? ` _(${d.decided_at.slice(0, 10)})_` : ''}

**${d.text}**

${d.rationale ? `> ${d.rationale}` : ''}
`,
          )
          .join('\n');

  const diagramBlock = {
    type: 'decisions_timeline',
    params: {
      project_key: pd.project_key,
      decisions: pd.decisions.map((d) => ({
        id: d.id,
        decided_at: d.decided_at,
        has_rationale: Boolean(d.rationale),
      })),
    },
  };

  const markdown = `## Key Decisions **[draft]**

${pd.decisions.length === 0 ? '' : `:::diagram type=decisions_timeline params=${JSON.stringify(diagramBlock.params)}:::\n`}
${decisionList}
`;

  const source_hash_inputs = {
    kind: 'decisions',
    project_key: pd.project_key,
    decision_ids: pd.decisions.map((d) => d.id),
  };

  return { title, markdown, diagram_blocks: pd.decisions.length > 0 ? [diagramBlock] : [], source_hash_inputs };
}
