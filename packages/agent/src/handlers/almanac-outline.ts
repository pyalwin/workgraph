/**
 * almanac-outline — handler for kind `almanac.outline`.
 *
 * Job params: { workspaceId, projectKey, repoKey, ref, doc_id }
 *
 * Flow:
 *   1. Validate params.
 *   2. Resolve workspace (clone/fetch/checkout at ref).
 *   3. Stream Claude with a read-only inspection prompt.
 *   4. Accumulate text-deltas → JSON string.
 *   5. Parse JSON → Outline. On failure, ONE retry asking Claude to fix it.
 *   6. Validate required sections are present; slugify section ids.
 *   7. POST outline to /api/almanac/docs/:doc_id/outline.
 *   8. Return { status: 'done', payload: { sections, ref, post_status } }.
 */

import type { JobHandler } from '../dispatcher.js';

// ────────────────────────────────────────────────────────────────────────────
// Outline schema types (matches spec §"Job 1")
// ────────────────────────────────────────────────────────────────────────────

interface OutlineSubsection {
  title: string;
  abstract: string;
}

interface OutlineSection {
  id: string;
  title: string;
  role: 'required' | 'optional';
  abstract: string;
  subsections: OutlineSubsection[];
  diagrams_expected: string[];
}

interface Outline {
  product_summary: string;
  sections: OutlineSection[];
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
const DISALLOWED_TOOLS = ['Edit', 'Write', 'WebFetch', 'Task', 'NotebookEdit'];

const REQUIRED_SECTION_SLUGS: string[] = [
  'overview',
  'problem-and-personas',
  'key-features',
  'user-journeys',
  'core-workflows',
  'how-it-works',
  'integrations',
  'configuration-and-operations',
  'engineering-notes',
];

// Common alternative slugs that map to the required section names.
// This lets Claude use variants and still pass validation.
const SLUG_ALIASES: Record<string, string> = {
  // problem-and-personas
  'personas': 'problem-and-personas',
  'problem': 'problem-and-personas',
  'problem-statement': 'problem-and-personas',
  'audience': 'problem-and-personas',
  'target-audience': 'problem-and-personas',
  'jobs-to-be-done': 'problem-and-personas',
  'jtbd': 'problem-and-personas',
  'personas-and-use-cases': 'problem-and-personas',
  // key-features
  'features': 'key-features',
  'capabilities': 'key-features',
  'feature-map': 'key-features',
  'product-features': 'key-features',
  // user-journeys
  'journeys': 'user-journeys',
  'user-flows': 'user-journeys',
  'flows': 'user-journeys',
  'user-experience': 'user-journeys',
  'ux-flows': 'user-journeys',
  // core-workflows
  'workflows': 'core-workflows',
  'system-workflows': 'core-workflows',
  'core_workflows': 'core-workflows',
  // how-it-works
  'architecture': 'how-it-works',
  'how_it_works': 'how-it-works',
  'system-overview': 'how-it-works',
  'how-the-system-works': 'how-it-works',
  'tech-stack': 'how-it-works',
  'domain-model': 'how-it-works',
  'api-surface': 'how-it-works',
  // configuration-and-operations
  'configuration': 'configuration-and-operations',
  'operations': 'configuration-and-operations',
  'config-and-ops': 'configuration-and-operations',
  'config-ops': 'configuration-and-operations',
  'ops': 'configuration-and-operations',
  'deployment': 'configuration-and-operations',
  'infrastructure': 'configuration-and-operations',
  'devops': 'configuration-and-operations',
  // engineering-notes
  'engineering': 'engineering-notes',
  'appendix': 'engineering-notes',
  'reference': 'engineering-notes',
  'references': 'engineering-notes',
  'engineering-appendix': 'engineering-notes',
  'tech-notes': 'engineering-notes',
  'engineers-map': 'engineering-notes',
};

// ────────────────────────────────────────────────────────────────────────────
// Param validation
// ────────────────────────────────────────────────────────────────────────────

interface OutlineParams {
  workspaceId: string;
  projectKey: string;
  repoKey: string;
  ref: string;
  doc_id: string;
}

function validateParams(raw: Record<string, unknown>): { valid: OutlineParams } | { error: string } {
  const required = ['workspaceId', 'projectKey', 'repoKey', 'ref', 'doc_id'] as const;
  for (const key of required) {
    if (typeof raw[key] !== 'string' || !raw[key]) {
      return { error: `params.${key} must be a non-empty string` };
    }
  }
  return {
    valid: {
      workspaceId: raw['workspaceId'] as string,
      projectKey: raw['projectKey'] as string,
      repoKey: raw['repoKey'] as string,
      ref: raw['ref'] as string,
      doc_id: raw['doc_id'] as string,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Slug utilities
// ────────────────────────────────────────────────────────────────────────────

/**
 * Converts an arbitrary string to a URL-safe, ASCII-only slug.
 * Examples: "API Surface" → "api-surface", "Tech Stack" → "tech-stack".
 */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // strip accents
    .replace(/[^a-z0-9]+/g, '-')      // non-alphanumeric → hyphen
    .replace(/^-+|-+$/g, '');         // trim leading/trailing hyphens
}

/**
 * Normalises a section id to a canonical slug, applying alias mappings so
 * minor Claude variations still hit the required set.
 */
function normaliseSlug(id: string): string {
  const slug = slugify(id);
  return SLUG_ALIASES[slug] ?? slug;
}

// ────────────────────────────────────────────────────────────────────────────
// Outline validation
// ────────────────────────────────────────────────────────────────────────────

function validateOutline(outline: unknown): { valid: Outline } | { error: string } {
  if (typeof outline !== 'object' || outline === null || Array.isArray(outline)) {
    return { error: 'outline must be a JSON object' };
  }

  const obj = outline as Record<string, unknown>;

  if (typeof obj['product_summary'] !== 'string' || !obj['product_summary'].trim()) {
    return { error: 'outline.product_summary must be a non-empty string' };
  }

  if (!Array.isArray(obj['sections']) || obj['sections'].length === 0) {
    return { error: 'outline.sections must be a non-empty array' };
  }

  for (let i = 0; i < obj['sections'].length; i++) {
    const section = obj['sections'][i] as Record<string, unknown>;
    if (typeof section['id'] !== 'string' || !section['id'].trim()) {
      return { error: `outline.sections[${i}].id must be a non-empty string` };
    }
    if (typeof section['title'] !== 'string' || !section['title'].trim()) {
      return { error: `outline.sections[${i}].title must be a non-empty string` };
    }
    if (section['role'] !== 'required' && section['role'] !== 'optional') {
      return { error: `outline.sections[${i}].role must be 'required' or 'optional'` };
    }
    if (typeof section['abstract'] !== 'string' || !section['abstract'].trim()) {
      return { error: `outline.sections[${i}].abstract must be a non-empty string` };
    }
    if (!Array.isArray(section['subsections'])) {
      return { error: `outline.sections[${i}].subsections must be an array` };
    }
    if (!Array.isArray(section['diagrams_expected'])) {
      return { error: `outline.sections[${i}].diagrams_expected must be an array` };
    }
  }

  return { valid: outline as Outline };
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt builder
// ────────────────────────────────────────────────────────────────────────────

function buildOutlinePrompt(): string {
  return `You are a senior product writer preparing a comprehensive product document for a software product. The audience is mixed: product managers, designers, executives, and engineers. The document is **part PRD** (problem, personas, features, requirements) and **part user-facing product description** (what the product does, how users get value, key journeys and workflows).

Your task: read this repository to understand WHAT the product is and HOW users interact with it, then produce a JSON outline for a section-by-section document. The outline must give each section a clear, self-contained brief grounded in what the product actually does.

## Tone and emphasis (read carefully — this shapes everything)

- Frame everything around **user value**, not code structure. Sections describe features, journeys, and workflows — not modules and files.
- Technical detail (file paths, function names, schemas, env vars, line numbers) belongs in **inline footnotes** within each drafted section and in the **engineering-notes appendix** — NEVER in section abstracts.
- **Diagrams are central.** Any section that benefits from a flow, sequence, or relationship diagram should specify diagrams. Diagrams are the primary explanation device, not decoration.
- You read code to understand the **product**. You write about the **product**, not the code.

## Required major sections

You MUST include all nine of the following sections, with exactly the slug shown (the id field):

| id                              | title                          | what it covers                                                                                |
|---------------------------------|--------------------------------|-----------------------------------------------------------------------------------------------|
| overview                        | Overview                       | What the product is, who it is for, the core value proposition. Crisp and outcome-led.        |
| problem-and-personas            | Problem & Personas             | The problem being solved. Target personas, their goals, and jobs-to-be-done.                  |
| key-features                    | Key Features                   | Capability map, organised by user value (not by code module).                                 |
| user-journeys                   | User Journeys                  | End-to-end flows from a user's perspective. Sequence diagrams central.                        |
| core-workflows                  | Core Workflows                 | The system's functional workflows: background jobs, multi-step processes, lifecycles.         |
| how-it-works                    | How It Works                   | Light architectural narrative — major moving parts and how data flows. One system diagram.    |
| integrations                    | Integrations                   | External systems the product talks to and what each is used for.                              |
| configuration-and-operations    | Configuration & Operations     | What admins/operators configure and run. Env vars, deployment, observability.                 |
| engineering-notes               | Engineering Notes              | Appendix for engineers: where code lives, key modules, glossary of internal terms.            |

You MAY add additional optional sections if a critical product capability isn't covered (examples: "Pricing & Plans", "Security & Compliance", "Roles & Permissions", "Notifications"). Use a slug in the same kebab-case style.

## Section specification rules

For EVERY section (required and optional):
- **id**: stable URL-safe slug (lowercase, hyphens, ASCII only). Use the ids in the table for required sections.
- **title**: human-readable heading.
- **role**: \`"required"\` for the nine above, \`"optional"\` for any additions.
- **abstract**: 2–4 sentences describing what the section covers, framed in product/user terms specific to THIS product. No generic filler.
- **subsections**: 2–5 \`{ title, abstract }\` objects per required section. Frame subsection titles as features or user concerns, not as code areas.
- **diagrams_expected**: array of diagram descriptions. **Required for** \`user-journeys\` (sequence diagrams of key flows), \`core-workflows\` (flowcharts), and \`how-it-works\` (a system context diagram). Encouraged elsewhere where a diagram adds clarity. Optional only for \`overview\`, \`problem-and-personas\`, and \`engineering-notes\`.

## Tone calibration — concrete examples

GOOD subsection title: *"Onboarding a new project"*
BAD subsection title:  *"ProjectController.create()"*

GOOD abstract: *"How users invite teammates, assign roles, and manage workspace access from the settings UI."*
BAD abstract:  *"The /api/workspace/members endpoints and the role enum in src/lib/auth/roles.ts."*

GOOD diagram: *"Sequence diagram of a user signing in and landing on their first project"*
BAD diagram:  *"Class diagram of AuthService"*

The \`engineering-notes\` section is the one exception — it IS a technical appendix, so its abstract may reference modules, packages, and code organisation directly.

## How to inspect the repo

Use Glob to discover structure. **Read the README first** — it usually states the product purpose and primary use cases. Then read \`package.json\` / \`Cargo.toml\` / \`pyproject.toml\` / \`go.mod\`, key entry points (UI routes, CLI commands, API surface), and any product-facing copy (landing pages, docs/) to understand what the product is FOR. Use Grep to find feature flags, route names, top-level workflows, integration names — anything that signals user-facing capability.

Inspect code to understand the PRODUCT. Do not catalogue the code.

## Output format

Output MUST be a single, strictly valid JSON object matching this schema:

{
  "product_summary": "<1–2 sentence summary of what this product is and who it is for>",
  "sections": [
    {
      "id": "<slug>",
      "title": "<human title>",
      "role": "required" | "optional",
      "abstract": "<2–4 sentences>",
      "subsections": [
        { "title": "<subsection title>", "abstract": "<1–2 sentences>" }
      ],
      "diagrams_expected": ["<diagram description>", ...]
    }
  ]
}

CRITICAL output rules:
- Output ONLY the JSON object. No markdown fences. No preamble. No trailing prose.
- The JSON must be parseable by JSON.parse() with no preprocessing.
- All nine required section ids must be present.
- Strings must not contain unescaped newlines or tabs.`;
}

function buildRetryPrompt(malformedOutput: string): string {
  return `Your previous response was not valid JSON. Here is what you returned:

---BEGIN PREVIOUS RESPONSE---
${malformedOutput.slice(0, 8000)}${malformedOutput.length > 8000 ? '\n...[truncated]' : ''}
---END PREVIOUS RESPONSE---

Please fix it. Return ONLY a valid JSON object matching the Outline schema below. No markdown fences, no preamble, no explanation — just the corrected JSON.

Required schema:
{
  "product_summary": "<string>",
  "sections": [
    {
      "id": "<slug>",
      "title": "<string>",
      "role": "required" | "optional",
      "abstract": "<string>",
      "subsections": [{ "title": "<string>", "abstract": "<string>" }],
      "diagrams_expected": ["<string>"]
    }
  ]
}

All nine required section ids must be present: overview, problem-and-personas, key-features, user-journeys, core-workflows, how-it-works, integrations, configuration-and-operations, engineering-notes.

Output ONLY the corrected JSON object now.`;
}

// ────────────────────────────────────────────────────────────────────────────
// Stream helper — drain a ClaudeStream, pipe events to sink, return full text
// ────────────────────────────────────────────────────────────────────────────

async function drainStream(
  stream: ReturnType<import('../dispatcher.js').JobContext['streamClaude']>,
  sink: import('../dispatcher.js').JobContext['sink'],
): Promise<{ text: string; finishReason: 'stop' | 'error' | 'cancelled' }> {
  let text = '';
  let finishReason: 'stop' | 'error' | 'cancelled' = 'stop';

  for await (const event of stream) {
    sink.emit(event);
    if (event.type === 'text-delta') {
      text += event.text;
    }
    if (event.type === 'finish') {
      finishReason = event.reason;
    }
  }

  return { text, finishReason };
}

// ────────────────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────────────────

export const almanacOutlineHandler: JobHandler = async (job, ctx) => {
  ctx.log('info', `[almanac.outline] job ${job.id} starting`);

  // ── Validate params ───────────────────────────────────────────────────────
  const validation = validateParams(job.params);
  if ('error' in validation) {
    return { status: 'failed', error: validation.error };
  }
  const params = validation.valid;

  // ── Resolve workspace ─────────────────────────────────────────────────────
  ctx.log('info', `[almanac.outline] resolving workspace for ${params.repoKey}@${params.ref}`);
  let workspacePath: string;
  let sha: string;
  try {
    const ws = await ctx.resolveWorkspace({ repoKey: params.repoKey, ref: params.ref });
    workspacePath = ws.path;
    sha = ws.sha;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error: `workspace resolver error: ${msg}` };
  }
  ctx.log('info', `[almanac.outline] workspace resolved: ${workspacePath} @ ${sha}`);

  // ── First Claude call ─────────────────────────────────────────────────────
  ctx.log('info', '[almanac.outline] sending outline prompt to Claude');
  const prompt = buildOutlinePrompt();
  const firstStream = ctx.streamClaude({
    prompt,
    cwd: workspacePath,
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DISALLOWED_TOOLS,
  });

  const { text: firstText, finishReason: firstFinish } = await drainStream(firstStream, ctx.sink);

  if (firstFinish === 'error' || firstFinish === 'cancelled') {
    return { status: 'failed', error: `Claude stream ended with reason: ${firstFinish}` };
  }

  const trimmedFirst = firstText.trim();
  ctx.log('info', `[almanac.outline] Claude response received (${trimmedFirst.length} chars), parsing JSON`);

  // ── Parse JSON — attempt 1 ────────────────────────────────────────────────
  let parsed: unknown;
  let parseOk = false;

  try {
    parsed = JSON.parse(trimmedFirst);
    parseOk = true;
  } catch {
    // Fall through to retry.
  }

  if (!parseOk) {
    ctx.log('warn', '[almanac.outline] JSON parse failed on first attempt — retrying with fix prompt');

    const retryPrompt = buildRetryPrompt(trimmedFirst);
    const retryStream = ctx.streamClaude({
      prompt: retryPrompt,
      cwd: workspacePath,
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
    });

    const { text: retryText, finishReason: retryFinish } = await drainStream(retryStream, ctx.sink);

    if (retryFinish === 'error' || retryFinish === 'cancelled') {
      return { status: 'failed', error: `Claude retry stream ended with reason: ${retryFinish}` };
    }

    const trimmedRetry = retryText.trim();
    ctx.log('info', `[almanac.outline] retry response received (${trimmedRetry.length} chars), parsing JSON`);

    try {
      parsed = JSON.parse(trimmedRetry);
    } catch {
      return { status: 'failed', error: 'outline JSON invalid after retry' };
    }
  }

  // ── Validate outline structure ────────────────────────────────────────────
  const outlineValidation = validateOutline(parsed);
  if ('error' in outlineValidation) {
    return { status: 'failed', error: `outline validation failed: ${outlineValidation.error}` };
  }

  const outline = outlineValidation.valid;

  // Slugify all section ids to ensure URL-safe, stable slugs.
  for (const section of outline.sections) {
    section.id = normaliseSlug(section.id);
  }

  // Check all nine required sections are present.
  const presentSlugs = new Set(outline.sections.map((s) => s.id));
  const missingSlugs = REQUIRED_SECTION_SLUGS.filter((slug) => !presentSlugs.has(slug));
  if (missingSlugs.length > 0) {
    ctx.log('warn', `[almanac.outline] missing required sections: ${missingSlugs.join(', ')}`);
    return {
      status: 'failed',
      error: `outline is missing required sections: ${missingSlugs.join(', ')}`,
    };
  }

  ctx.log('info', `[almanac.outline] outline valid — ${outline.sections.length} sections`);

  // ── POST outline to server ────────────────────────────────────────────────
  ctx.log('info', `[almanac.outline] posting outline to /api/almanac/docs/${params.doc_id}/outline`);
  let postStatus: number | undefined;
  try {
    const res = await ctx.client(`/api/almanac/docs/${params.doc_id}/outline`, {
      method: 'POST',
      body: { outline, ref: sha },
    });
    // ctx.client returns the parsed body. We need the status code too.
    // The client interface doesn't surface it directly, so we check for a
    // status field in the response if the server includes it, and default to 200.
    if (typeof res === 'object' && res !== null && typeof (res as Record<string, unknown>)['status'] === 'number') {
      postStatus = (res as Record<string, unknown>)['status'] as number;
    } else {
      postStatus = 200;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log('warn', `[almanac.outline] POST to outline endpoint failed: ${msg}`);
    // Non-fatal from the job perspective — return done but surface the error in the payload.
    return {
      status: 'done',
      payload: {
        sections: outline.sections.length,
        ref: sha,
        post_status: 0,
        post_error: msg,
      },
    };
  }

  ctx.log('info', `[almanac.outline] done — ${outline.sections.length} sections, POST ${postStatus}`);

  return {
    status: 'done',
    payload: {
      sections: outline.sections.length,
      ref: sha,
      post_status: postStatus,
    },
  };
};
