/**
 * Stage-1 mechanical noise classifier for Almanac code_events.
 *
 * Pure, deterministic, zero-cost. Rules are ordered; first match wins.
 * Stage-2 (LLM batch) may refine intent/architectural_significance later;
 * this sets the initial noise_class and is_feature_evolution on ingest.
 */

export type NoiseClass =
  | 'dependency_bump'
  | 'tooling'
  | 'docs_only'
  | 'test_only'
  | 'ci_only'
  | 'tiny_change'
  | 'revert'
  | 'signal';

export interface ClassifierInput {
  message: string;         // commit subject (first line)
  files: string[];         // already-skip-filtered files_touched
  additions: number;
  deletions: number;
}

export interface ClassifierOutput {
  noise_class: NoiseClass;
  is_feature_evolution: 0 | 1;
}

// ---------------------------------------------------------------------------
// Pattern sets — compiled once at module load
// ---------------------------------------------------------------------------

// Rule 2: dependency files
// package.json alone counts here; lock files were already stripped at Phase 1
// ingest (DIFF_SKIP_PATTERNS), so a real dep bump may only have package.json left.
const DEP_PATTERNS: RegExp[] = [
  /(^|\/)package\.json$/i,
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)bun\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)Pipfile\.lock$/i,
  /(^|\/)poetry\.lock$/i,
  /(^|\/)Gemfile\.lock$/i,
  /(^|\/)composer\.lock$/i,
  /(^|\/)Cargo\.lock$/i,
  /(^|\/)go\.sum$/i,
  /(^|\/)go\.mod$/i,
  /(^|\/)requirements\.txt$/i,
  /(^|\/)Pipfile$/i,
  /(^|\/)Cargo\.toml$/i,
  /(^|\/)composer\.json$/i,
];

// Rule 3: tooling config files
const TOOLING_PATTERNS: RegExp[] = [
  /(^|\/)\.(eslintrc)(\.|$)/i,
  /(^|\/)\.(prettierrc)(\.|$)/i,
  /(^|\/)tsconfig(\.|$)/i,      // tsconfig.json, tsconfig.*.json
  /\.(config)\.(ts|js|mjs|cjs)$/i,  // *.config.ts/js/mjs/cjs
  /(^|\/)\.(editorconfig)$/i,
  /(^|\/)\.(gitignore)$/i,
  /(^|\/)\.(npmrc)$/i,
  /(^|\/)\.(nvmrc)$/i,
  /\.config$/i,                 // bare *.config with no extension
];

// Rule 4: docs/text files
const DOCS_PATTERNS: RegExp[] = [
  /\.md$/i,
  /\.mdx$/i,
  /\.txt$/i,
  /\.rst$/i,
  /(^|\/)LICENSE(\.[^/]+)?$/,
  /(^|\/)CHANGELOG(\.[^/]+)?$/i,
  /(^|\/)AUTHORS$/,
  /(^|\/)CONTRIBUTORS$/,
  /(^|\/)README(\.[^/]+)?$/i,
  /(^|\/)docs\//,
];

// Rule 5: test files
const TEST_PATTERNS: RegExp[] = [
  /\.test\./i,
  /\.spec\./i,
  /(^|\/)__tests__\//,
  /(^|\/)tests\//,
  /(^|\/)e2e\//,
  /(^|\/)cypress\//,
];

// Rule 6: CI/CD infrastructure files
const CI_PATTERNS: RegExp[] = [
  /(^|\/)\.github\/workflows\//,
  /(^|\/)\.github\/actions\//,
  /(^|\/)\.gitlab-ci\.yml$/i,
  /(^|\/)Dockerfile(\.|$)/i,
  /(^|\/)docker-compose(\.|$)/i,
  /(^|\/)\.circleci\//,
  /(^|\/)Makefile$/,
  /(^|\/)\.husky\//,
  // YAML files that live at workflow-like paths (top-level .yml/.yaml that
  // aren't src code; narrow to root-level to avoid catching e.g. openapi specs)
  /^\.(yml|yaml)$/i,
  /^[^/]+\.(yml|yaml)$/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesAny(path: string, patterns: RegExp[]): boolean {
  for (const re of patterns) {
    if (re.test(path)) return true;
  }
  return false;
}

/** True only when EVERY file in the list matches at least one pattern in the set. */
function allMatch(files: string[], patterns: RegExp[]): boolean {
  if (files.length === 0) return false;
  return files.every((f) => matchesAny(f, patterns));
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export function classifyMechanical(input: ClassifierInput): ClassifierOutput {
  const message = input.message ?? '';
  const files = input.files ?? [];
  const additions = input.additions ?? 0;
  const deletions = input.deletions ?? 0;

  // Defensive: empty files list
  if (files.length === 0) {
    return { noise_class: 'tiny_change', is_feature_evolution: 0 };
  }

  // Rule 1 — revert
  if (/^revert[: ]/i.test(message)) {
    return applyPromotionRules('revert', files, additions);
  }

  // Rule 2 — dependency_bump
  if (allMatch(files, DEP_PATTERNS)) {
    return applyPromotionRules('dependency_bump', files, additions);
  }

  // Rule 3 — tooling
  if (allMatch(files, TOOLING_PATTERNS)) {
    return applyPromotionRules('tooling', files, additions);
  }

  // Rule 4 — docs_only
  if (allMatch(files, DOCS_PATTERNS)) {
    return applyPromotionRules('docs_only', files, additions);
  }

  // Rule 5 — test_only
  if (allMatch(files, TEST_PATTERNS)) {
    return applyPromotionRules('test_only', files, additions);
  }

  // Rule 6 — ci_only
  if (allMatch(files, CI_PATTERNS)) {
    return applyPromotionRules('ci_only', files, additions);
  }

  // Rule 7 — tiny_change
  if (additions + deletions < 5 && files.length <= 1) {
    return applyPromotionRules('tiny_change', files, additions);
  }

  return applyPromotionRules('signal', files, additions);
}

// ---------------------------------------------------------------------------
// Promotion rules (run after classification; may upgrade noise to signal)
// ---------------------------------------------------------------------------

function applyPromotionRules(
  classified: NoiseClass,
  files: string[],
  additions: number,
): ClassifierOutput {
  let noise_class = classified;

  // Promotion rule 1: large cross-file change → almost certainly a real refactor
  // or move, even if individual file names look noisy.
  if (files.length >= 10) {
    noise_class = 'signal';
  }

  // Promotion rule 2 (top-level dir heuristic): if 5+ files share a new
  // top-level segment that appears in 3+ of them, this is likely a scaffolded
  // feature directory. Stage 1 proxy: if files.length >= 5 and a single
  // top-level segment dominates (>=3 files start with it), promote.
  //
  // TODO: this can overfit on monorepos where many routine changes touch
  // packages/shared/... — leave as a comment for now and re-evaluate in
  // Stage 2 with real data.
  //
  // if (files.length >= 5) {
  //   const counts = new Map<string, number>();
  //   for (const f of files) {
  //     const seg = f.split('/')[0];
  //     counts.set(seg, (counts.get(seg) ?? 0) + 1);
  //   }
  //   for (const count of counts.values()) {
  //     if (count >= 3) { noise_class = 'signal'; break; }
  //   }
  // }

  // Promotion rule 3: is_feature_evolution flag
  // A signal commit with ≥20 net additions is likely real new code.
  // Stage 2 (LLM) will refine this; Stage 1 just needs a safe default.
  const is_feature_evolution: 0 | 1 =
    noise_class === 'signal' && additions >= 20 ? 1 : 0;

  return { noise_class, is_feature_evolution };
}
