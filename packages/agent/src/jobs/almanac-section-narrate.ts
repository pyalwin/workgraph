import { apiFetch } from "../client.js";
import { runCliJson } from "../cli/spawn.js";
import { resolveRepoPath } from "../lib/resolve-repo-path.js";
import type { JobHandler } from "./noop.js";

// ---------------------------------------------------------------------------
// Loose dossier types (agent-local, no dependency on server schema)
// ---------------------------------------------------------------------------

interface DossierEvent {
  sha?: unknown;
  pr_number?: unknown;
  occurred_at?: unknown;
  message?: unknown;
  ticket_key?: unknown;
}

interface DossierTicket {
  source_id?: unknown;
  title?: unknown;
  status?: unknown;
}

interface DossierFile {
  path?: unknown;
}

interface DossierDecision {
  text?: unknown;
  decided_at?: unknown;
}

interface Dossier {
  events?: unknown[];
  tickets?: unknown[];
  files?: unknown[];
  decisions?: unknown[];
  [key: string]: unknown;
}

type SectionKind =
  | "cover"
  | "summary"
  | "unit"
  | "drift_unticketed"
  | "drift_unbuilt"
  | "decisions"
  | "appendix";

type CliKind = "codex" | "claude" | "gemini";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface NarrateParams {
  workspaceId: string;
  projectKey: string;
  anchor: string;
  title: string;
  kind: SectionKind;
  sourceHash: string;
  dossier: Dossier;
  skeletonMarkdown?: string;
  cli: CliKind;
  model?: string;
}

// ---------------------------------------------------------------------------
// Param validation
// ---------------------------------------------------------------------------

function assertString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`almanac.section.narrate: param '${name}' must be a non-empty string`);
  }
  return v;
}

const VALID_KINDS: Set<string> = new Set([
  "cover",
  "summary",
  "unit",
  "drift_unticketed",
  "drift_unbuilt",
  "decisions",
  "appendix",
]);

function assertKind(v: unknown): SectionKind {
  if (typeof v !== "string" || !VALID_KINDS.has(v)) {
    throw new Error(
      `almanac.section.narrate: param 'kind' must be one of ${[...VALID_KINDS].join(", ")} (got ${String(v)})`
    );
  }
  return v as SectionKind;
}

function assertCliKind(v: unknown): CliKind {
  if (v === undefined || v === null) return "codex";
  if (v === "codex" || v === "claude" || v === "gemini") return v;
  throw new Error(
    `almanac.section.narrate: param 'cli' must be 'codex', 'claude', or 'gemini' (got ${String(v)})`
  );
}

function assertDossier(v: unknown): Dossier {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("almanac.section.narrate: param 'dossier' must be an object");
  }
  return v as Dossier;
}

function parseParams(params: unknown): NarrateParams {
  if (typeof params !== "object" || params === null) {
    throw new Error("almanac.section.narrate: params must be an object");
  }
  const p = params as Record<string, unknown>;

  const workspaceId = assertString(p["workspaceId"], "workspaceId");
  const projectKey = assertString(p["projectKey"], "projectKey");
  const anchor = assertString(p["anchor"], "anchor");
  const title = assertString(p["title"], "title");
  const kind = assertKind(p["kind"]);
  const sourceHash = assertString(p["sourceHash"], "sourceHash");
  const dossier = assertDossier(p["dossier"]);
  const cli = assertCliKind(p["cli"]);
  const model =
    typeof p["model"] === "string" && p["model"].trim() !== ""
      ? p["model"].trim()
      : undefined;
  const skeletonMarkdown =
    typeof p["skeletonMarkdown"] === "string" && p["skeletonMarkdown"].trim() !== ""
      ? p["skeletonMarkdown"].trim()
      : undefined;

  return {
    workspaceId,
    projectKey,
    anchor,
    title,
    kind,
    sourceHash,
    dossier,
    cli,
    model,
    skeletonMarkdown,
  };
}

// ---------------------------------------------------------------------------
// Dossier helpers — extract typed slices from loose dossier
// ---------------------------------------------------------------------------

function getEvents(dossier: Dossier): DossierEvent[] {
  if (!Array.isArray(dossier.events)) return [];
  return dossier.events.filter(
    (e): e is DossierEvent => typeof e === "object" && e !== null
  );
}

function getTickets(dossier: Dossier): DossierTicket[] {
  if (!Array.isArray(dossier.tickets)) return [];
  return dossier.tickets.filter(
    (t): t is DossierTicket => typeof t === "object" && t !== null
  );
}

function getFiles(dossier: Dossier): DossierFile[] {
  if (!Array.isArray(dossier.files)) return [];
  return dossier.files.filter(
    (f): f is DossierFile => typeof f === "object" && f !== null
  );
}

function getDecisions(dossier: Dossier): DossierDecision[] {
  if (!Array.isArray(dossier.decisions)) return [];
  return dossier.decisions.filter(
    (d): d is DossierDecision => typeof d === "object" && d !== null
  );
}

/** Collect all entity strings the LLM may cite (sha prefixes, ticket keys, file paths). */
function collectEntities(dossier: Dossier): string[] {
  const entities: string[] = [];
  for (const e of getEvents(dossier)) {
    if (typeof e.sha === "string" && e.sha.length >= 7) {
      entities.push(e.sha.slice(0, 7));
    }
    if (typeof e.ticket_key === "string" && e.ticket_key.trim()) {
      entities.push(e.ticket_key.trim());
    }
    if (typeof e.pr_number === "number") {
      entities.push(`#${e.pr_number}`);
    }
  }
  for (const t of getTickets(dossier)) {
    if (typeof t.source_id === "string" && t.source_id.trim()) {
      entities.push(t.source_id.trim());
    }
  }
  for (const f of getFiles(dossier)) {
    if (typeof f.path === "string" && f.path.trim()) {
      entities.push(f.path.trim());
    }
  }
  return entities;
}

// ---------------------------------------------------------------------------
// Prompt builders
//
// Strategy: instead of stuffing a curated set of files into the prompt, run
// the CLI with cwd = the repo root and let the CLI's own filesystem tools
// explore. Codex/Claude/Gemini all have read access when launched with their
// read-only sandbox flag. The dossier still acts as targeting info (which
// files / tickets are in scope) but the CLI is free to read more if it
// needs to.
// ---------------------------------------------------------------------------

const COMMON_RULES = `
Rules (follow strictly):
- Output raw markdown only. No \`\`\`markdown fences. No preamble. No trailing commentary.
- Cite real artefacts — file paths with line numbers, function names, types, route paths, SQL table names. Do NOT invent any.
- You can read any file under the current working directory. Prefer the files listed in 'Targeting' below as starting points, but follow imports and call chains as far as needed to explain things accurately.
- Quote code snippets liberally when they make a contract, schema, or flow concrete. Short snippets are fine.
- BE AS ELABORATE AND EXTENSIVE AS POSSIBLE. This document is the foundation of a RAG system — depth and completeness matter more than brevity. Do NOT self-limit. Walk through every relevant file. Trace every flow end-to-end. Document every contract.
- Write techno-functional docs, NOT commit history. Explain how the system works today, not when each PR shipped.
`.trim();

function formatDossierSection(label: string, items: string[]): string {
  if (items.length === 0) return "";
  return `\n${label}:\n${items.map((s) => `  - ${s}`).join("\n")}`;
}

function eventSummaryLines(events: DossierEvent[], limit = 20): string[] {
  return events.slice(0, limit).map((e) => {
    const sha = typeof e.sha === "string" ? e.sha.slice(0, 7) : "?";
    const date = typeof e.occurred_at === "string" ? e.occurred_at.slice(0, 10) : "";
    const msg = typeof e.message === "string" ? e.message.slice(0, 80) : "";
    const ticket = typeof e.ticket_key === "string" ? ` [${e.ticket_key}]` : "";
    const pr = typeof e.pr_number === "number" ? ` #${e.pr_number}` : "";
    return `${sha}${pr}${ticket} ${date} ${msg}`.trim();
  });
}

function buildCoverPrompt(p: NarrateParams): string {
  const tickets = getTickets(p.dossier).slice(0, 20);
  const ticketLines = tickets.map((t) => {
    const id = typeof t.source_id === "string" ? t.source_id : "";
    const title = typeof t.title === "string" ? t.title : "";
    const status = typeof t.status === "string" ? t.status : "";
    return `${id} ${title} (${status})`.trim();
  });

  return [
    `Write a cover section for the Almanac of project "${p.projectKey}" titled "${p.title}".`,
    "",
    "Structure:",
    "1. Two paragraphs introducing the project — what it does and who it serves.",
    "2. A bullet list of the main functional units or areas of work (derived from the tickets and events below).",
    "3. A brief note that a project map diagram follows below (do not render the diagram yourself).",
    "",
    COMMON_RULES,
    "",
    "Dossier evidence:",
    formatDossierSection("Tickets (sample)", ticketLines),
    formatDossierSection("Events (sample)", eventSummaryLines(getEvents(p.dossier))),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function buildSummaryPrompt(p: NarrateParams): string {
  const tickets = getTickets(p.dossier);
  const ticketLines = tickets.slice(0, 12).map((t) => {
    const id = typeof t.source_id === "string" ? t.source_id : "";
    const title = typeof t.title === "string" ? t.title : "";
    return `${id}: ${title}`;
  });

  return [
    `Write a comprehensive techno-functional executive summary for the project "${p.projectKey}".`,
    "",
    "READER: an engineer onboarding to this codebase. They want to understand HOW the system is built, what runs where, and where to look for what.",
    "",
    "EXPLORE THE CODEBASE FREELY — your cwd is set to the repo root. Read package.json, the routing layout under src/app/, the DB schema, the middleware/proxy, the inngest functions directory, the lib directory. Follow imports. Then write the doc.",
    "",
    "Structure (use these exact headings, but go DEEP under each):",
    "",
    "## Stack & runtime",
    "  Runtime, framework, deployment target, primary deps (auth, DB, async runner, AI providers, embedding model). Cite package.json.",
    "",
    "## Repository layout",
    "  Walk the top of src/ and packages/. For each major directory, what lives there, what depends on it, what conventions apply.",
    "",
    "## Primary entities & data model",
    "  All top-level DB tables and the relationships between them. For each: columns, what owns it, who reads it. Cite the schema file.",
    "",
    "## Authentication & authorization",
    "  How requests get authed, cookie/session shape, where withAuth() is enforced, exception paths.",
    "",
    "## Major workflows (one subsection per flow)",
    "  For each major user-driven or scheduled flow: name it, describe the trigger, list the route/inngest entry point, trace the call chain through library functions to the DB writes / side effects, name the tables and columns it touches, describe the response shape.",
    "  Common flows include: connector OAuth, sync/ingest pipelines, scheduled reports, the chat / AI loop, the local-agent pair + job flow, the Almanac pipeline.",
    "",
    "## Cross-cutting infrastructure",
    "  Inngest cron schedule, embeddings pipeline, AI provider switching, retry / idempotency keys, observability hooks.",
    "",
    "## Operational notes",
    "  How to run locally, important env vars, common failure modes.",
    "",
    COMMON_RULES,
    "",
    "Targeting hints (start here, but expand far beyond as needed):",
    formatDossierSection("Sample tickets in this project", ticketLines),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function buildUnitPrompt(p: NarrateParams): string {
  const tickets = getTickets(p.dossier);
  const dossierFiles = getFiles(p.dossier);
  const filePaths = dossierFiles
    .map((f) => (typeof f.path === "string" ? f.path : ""))
    .filter((s) => s.length > 0);
  const ticketLines = tickets.slice(0, 15).map((t) => {
    const id = typeof t.source_id === "string" ? t.source_id : "";
    const title = typeof t.title === "string" ? t.title : "";
    return `${id}: ${title}`;
  });

  return [
    `Write canonical techno-functional documentation for the "${p.title}" capability.`,
    "",
    "READER: an engineer who needs to understand exactly how this part of the system works in order to extend, debug, or onboard onto it. This document is also the source for a RAG index, so it should be thorough enough to answer specific questions about workflow, data shapes, and edge cases.",
    "",
    "EXPLORE THE CODEBASE FREELY — your cwd is set to the repo root. The 'Targeting' section below lists files most associated with this capability (ranked by churn) but you should follow imports, read called functions, look at related routes / Inngest functions / DB queries, and document everything that's relevant.",
    "",
    "DO NOT WRITE A TICKET HISTORY. Ignore commit timeline / who shipped when. Describe the system AS IT IS NOW, with file paths and code citations.",
    "",
    "Structure (use these exact headings, go DEEP under each):",
    "",
    "## What this does",
    "  Two paragraphs. The user-visible capability in plain language: what problem does it solve, who triggers it (UI button? cron? webhook?), what the visible outcome is, where it shows up.",
    "",
    "## Architecture overview",
    "  A short summary of the moving parts: which routes, which library functions, which DB tables, which background jobs, which external systems. Mention each by file path.",
    "",
    "## End-to-end workflow",
    "  Step-by-step trace of the primary flow. Each step:",
    "    - the trigger or upstream caller",
    "    - the file:line of the entry point",
    "    - the work it does (with quoted snippets when they clarify)",
    "    - the data it reads / writes (table + columns)",
    "    - what it returns or hands off to next",
    "  If there are multiple flows (cron vs manual, success vs failure, retry, idempotent re-run), give each its own subsection. Trace each branch fully.",
    "",
    "## Data model",
    "  Tables this capability owns or relies on. For each: schema (cite the schema file), purpose, who writes, who reads, indexes, idempotency / unique constraints.",
    "",
    "## Public contracts",
    "  Route handlers (HTTP method + path + request body + response shape), exported library functions (signature + return type), agent_jobs kinds. Quote signatures.",
    "",
    "## Internal contracts & types",
    "  Important interfaces, zod schemas, and JSON shapes used between layers. Quote them.",
    "",
    "## Failure modes & gotchas",
    "  What can break, what's idempotent, retry semantics, rate limits, known edge cases visible in the code, error paths, fallbacks.",
    "",
    "## Configuration",
    "  Env vars, feature flags, connector configs, settings tables this depends on.",
    "",
    "## How to extend or modify",
    "  Concrete pointers — to add a new X, edit file Y; to change behavior Z, look at function W.",
    "",
    "## References",
    "  Comprehensive bullet list of every file path you cited → its one-line role. Then list ticket keys most relevant to current state.",
    "",
    COMMON_RULES,
    "",
    "Targeting (start here, follow imports far beyond):",
    formatDossierSection("Files most associated with this capability (ranked by churn)", filePaths),
    formatDossierSection("Linked tickets", ticketLines),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function buildDriftUnticketedPrompt(p: NarrateParams): string {
  const events = getEvents(p.dossier);
  const unticketed = events.filter((e) => !e.ticket_key).slice(0, 20);
  const unticketedLines = unticketed.map((e) => {
    const sha = typeof e.sha === "string" ? e.sha.slice(0, 7) : "?";
    const msg = typeof e.message === "string" ? e.message.slice(0, 80) : "";
    const date = typeof e.occurred_at === "string" ? e.occurred_at.slice(0, 10) : "";
    return `${sha} ${date} ${msg}`.trim();
  });

  return [
    `Write a drift section titled "${p.title}" explaining where code commits occurred without linked tickets.`,
    "",
    "Structure:",
    "1. Opening paragraph — what unticketed drift means and its risk.",
    "2. Top examples list — cite specific SHAs and commit messages from the dossier.",
    "3. Closing sentence — recommendation (add tickets retroactively, or accept as maintenance).",
    "",
    COMMON_RULES,
    "",
    "Dossier evidence (unticketed commits):",
    formatDossierSection("Unticketed events", unticketedLines),
    `\nTotal unticketed commits in dossier: ${events.filter((e) => !e.ticket_key).length}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function buildDriftUnbuiltPrompt(p: NarrateParams): string {
  const tickets = getTickets(p.dossier);
  const doneTickets = tickets
    .filter((t) => {
      const s = typeof t.status === "string" ? t.status.toLowerCase() : "";
      return s === "done" || s === "closed" || s === "resolved";
    })
    .slice(0, 15);
  const doneLines = doneTickets.map((t) => {
    const id = typeof t.source_id === "string" ? t.source_id : "";
    const title = typeof t.title === "string" ? t.title : "";
    return `${id}: ${title}`;
  });

  return [
    `Write a drift section titled "${p.title}" about tickets marked done but with no linked merged code.`,
    "",
    "Structure:",
    "1. Opening paragraph — why this is a risk (undocumented deploys, manual changes, or stale tickets).",
    "2. List of affected ticket keys from the dossier.",
    "3. Recommendation callout (verify manually, close if stale, or link missing PRs).",
    "",
    COMMON_RULES,
    "",
    "Dossier evidence (done tickets with no linked commits in dossier):",
    formatDossierSection("Done tickets", doneLines),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function buildDecisionsPrompt(p: NarrateParams): string {
  const decisions = getDecisions(p.dossier);
  const decisionLines = decisions.slice(0, 20).map((d) => {
    const text = typeof d.text === "string" ? d.text.slice(0, 120) : "";
    const date = typeof d.decided_at === "string" ? d.decided_at.slice(0, 10) : "";
    return `${date} — ${text}`.trim();
  });

  return [
    `Write a decisions section titled "${p.title}" as a chronological narrative of architectural and product decisions.`,
    "",
    "Structure:",
    "1. Brief intro sentence about decision-making in this project.",
    "2. Chronological narrative paragraph or bullet list — one entry per decision, citing the date and decision text from the dossier.",
    "",
    "Do not editorialize beyond what the dossier states.",
    "",
    COMMON_RULES,
    "",
    "Dossier evidence (decisions):",
    formatDossierSection("Decisions (chronological)", decisionLines),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function buildAppendixPrompt(p: NarrateParams): string {
  return [
    `Write a brief appendix intro section titled "${p.title}".`,
    "",
    "Structure:",
    "1. One short paragraph introducing the appendix — explain that the swimlane diagram below shows code activity over time per functional unit.",
    "2. One sentence directing the reader to the diagram that follows.",
    "",
    "Keep this section very short (2–4 sentences total). The diagram will be appended automatically.",
    "",
    COMMON_RULES,
  ].join("\n");
}

/**
 * Sniff a repo identifier ("owner/name") from the dossier so we can resolve
 * a local clone path to use as the CLI's cwd. The agent has already paired
 * with one repo for the run — most fields ride along on dossier.repo or
 * dossier.events[*].repo.
 */
function inferRepoFromDossier(dossier: Dossier): string {
  if (typeof dossier.repo === "string" && dossier.repo.trim()) return dossier.repo;
  if (Array.isArray(dossier.events)) {
    for (const e of dossier.events) {
      if (typeof e === "object" && e !== null && typeof (e as { repo?: unknown }).repo === "string") {
        return (e as { repo: string }).repo;
      }
    }
  }
  return "";
}

function buildPrompt(p: NarrateParams): string {
  switch (p.kind) {
    case "cover":
      return buildCoverPrompt(p);
    case "summary":
      return buildSummaryPrompt(p);
    case "unit":
      return buildUnitPrompt(p);
    case "drift_unticketed":
      return buildDriftUnticketedPrompt(p);
    case "drift_unbuilt":
      return buildDriftUnbuiltPrompt(p);
    case "decisions":
      return buildDecisionsPrompt(p);
    case "appendix":
      return buildAppendixPrompt(p);
  }
}

// ---------------------------------------------------------------------------
// Diagram fence preservation
// ---------------------------------------------------------------------------

const DIAGRAM_FENCE_RE = /:::diagram[\s\S]*?:::/g;

function extractDiagramFences(md: string): string[] {
  return md.match(DIAGRAM_FENCE_RE) ?? [];
}

/** Append any diagram fences from skeletonMarkdown that the LLM omitted. */
function preserveDiagramFences(
  generated: string,
  skeletonMarkdown: string | undefined
): string {
  if (!skeletonMarkdown) return generated;

  const required = extractDiagramFences(skeletonMarkdown);
  if (required.length === 0) return generated;

  const present = extractDiagramFences(generated);
  const presentSet = new Set(present.map((s) => s.trim()));

  const missing = required.filter((fence) => !presentSet.has(fence.trim()));
  if (missing.length === 0) return generated;

  return `${generated.trimEnd()}\n\n${missing.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type ValidationResult =
  | { ok: true; hasReferences: boolean }
  | { ok: false; reason: string };

function validateMarkdown(markdown: string, dossier: Dossier): ValidationResult {
  const len = markdown.length;
  if (len < 200) {
    return { ok: false, reason: `output too short: ${len} chars (min 200)` };
  }
  // No upper-bound — these docs are the foundation of a RAG index; depth
  // and completeness matter more than brevity. The DB column is TEXT
  // (libSQL has no practical column-size cap for our use case).

  // Must contain at least one entity from the dossier (anti-hallucination guard).
  // Exception: appendix kind is intentionally short and may have no entity refs.
  const entities = collectEntities(dossier);
  let hasReferences = false;

  if (entities.length > 0) {
    for (const entity of entities) {
      if (entity.length >= 3 && markdown.includes(entity)) {
        hasReferences = true;
        break;
      }
    }
    if (!hasReferences) {
      return {
        ok: false,
        reason:
          "output contains no referenced entities from dossier (SHA, ticket key, file path, or PR number) — possible hallucination",
      };
    }
  } else {
    // Dossier has no entities to reference — accept output without entity check.
    hasReferences = false;
  }

  return { ok: true, hasReferences };
}

// ---------------------------------------------------------------------------
// Ingest POST
// ---------------------------------------------------------------------------

interface IngestBody {
  workspaceId: string;
  // Server expects { workspaceId, sections: [...] }. Even single posts
  // must use the array form, with snake_case section keys.
  sections: Array<{
    project_key: string;
    anchor: string;
    title: string;
    markdown: string;
    source_hash: string;
  }>;
}

async function postSection(params: NarrateParams, markdown: string): Promise<void> {
  const body: IngestBody = {
    workspaceId: params.workspaceId,
    sections: [
      {
        project_key: params.projectKey,
        anchor: params.anchor,
        title: params.title,
        markdown,
        source_hash: params.sourceHash,
      },
    ],
  };
  await apiFetch("/api/almanac/sections/ingest", { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

type NarrateJobResult =
  | { ok: true; anchor: string; kind: string; chars: number; hasReferences: boolean }
  | { ok: false; success: false; reason: string };

export const almanacSectionNarrateHandler: JobHandler = async (
  params: unknown
): Promise<NarrateJobResult> => {
  const p = parseParams(params);

  const prompt = buildPrompt(p);

  // Resolve the local clone path so the CLI runs INSIDE the repo. Codex's
  // --sandbox read-only flag plus a non-default cwd lets it grep / read /
  // follow imports without us having to ship file contents in the prompt.
  // If the repo can't be resolved, fall back to undefined cwd — the CLI
  // will still produce something, just without filesystem context.
  let cwd: string | undefined;
  try {
    const repo = inferRepoFromDossier(p.dossier);
    if (repo) cwd = resolveRepoPath(repo);
  } catch {
    cwd = undefined;
  }

  const rawOutput = await runCliJson({
    cli: p.cli,
    prompt,
    model: p.model,
    cwd,
  });

  const trimmed = rawOutput.trim();

  // Apply diagram fence preservation before validation.
  const markdown = preserveDiagramFences(trimmed, p.skeletonMarkdown);

  const validation = validateMarkdown(markdown, p.dossier);
  if (!validation.ok) {
    return { ok: false, success: false, reason: validation.reason };
  }

  await postSection(p, markdown);

  return {
    ok: true,
    anchor: p.anchor,
    kind: p.kind,
    chars: markdown.length,
    hasReferences: validation.hasReferences,
  };
};
