/**
 * almanac-draft-section — handler for kind `almanac.draft-section`.
 *
 * Job params: { workspaceId, projectKey, repoKey, ref, doc_id, section_id, outline }
 *
 * Flow:
 *   1. Validate params.
 *   2. Resolve workspace (clone/fetch/checkout at ref).
 *   3. Locate the target section in the outline.
 *   4. Build a richly contextualised prompt for the section.
 *   5. Stream Claude, accumulate text-deltas.
 *   6. Validate: non-empty, starts with `## `.
 *   7. ONE retry on empty/invalid output.
 *   8. POST markdown to /api/almanac/docs/:doc_id/sections/:section_id.
 *   9. Return { status: 'done', payload: { chars, ref, post_status } }.
 */

import type { JobHandler } from '../dispatcher.js';

// ────────────────────────────────────────────────────────────────────────────
// Types mirroring the Outline schema (same as almanac-outline.ts)
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

// ────────────────────────────────────────────────────────────────────────────
// Param validation
// ────────────────────────────────────────────────────────────────────────────

interface DraftSectionParams {
  workspaceId: string;
  projectKey: string;
  repoKey: string;
  ref: string;
  doc_id: string;
  section_id: string;
  outline: Outline;
}

function validateParams(
  raw: Record<string, unknown>,
): { valid: DraftSectionParams } | { error: string } {
  const stringFields = ['workspaceId', 'projectKey', 'repoKey', 'ref', 'doc_id', 'section_id'] as const;
  for (const key of stringFields) {
    if (typeof raw[key] !== 'string' || !raw[key]) {
      return { error: `params.${key} must be a non-empty string` };
    }
  }

  if (
    typeof raw['outline'] !== 'object' ||
    raw['outline'] === null ||
    !Array.isArray((raw['outline'] as Record<string, unknown>)['sections'])
  ) {
    return { error: 'params.outline must be an Outline object with a sections array' };
  }

  return {
    valid: {
      workspaceId: raw['workspaceId'] as string,
      projectKey: raw['projectKey'] as string,
      repoKey: raw['repoKey'] as string,
      ref: raw['ref'] as string,
      doc_id: raw['doc_id'] as string,
      section_id: raw['section_id'] as string,
      outline: raw['outline'] as Outline,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt builder
// ────────────────────────────────────────────────────────────────────────────

function buildDiagramInstructions(diagrams: string[]): string {
  if (diagrams.length === 0) {
    return `No specific diagrams are required for this section. However, if a diagram would materially help the reader understand a concept — such as a data flow, component relationship, or process sequence — include one using Mermaid.`;
  }

  const lines = diagrams
    .map((d, i) => {
      // Suggest the most appropriate Mermaid diagram type based on description keywords.
      let mermaidType = 'flowchart TD';
      const dl = d.toLowerCase();
      if (dl.includes('sequence') || dl.includes('auth') || dl.includes('flow') && dl.includes('request')) {
        mermaidType = 'sequenceDiagram';
      } else if (dl.includes('entity') || dl.includes('er') || dl.includes('relation') || dl.includes('schema') || dl.includes('data model')) {
        mermaidType = 'erDiagram';
      } else if (dl.includes('class') || dl.includes('inheritance') || dl.includes('uml')) {
        mermaidType = 'classDiagram';
      } else if (dl.includes('state') || dl.includes('status')) {
        mermaidType = 'stateDiagram-v2';
      }
      return `  ${i + 1}. "${d}" — use \`\`\`mermaid\n${mermaidType}\n...\n\`\`\``;
    })
    .join('\n');

  return `Include the following diagrams in this section. Use Mermaid fenced code blocks (\`\`\`mermaid ... \`\`\`). Choose the most appropriate Mermaid diagram type for each:
- flowchart TD / LR — for component graphs, system context, data flow
- sequenceDiagram — for request/response flows, auth sequences, API call chains
- erDiagram — for entity-relationship models, database schemas
- classDiagram — for class hierarchies, type relationships
- stateDiagram-v2 — for state machines, lifecycle flows

Required diagrams for this section:
${lines}

Base each diagram on what you actually observe in the codebase — real component names, real relationships, real sequences. Do not invent.`;
}

function buildSubsectionsInstructions(subsections: OutlineSubsection[]): string {
  if (subsections.length === 0) {
    return 'No subsections are pre-specified. Organise the content as you see fit using `### Heading` markers.';
  }

  const list = subsections
    .map((s, i) => `  ${i + 1}. ### ${s.title}\n     ${s.abstract}`)
    .join('\n\n');

  return `Structure the section using the following subsections (use \`### <title>\` headings). For each subsection, cover what the abstract describes — going deeper with real code references, file paths, and examples where relevant:

${list}`;
}

function buildCrossContextBlock(
  allSections: OutlineSection[],
  targetSectionId: string,
): string {
  const others = allSections.filter((s) => s.id !== targetSectionId);
  if (others.length === 0) return '';

  const lines = others
    .map((s) => `- **${s.title}** (\`${s.id}\`): ${s.abstract.split('.')[0]}.`)
    .join('\n');

  return `## Cross-section context

The following sections will appear in the same document. Use this to avoid duplicating content they own, and to add cross-references where appropriate (e.g. "see the Architecture section for…"):

${lines}`;
}

function buildSectionPrompt(section: OutlineSection, outline: Outline): string {
  const diagramInstructions = buildDiagramInstructions(section.diagrams_expected);
  const subsectionInstructions = buildSubsectionsInstructions(section.subsections);
  const crossContext = buildCrossContextBlock(outline.sections, section.id);
  const isEngineeringNotes = section.id === 'engineering-notes';

  const toneBlock = isEngineeringNotes
    ? `## Tone — engineering appendix

This is the engineering appendix. Unlike every other section, this one IS a technical reference. Cite real file paths, function names, table names, env vars, and modules directly in prose. Use lists and small tables liberally. Aim to give an engineer a "where to start reading" map of the codebase. Diagrams are optional. Footnotes are optional here — direct citation is fine. The forbidden patterns and vocabulary blocklist below do NOT apply here — name technologies, protocols, models, algorithms, and code freely.`
    : `## Tone — write like a product manager, not an engineer

You are a product manager writing a **user manual** for this product. Your reader is another product manager, a designer, an executive, or a customer. They do not care how the product is built. They care what it does and what value it delivers.

If a sentence makes a software engineer say "ah, I know how that's implemented," you have failed. If a sentence makes a customer say "ah, I see what this does for me," you have succeeded.

### THE FOUR FORBIDDEN PATTERNS — never put these in prose

A draft that contains any of these will be rejected.

1. **No file paths or filenames.** Anything matching \`src/...\`, \`app/...\`, \`packages/...\`, or any string with a slash and an extension like \`.ts\`, \`.tsx\`, \`.js\`, \`.py\`, \`.sql\`, \`.json\`, \`.yaml\` — forbidden in prose.
2. **No code symbols.** No function names like \`classifyItem()\`, no class names, no constants like \`MAX_DEPTH = 4\`, no variable assignments, no type names, no SQL table names, no API endpoint paths like \`/api/foo/bar\`.
3. **No technology names.** No library, framework, SDK, model, protocol, RFC, algorithm, or storage product names. (Examples of names to avoid: Claude Sonnet, Claude Haiku, GPT, Inngest, Hugging Face, Ollama, OpenRouter, Drizzle, Prisma, Next.js, React, Tailwind, WorkOS, AuthKit, react-force-graph, MCP, OAuth, JWT, SSE, OIDC, SAML, RFC, cosine, BM25, RRF, force-directed, k-NN, embedding, chunking, vector index, SQLite, libSQL, Turso, sqlite-vec, Postgres, Redis, S3, FTS5, AES, GCM.)
4. **No code blocks except Mermaid.** Fenced code blocks are forbidden for any language other than \`mermaid\`. No \`\`\`ts, \`\`\`tsx, \`\`\`js, \`\`\`py, \`\`\`sql, \`\`\`json, \`\`\`yaml, \`\`\`bash, etc.

The only inline backticks allowed in prose are:
- A literal command the user types in a terminal, e.g. \`bun dev\` or \`docker compose up\`.
- An exact label the user reads in the UI, e.g. \`Settings → Connectors\`.
- An environment variable the user sets in their own shell, e.g. \`OPENAI_API_KEY\`.

That is the entire allowed list. Anything else — function names, file names, library names, SQL, code keywords — goes into a footnote (see Footnote style) or gets removed entirely.

### Translation examples — copy this style

| BAD (do not write) | GOOD (write this instead) |
|---|---|
| "Eleven first-party connectors live in \`src/lib/connectors/adapters/\`: \`atlassian.ts\` (Jira), \`confluence.ts\`…" | "WorkGraph ships ready-made connectors for eleven popular tools — including Jira, Confluence, Notion, Slack, GitHub, GitLab, Linear, Granola, Google Calendar, Google Drive, and Microsoft Teams.[^1]" |
| "\`src/lib/crossref.ts\` is the linker — it does pairwise candidate generation with a ±90-day blocking window…" | "WorkGraph automatically links related items across sources — for example, the meeting where a feature was discussed, the ticket that tracks it, and the pull request that ships it.[^2]" |
| "\`extractDecisions()\` in \`src/lib/decision/extract.ts:125\` pulls first-class decided vs open items…" | "Decisions made in meetings and threads are pulled out as a first-class list, separated into resolved and still-pending.[^5]" |
| "Embeddings come from Hugging Face Inference (default \`BAAI/bge-large-en-v1.5\`, 1024 dims)…" | "Items are compared by meaning, not just keywords, so a meeting note and a related ticket connect even if they don't share words.[^6]" |
| "\`TRAVERSAL_THRESHOLD = 0.75\`, \`MAX_DEPTH = 4\`, \`MAX_WORKSTREAM_SIZE = 25\`" | "Each workstream stays small and focused on the strongest connections, so a single popular item can't pull the whole workspace into one cluster.[^7]" |
| "Tokens are encrypted at rest via \`src/lib/crypto.ts\` (AES-256-GCM)" | "Saved credentials and connection tokens are encrypted on disk so even someone with file access cannot read them.[^9]" |
| "Storage is a single SQLite file (\`data/workgraph.db\`) via \`better-sqlite3\` + \`sqlite-vec\`" | "All data — the items, the links, and the search index — lives in a single file on the user's own disk.[^11]" |

Notice the structure of every GOOD example: **a sentence about what the user gets**, followed by a footnote where the engineering detail lives.`;

  const footnoteBlock = isEngineeringNotes
    ? `## Footnote style (this section)

Footnotes are optional in the engineering appendix — direct citation in prose is acceptable. If you do use footnotes, follow GFM syntax: \`[^1]\` inline and \`[^1]: ...\` definitions in a closing \`### References\` block.`
    : `## Footnote style — where ALL technical detail goes

Footnotes are the ONLY place the four forbidden patterns are allowed. Every file path, function name, library name, model name, protocol, algorithm, threshold, table name, endpoint, and env var that you would otherwise write in prose goes here instead.

- **Inline marker** in prose (renders as a superscript): \`Items are compared by meaning, not just keywords[^4].\`
- **Definition** at the end of the section in a \`### References\` block:
  \`[^4]: Embeddings via Hugging Face Inference (default model BAAI/bge-large-en-v1.5, 1024 dims), written into the chunk_vectors table.\`

Rules:
- Aim for **5–12 footnotes per section** — enough to ground every claim, not so many it becomes a citation dump.
- Number footnotes sequentially starting at \`[^1]\` within this section.
- Keep each definition to one or two short sentences. It can mention file paths, libraries, model names, etc. freely — the prose stays clean because all of this lives below the fold.
- Each footnote should cover one specific fact. Don't bundle five files into one footnote.
- End the section with a \`### References\` heading followed by all footnote definitions in order. Omit the heading if there are no footnotes.`;

  return `You are writing the **${section.title}** section of a product document.

**Product:** ${outline.product_summary}

The document is **part PRD** (problem, personas, features, requirements) and **part user-facing product description** (what users do, how they get value, key journeys).

---

${toneBlock}

---

## Section to write

**Title:** ${section.title}
**Role:** ${section.role}
**What this section covers:** ${section.abstract}

${subsectionInstructions}

---

## Diagrams

${diagramInstructions}

---

${crossContext}

---

${footnoteBlock}

---

## Output rules

- Output raw Markdown only. No preamble, no explanation, no meta-commentary.
- Start with exactly: \`## ${section.title}\`
- Use \`### <name>\` for subsections${isEngineeringNotes ? '.' : ' (titles framed as features or user concerns, not code areas).'}
- Mermaid diagrams in \`\`\`mermaid blocks.
- ${isEngineeringNotes ? 'Backtick code spans are encouraged for module names, paths, env vars, type names.' : 'Backtick code spans in prose are restricted to the three allowed cases listed under "THE FOUR FORBIDDEN PATTERNS". Anything else goes in a footnote.'}
- ${isEngineeringNotes ? 'Fenced code blocks are fine where helpful (configs, type sketches, short examples).' : 'Fenced code blocks: ONLY \\\`\\\`\\\`mermaid is allowed. No ts/tsx/js/py/sql/json/yaml/bash code blocks anywhere — they go in footnotes as inline backticks if they must appear at all.'}
- ${isEngineeringNotes ? 'Footnotes optional.' : `Close the section with a \`### References\` block listing all footnote definitions in numeric order.`}
- No outer fence or wrapper around the section — raw Markdown starting with \`## ${section.title}\`.
- Do not repeat content owned by another section — cross-reference instead.

${isEngineeringNotes ? '' : `---

## Pre-submit self-check (mandatory)

Before you finish, re-read your draft and verify each of these. If any check fails, rewrite the offending sentence before submitting.

1. **Scan every paragraph for forbidden tokens.** Search your draft for: \`src/\`, \`packages/\`, \`.ts\`, \`.tsx\`, \`.js\`, \`.py\`, \`.sql\`, \`.json\`, \`.yaml\`, \`function\`, \`class\`, \`const\`, \`let\`, \`SELECT\`, \`/api/\`, brace \`{\`, semicolon-terminated lines. If any appear in prose (not in a footnote definition or a Mermaid block), rewrite that paragraph in user terms and move the technical fact into a footnote.
2. **Scan for forbidden vocabulary.** Search for: \`Claude\`, \`Sonnet\`, \`Haiku\`, \`Opus\`, \`GPT\`, \`Llama\`, \`Inngest\`, \`Hugging Face\`, \`Ollama\`, \`OpenRouter\`, \`Drizzle\`, \`Prisma\`, \`Next.js\`, \`React\`, \`Tailwind\`, \`WorkOS\`, \`AuthKit\`, \`MCP\`, \`OAuth\`, \`JWT\`, \`SSE\`, \`SQLite\`, \`libSQL\`, \`Turso\`, \`sqlite-vec\`, \`Postgres\`, \`embedding\`, \`cosine\`, \`vector\`, \`AES\`. If any appear in prose, rewrite to outcome language and move the name to a footnote.
3. **Code blocks.** Confirm every \`\`\`fenced block is Mermaid. Delete any other code block.
4. **Inline backticks.** Each backtick span in prose must be either a literal terminal command, a UI label the user reads, or an env var the user sets. Anything else: rewrite or move to footnote.
5. **Subsection titles.** Each \`###\` title must read as a feature or user concern (e.g. "Cross-source linking", "Daily project recap"), never as a code area (e.g. "The crossref module", "API surface").
6. **Lead with user value.** Each subsection's first sentence must describe what the user gets — not how the system works.

If you cannot pass any check, rewrite the section. Submit only the final, checked draft.`}

Begin writing now.`;
}

function buildRetryPrompt(section: OutlineSection, previousOutput: string): string {
  const issue =
    !previousOutput.trim()
      ? 'Your previous response was empty.'
      : `Your previous response did not start with \`## ${section.title}\` as required. It started with: "${previousOutput.trim().slice(0, 100)}..."`;

  return `${issue}

Please retry. Write the **${section.title}** section again from scratch, following all the rules:
- Start with exactly: \`## ${section.title}\`
- Raw Markdown only — no preamble, no meta-commentary.
- ${section.id === 'engineering-notes' ? 'Cite real file paths, function names, and code from the repository.' : 'Product-manual prose only. No file paths, code symbols, library/model/protocol names in prose — they go in footnotes.'}
- Use \`### <name>\` for subsections.
- Include any required Mermaid diagrams.

Output the section content now, beginning with \`## ${section.title}\`.`;
}

/* ────────────────────────────────────────────────────────────────────────
 * Polish pass — rewrites the draft as a strict product manual.
 *
 * Run with no repo access. Takes the validated draft and rewrites it,
 * stripping any inline code references the model slipped in despite the
 * rules. Mermaid blocks, footnote definitions, and structure are
 * preserved. Skipped for engineering-notes (which is intentionally
 * technical).
 * ──────────────────────────────────────────────────────────────────────── */

function buildPolishPrompt(section: OutlineSection, draft: string): string {
  return `You are a senior product writer. Rewrite the section below so it reads as a **user manual written by a product manager**. Strip every code-level reference from the prose. Keep diagrams, footnote definitions, and overall structure.

The section will be read by product managers, designers, and customers. It must NOT read like a code walkthrough.

## Input section (the draft)

${draft}

## Rewrite rules

1. **Remove from prose:**
   - File paths and filenames (anything with \`src/\`, \`packages/\`, slashes, or extensions like \`.ts\`, \`.tsx\`, \`.js\`, \`.py\`, \`.sql\`, \`.json\`, \`.yaml\`).
   - Function names, class names, constant names, type names, table names, schema fields, API endpoint paths.
   - Library, framework, SDK, model, protocol, RFC, algorithm, storage product names. Examples: Claude, Sonnet, Haiku, Opus, GPT, Llama, Inngest, Hugging Face, Ollama, OpenRouter, Drizzle, Prisma, Next.js, React, Tailwind, WorkOS, AuthKit, MCP, OAuth, JWT, SSE, OIDC, SAML, RFC, cosine, BM25, RRF, force-directed, k-NN, embedding, chunking, vector index, SQLite, libSQL, Turso, sqlite-vec, Postgres, Redis, S3, FTS5, AES, GCM, react-force-graph, better-sqlite3.
   - Specific tuning numbers without user impact (e.g. "0.6 confidence", "4 hops", "25-item cap", "90-day window") — replace with outcome language.
   - Code-block fences for any language other than \`mermaid\` (delete the entire block — preserve only its semantic intent in prose if it had any).

2. **Inline backtick spans in prose** are allowed only for: a literal command the user types in a terminal (\`bun dev\`), a UI label (\`Settings → Connectors\`), or an env var the user sets in their own shell (\`OPENAI_API_KEY\`). Strip everything else.

3. **Move evicted detail into footnotes.** If a sentence becomes vague after stripping, attach a new footnote that names the dropped detail. Renumber footnotes sequentially.

4. **Rewrite each subsection's opening sentence** to describe what the user gets, not how the system works. The lead must be a user-value statement.

5. **Subsection titles**: rewrite any \`###\` title that reads as a code area (e.g. "The crossref module") into a feature-or-user-concern title (e.g. "Linking related items across tools").

6. **Preserve:**
   - The opening \`## ${section.title}\` heading exactly.
   - All \`\`\`mermaid blocks unchanged.
   - The \`### References\` block at the end. Footnote definitions inside it are allowed to keep file paths, library names, etc. — that is exactly where this detail belongs.
   - Section length should be roughly comparable to the input — don't shrink to a stub.

## Output rules

- Output raw Markdown only. No preamble, no explanation.
- Start with exactly: \`## ${section.title}\`
- End with the \`### References\` block (or omit if the input had none).
- No code fences around the entire output.

Begin the rewritten section now.`;
}

// ────────────────────────────────────────────────────────────────────────────
// Stream helper
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

function isValidSectionMarkdown(text: string, section: OutlineSection): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.startsWith(`## ${section.title}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────────────────

export const almanacDraftSectionHandler: JobHandler = async (job, ctx) => {
  ctx.log('info', `[almanac.draft-section] job ${job.id} starting`);

  // ── Validate params ───────────────────────────────────────────────────────
  const validation = validateParams(job.params);
  if ('error' in validation) {
    return { status: 'failed', error: validation.error };
  }
  const params = validation.valid;

  // ── Find target section ───────────────────────────────────────────────────
  const section = params.outline.sections.find((s) => s.id === params.section_id);
  if (!section) {
    return {
      status: 'failed',
      error: `section_id "${params.section_id}" not found in outline (available: ${params.outline.sections.map((s) => s.id).join(', ')})`,
    };
  }

  // ── Resolve workspace ─────────────────────────────────────────────────────
  ctx.log(
    'info',
    `[almanac.draft-section] resolving workspace for ${params.repoKey}@${params.ref} (section: ${section.id})`,
  );
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
  ctx.log(
    'info',
    `[almanac.draft-section] workspace resolved: ${workspacePath} @ ${sha}`,
  );

  // ── First Claude call ─────────────────────────────────────────────────────
  ctx.log('info', `[almanac.draft-section] sending prompt to Claude for section "${section.title}"`);
  const prompt = buildSectionPrompt(section, params.outline);
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
  ctx.log(
    'info',
    `[almanac.draft-section] Claude response received (${trimmedFirst.length} chars), validating`,
  );

  // ── Validate output ───────────────────────────────────────────────────────
  let finalMarkdown: string;

  if (isValidSectionMarkdown(trimmedFirst, section)) {
    finalMarkdown = trimmedFirst;
  } else {
    // Output was empty or didn't start with `## <title>` — retry once.
    const issue = !trimmedFirst
      ? 'empty'
      : `did not start with "## ${section.title}"`;
    ctx.log(
      'warn',
      `[almanac.draft-section] output ${issue} — retrying for section "${section.title}"`,
    );

    const retryPrompt = buildRetryPrompt(section, trimmedFirst);
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
    ctx.log(
      'info',
      `[almanac.draft-section] retry response received (${trimmedRetry.length} chars), validating`,
    );

    if (!isValidSectionMarkdown(trimmedRetry, section)) {
      return {
        status: 'failed',
        error: `section "${section.id}" output invalid after retry — got ${trimmedRetry.length} chars, expected to start with "## ${section.title}"`,
      };
    }

    finalMarkdown = trimmedRetry;
  }

  // ── Polish pass ───────────────────────────────────────────────────────────
  // Skip the polish pass for the engineering-notes appendix — it is meant
  // to be technical. Every other section gets a second-pass rewrite that
  // strips inline code/library/model references the model slipped in
  // despite the rules. The polish call has NO repo access, so the model
  // can't "go look at the code" and reintroduce technical detail.
  if (section.id !== 'engineering-notes') {
    ctx.log(
      'info',
      `[almanac.draft-section] running polish pass for section "${section.id}"`,
    );
    const polishPrompt = buildPolishPrompt(section, finalMarkdown);
    const polishStream = ctx.streamClaude({
      prompt: polishPrompt,
      cwd: workspacePath,
      allowedTools: [],
      disallowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch', 'Task', 'NotebookEdit'],
    });

    const { text: polishText, finishReason: polishFinish } = await drainStream(polishStream, ctx.sink);

    if (polishFinish === 'error' || polishFinish === 'cancelled') {
      ctx.log(
        'warn',
        `[almanac.draft-section] polish stream ended with ${polishFinish} — keeping draft`,
      );
    } else {
      const trimmedPolish = polishText.trim();
      if (isValidSectionMarkdown(trimmedPolish, section)) {
        ctx.log(
          'info',
          `[almanac.draft-section] polish accepted — ${trimmedPolish.length} chars (was ${finalMarkdown.length})`,
        );
        finalMarkdown = trimmedPolish;
      } else {
        ctx.log(
          'warn',
          `[almanac.draft-section] polish output invalid (${trimmedPolish.length} chars, doesn't start with "## ${section.title}") — keeping draft`,
        );
      }
    }
  }

  // ── POST markdown to server ───────────────────────────────────────────────
  const postPath = `/api/almanac/docs/${params.doc_id}/sections/${params.section_id}`;
  ctx.log('info', `[almanac.draft-section] posting markdown to ${postPath}`);

  let postStatus: number | undefined;
  try {
    const res = await ctx.client(postPath, {
      method: 'POST',
      body: { markdown: finalMarkdown },
    });
    if (
      typeof res === 'object' &&
      res !== null &&
      typeof (res as Record<string, unknown>)['status'] === 'number'
    ) {
      postStatus = (res as Record<string, unknown>)['status'] as number;
    } else {
      postStatus = 200;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log('warn', `[almanac.draft-section] POST to section endpoint failed: ${msg}`);
    return {
      status: 'done',
      payload: {
        chars: finalMarkdown.length,
        ref: sha,
        post_status: 0,
        post_error: msg,
      },
    };
  }

  ctx.log(
    'info',
    `[almanac.draft-section] done — section "${section.id}", ${finalMarkdown.length} chars, POST ${postStatus}`,
  );

  return {
    status: 'done',
    payload: {
      chars: finalMarkdown.length,
      ref: sha,
      post_status: postStatus,
    },
  };
};
