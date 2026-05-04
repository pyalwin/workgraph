import { apiFetch } from "../client.js";
import { runCliJson } from "../cli/spawn.js";
import type { JobHandler } from "./noop.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CliKind = "codex" | "claude" | "gemini";

type Intent = "introduce" | "extend" | "refactor" | "fix" | "revert" | "mixed";
type ArchSignificance = "low" | "medium" | "high";

interface InputEvent {
  sha: string;
  message: string;
  files_touched: string[];
}

interface ClassifyParams {
  workspaceId: string;
  repo: string;
  cli: CliKind;
  model: string | undefined;
  events: InputEvent[];
}

interface ClassifyResult {
  sha: string;
  intent: Intent;
  architectural_significance: ArchSignificance;
  is_feature_evolution: boolean;
}

interface ClassifyJobResult {
  repo: string;
  batch_size: number;
  classified: number;
  missed: number;
}

// ---------------------------------------------------------------------------
// Param validation
// ---------------------------------------------------------------------------

function assertString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`almanac.noise.classify: param '${name}' must be a non-empty string`);
  }
  return v;
}

function assertCliKind(v: unknown): CliKind {
  if (v === undefined || v === null) return "codex";
  if (v === "codex" || v === "claude" || v === "gemini") return v;
  throw new Error(
    `almanac.noise.classify: param 'cli' must be 'codex', 'claude', or 'gemini' (got ${String(v)})`
  );
}

function parseInputEvent(v: unknown, idx: number): InputEvent {
  if (typeof v !== "object" || v === null) {
    throw new Error(`almanac.noise.classify: events[${idx}] must be an object`);
  }
  const e = v as Record<string, unknown>;
  const sha = assertString(e["sha"], `events[${idx}].sha`);
  const message = assertString(e["message"], `events[${idx}].message`);
  if (!Array.isArray(e["files_touched"])) {
    throw new Error(
      `almanac.noise.classify: events[${idx}].files_touched must be an array`
    );
  }
  const files_touched = (e["files_touched"] as unknown[]).map((f, fi) => {
    if (typeof f !== "string")
      throw new Error(
        `almanac.noise.classify: events[${idx}].files_touched[${fi}] must be a string`
      );
    return f;
  });
  return { sha, message, files_touched };
}

function parseParams(params: unknown): ClassifyParams {
  if (typeof params !== "object" || params === null) {
    throw new Error("almanac.noise.classify: params must be an object");
  }
  const p = params as Record<string, unknown>;
  const workspaceId = assertString(p["workspaceId"], "workspaceId");
  const repo = assertString(p["repo"], "repo");
  const cli = assertCliKind(p["cli"]);
  const model =
    typeof p["model"] === "string" && p["model"].trim() !== ""
      ? p["model"].trim()
      : undefined;
  if (!Array.isArray(p["events"])) {
    throw new Error("almanac.noise.classify: param 'events' must be an array");
  }
  const events = (p["events"] as unknown[]).map((e, i) => parseInputEvent(e, i));
  return { workspaceId, repo, cli, model, events };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

const INTENT_VALUES = "introduce|extend|refactor|fix|revert|mixed";
const ARCH_VALUES = "low|medium|high";

function buildPrompt(events: InputEvent[]): string {
  const lines: string[] = [
    "You are a code-change classifier. For each commit below, output exactly one JSON",
    "object per line with no markdown, no preamble, and no trailing text.",
    "",
    "Each output line must have this exact shape:",
    `  { "sha": "<40-char sha>", "intent": "${INTENT_VALUES}", "architectural_significance": "${ARCH_VALUES}", "is_feature_evolution": true|false }`,
    "",
    "Definitions:",
    "  intent:",
    "    introduce  — adds a brand-new capability or major data structure",
    "    extend     — adds behaviour to an existing feature",
    "    refactor   — restructures code without changing external behaviour",
    "    fix        — corrects a defect or crash",
    "    revert     — undoes a previous commit",
    "    mixed      — combines two or more of the above",
    "  architectural_significance:",
    "    high   — touches core abstractions, public interfaces, or cross-cutting concerns",
    "    medium — changes a single module in a notable way",
    "    low    — trivial change (typo, comment, test fixture, lock file, etc.)",
    "  is_feature_evolution:",
    "    true  — this commit advances user-visible product functionality",
    "    false — purely internal (infra, tooling, tests, refactor with no UX effect)",
    "",
    "Examples:",
    '  { "sha": "aabbcc1122334455667788990011223344556677", "intent": "introduce", "architectural_significance": "high", "is_feature_evolution": true }',
    '  { "sha": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "intent": "fix", "architectural_significance": "low", "is_feature_evolution": false }',
    "",
    "Commits to classify:",
    "",
  ];

  for (const evt of events) {
    const msg = evt.message.slice(0, 80);
    const files = evt.files_touched.slice(0, 5).join(", ");
    lines.push(`sha: ${evt.sha}`);
    lines.push(`message: ${msg}`);
    lines.push(`files: ${files || "(none)"}`);
    lines.push("");
  }

  lines.push("Output one JSON line per commit in the order listed above. No other output.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Output parser
// ---------------------------------------------------------------------------

const VALID_INTENTS = new Set<string>(["introduce", "extend", "refactor", "fix", "revert", "mixed"]);
const VALID_ARCH = new Set<string>(["low", "medium", "high"]);

function parseClassifyResult(raw: unknown, knownShas: Set<string>): ClassifyResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const sha = typeof r["sha"] === "string" ? r["sha"].trim() : "";
  if (!sha || !knownShas.has(sha)) return null;

  const intent = typeof r["intent"] === "string" ? r["intent"].trim() : "";
  if (!VALID_INTENTS.has(intent)) return null;

  const arch = typeof r["architectural_significance"] === "string"
    ? r["architectural_significance"].trim()
    : "";
  if (!VALID_ARCH.has(arch)) return null;

  const ife = r["is_feature_evolution"];
  if (typeof ife !== "boolean") return null;

  return {
    sha,
    intent: intent as Intent,
    architectural_significance: arch as ArchSignificance,
    is_feature_evolution: ife,
  };
}

// ---------------------------------------------------------------------------
// Ingest POST
// ---------------------------------------------------------------------------

interface IngestBody {
  workspaceId: string;
  repo: string;
  results: ClassifyResult[];
}

async function postResults(
  workspaceId: string,
  repo: string,
  results: ClassifyResult[]
): Promise<void> {
  const body: IngestBody = { workspaceId, repo, results };
  await apiFetch("/api/almanac/noise/classify/ingest", { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const almanacNoiseClassifyHandler: JobHandler = async (
  params: unknown
): Promise<ClassifyJobResult> => {
  const p = parseParams(params);

  if (p.events.length === 0) {
    return { repo: p.repo, batch_size: 0, classified: 0, missed: 0 };
  }

  // Build the prompt
  const prompt = buildPrompt(p.events);

  // Run the CLI
  const rawOutput = await runCliJson({
    cli: p.cli,
    prompt,
    model: p.model,
  });

  // Parse JSONL output — silently skip lines that don't parse or have wrong shape
  const knownShas = new Set(p.events.map((e) => e.sha));
  const results: ClassifyResult[] = [];
  const seen = new Set<string>();

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Chatty CLIs may print preamble or explanation text — skip silently
      continue;
    }
    const result = parseClassifyResult(parsed, knownShas);
    if (!result) continue;
    // Deduplicate: keep first result per sha in case the CLI repeats itself
    if (seen.has(result.sha)) continue;
    seen.add(result.sha);
    results.push(result);
  }

  // POST to the ingest endpoint even on partial results so partial progress
  // is recorded (the caller can re-run the job for remaining SHAs).
  if (results.length > 0) {
    await postResults(p.workspaceId, p.repo, results);
  }

  return {
    repo: p.repo,
    batch_size: p.events.length,
    classified: results.length,
    missed: p.events.length - results.length,
  };
};
