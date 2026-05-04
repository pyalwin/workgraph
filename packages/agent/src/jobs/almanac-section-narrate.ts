import { apiFetch } from "../client.js";
import { runCliJson } from "../cli/spawn.js";
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
// ---------------------------------------------------------------------------

const COMMON_RULES = `
Rules (follow strictly):
- Output raw markdown only. No \`\`\`markdown fences. No preamble. No trailing commentary.
- Do NOT invent SHAs, PR numbers, file paths, ticket keys, or author names not present in the dossier JSON below.
- Quote at most 5 short code snippets. Be terse.
- Length: 200–8000 characters.
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
  const events = getEvents(p.dossier);
  const tickets = getTickets(p.dossier);
  const untimestampedCount = events.filter((e) => !e.ticket_key).length;
  const ticketLines = tickets.slice(0, 15).map((t) => {
    const id = typeof t.source_id === "string" ? t.source_id : "";
    const title = typeof t.title === "string" ? t.title : "";
    const status = typeof t.status === "string" ? t.status : "";
    return `${id}: ${title} — ${status}`;
  });

  return [
    `Write an ~200-word executive summary for project "${p.projectKey}".`,
    "",
    "Cover:",
    "- Overall project state and recent momentum.",
    "- Key drift highlights (work without tickets, tickets without merged code).",
    "- Notable completions or blockers visible in the dossier.",
    "",
    COMMON_RULES,
    "",
    "Dossier evidence:",
    formatDossierSection("Tickets (sample)", ticketLines),
    formatDossierSection("Recent events", eventSummaryLines(events, 10)),
    `\nUnticketed commit count: ${untimestampedCount}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function buildUnitPrompt(p: NarrateParams): string {
  const events = getEvents(p.dossier);
  const tickets = getTickets(p.dossier);
  const files = getFiles(p.dossier).slice(0, 15);
  const filePaths = files.map((f) => (typeof f.path === "string" ? f.path : "?"));
  const ticketLines = tickets.slice(0, 15).map((t) => {
    const id = typeof t.source_id === "string" ? t.source_id : "";
    const title = typeof t.title === "string" ? t.title : "";
    const status = typeof t.status === "string" ? t.status : "";
    return `${id}: ${title} — ${status}`;
  });

  return [
    `Write a per-unit narrative section titled "${p.title}".`,
    "",
    "Structure (in order):",
    "1. Identity paragraph — what this functional unit is, what it owns.",
    "2. Evolution — chronological narrative of key changes, citing SHA prefixes and ticket keys from the dossier.",
    "3. Drift — any commits without linked tickets, or tickets without merged code (skip if none).",
    "4. Key tickets — 3–8 bullet points of significant tickets with their status.",
    "5. Decisions — any notable architectural or product decisions recorded in the dossier.",
    "",
    "Cite SHAs, PR numbers, and ticket keys directly from the dossier. Do not invent any.",
    "",
    COMMON_RULES,
    "",
    "Dossier evidence:",
    formatDossierSection("Files", filePaths),
    formatDossierSection("Tickets", ticketLines),
    formatDossierSection("Events (chronological)", eventSummaryLines(events, 25)),
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
  if (len > 8000) {
    return { ok: false, reason: `output too long: ${len} chars (max 8000)` };
  }

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
  projectKey: string;
  anchor: string;
  kind: string;
  title: string;
  markdown: string;
  sourceHash: string;
}

async function postSection(params: NarrateParams, markdown: string): Promise<void> {
  const body: IngestBody = {
    workspaceId: params.workspaceId,
    projectKey: params.projectKey,
    anchor: params.anchor,
    kind: params.kind,
    title: params.title,
    markdown,
    sourceHash: params.sourceHash,
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

  const rawOutput = await runCliJson({
    cli: p.cli,
    prompt,
    model: p.model,
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
