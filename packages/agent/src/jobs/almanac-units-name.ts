import { apiFetch } from "../client.js";
import { runCliJson } from "../cli/spawn.js";
import type { JobHandler } from "./noop.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CliKind = "codex" | "claude" | "gemini";

interface InputUnit {
  unit_id: string;
  sample_files: string[];
  sample_messages: string[];
}

interface NameParams {
  workspaceId: string;
  repo: string;
  cli: CliKind;
  model: string | undefined;
  units: InputUnit[];
}

interface NameResult {
  unit_id: string;
  name: string;
  description: string;
  keywords: string[];
}

interface NameJobResult {
  repo: string;
  batch_size: number;
  named: number;
  missed: number;
}

// ---------------------------------------------------------------------------
// Param validation
// ---------------------------------------------------------------------------

function assertString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`almanac.units.name: param '${name}' must be a non-empty string`);
  }
  return v;
}

function assertCliKind(v: unknown): CliKind {
  if (v === undefined || v === null) return "codex";
  if (v === "codex" || v === "claude" || v === "gemini") return v;
  throw new Error(
    `almanac.units.name: param 'cli' must be 'codex', 'claude', or 'gemini' (got ${String(v)})`
  );
}

function parseInputUnit(v: unknown, idx: number): InputUnit {
  if (typeof v !== "object" || v === null) {
    throw new Error(`almanac.units.name: units[${idx}] must be an object`);
  }
  const u = v as Record<string, unknown>;
  const unit_id = assertString(u["unit_id"], `units[${idx}].unit_id`);

  if (!Array.isArray(u["sample_files"])) {
    throw new Error(`almanac.units.name: units[${idx}].sample_files must be an array`);
  }
  const sample_files = (u["sample_files"] as unknown[]).map((f, fi) => {
    if (typeof f !== "string")
      throw new Error(`almanac.units.name: units[${idx}].sample_files[${fi}] must be a string`);
    return f;
  });

  if (!Array.isArray(u["sample_messages"])) {
    throw new Error(`almanac.units.name: units[${idx}].sample_messages must be an array`);
  }
  const sample_messages = (u["sample_messages"] as unknown[]).map((m, mi) => {
    if (typeof m !== "string")
      throw new Error(`almanac.units.name: units[${idx}].sample_messages[${mi}] must be a string`);
    return m;
  });

  return { unit_id, sample_files, sample_messages };
}

function parseParams(params: unknown): NameParams {
  if (typeof params !== "object" || params === null) {
    throw new Error("almanac.units.name: params must be an object");
  }
  const p = params as Record<string, unknown>;
  const workspaceId = assertString(p["workspaceId"], "workspaceId");
  const repo = assertString(p["repo"], "repo");
  const cli = assertCliKind(p["cli"]);
  const model =
    typeof p["model"] === "string" && p["model"].trim() !== ""
      ? p["model"].trim()
      : undefined;
  if (!Array.isArray(p["units"])) {
    throw new Error("almanac.units.name: param 'units' must be an array");
  }
  const units = (p["units"] as unknown[]).map((u, i) => parseInputUnit(u, i));
  return { workspaceId, repo, cli, model, units };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(units: InputUnit[]): string {
  const lines: string[] = [
    "You name product capabilities based on co-evolving code paths.",
    "For each functional unit below, output exactly one JSON object per line.",
    "No markdown, no preamble, no trailing text — raw JSON lines only.",
    "",
    "Each output line must have this exact shape:",
    '  { "unit_id": "<id>", "name": "Human Readable Name", "description": "1-2 sentence what it does", "keywords": ["kw1", "kw2"] }',
    "",
    "Rules:",
    "  name        — 3 to 80 characters, title-cased, no trailing punctuation",
    "  description — 10 to 500 characters, plain prose, what the unit does for users",
    '  keywords    — 1 to 10 short lowercase strings (e.g. ["auth", "session", "jwt"])',
    "",
    "Example:",
    '  { "unit_id": "unit-abc123", "name": "User Authentication", "description": "Handles login, logout, and session management for workspace members.", "keywords": ["auth", "session", "login", "jwt"] }',
    "",
    "Functional units to name (up to 50):",
    "",
  ];

  for (const unit of units.slice(0, 50)) {
    const files = unit.sample_files.slice(0, 5);
    const messages = unit.sample_messages.slice(0, 5);
    lines.push(`unit_id: ${unit.unit_id}`);
    lines.push(`files: ${files.length > 0 ? files.join(", ") : "(none)"}`);
    lines.push(`recent commits: ${messages.length > 0 ? messages.join(" | ") : "(none)"}`);
    lines.push("");
  }

  lines.push("Output JSON lines now, no preamble.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Output parser
// ---------------------------------------------------------------------------

function parseNameResult(raw: unknown, knownIds: Set<string>): NameResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const unit_id = typeof r["unit_id"] === "string" ? r["unit_id"].trim() : "";
  if (!unit_id || !knownIds.has(unit_id)) return null;

  const name = typeof r["name"] === "string" ? r["name"].trim() : "";
  if (name.length < 3 || name.length > 80) return null;

  const description = typeof r["description"] === "string" ? r["description"].trim() : "";
  if (description.length < 10 || description.length > 500) return null;

  if (!Array.isArray(r["keywords"])) return null;
  const rawKw = r["keywords"] as unknown[];
  if (rawKw.length < 1 || rawKw.length > 10) return null;
  const keywords: string[] = [];
  for (const kw of rawKw) {
    if (typeof kw !== "string") return null;
    keywords.push(kw);
  }

  return { unit_id, name, description, keywords };
}

// ---------------------------------------------------------------------------
// Ingest POST
// ---------------------------------------------------------------------------

interface IngestBody {
  workspaceId: string;
  results: NameResult[];
}

async function postResults(
  workspaceId: string,
  results: NameResult[]
): Promise<void> {
  const body: IngestBody = { workspaceId, results };
  await apiFetch("/api/almanac/units/ingest", { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const almanacUnitsNameHandler: JobHandler = async (
  params: unknown
): Promise<NameJobResult> => {
  const p = parseParams(params);

  if (p.units.length === 0) {
    return { repo: p.repo, batch_size: 0, named: 0, missed: 0 };
  }

  // Build the prompt
  const prompt = buildPrompt(p.units);

  // Run the CLI — event-shape parsing is handled inside runCliJson and is
  // identical for all three CLIs (Codex/Claude/Gemini) per spawn.ts.
  const rawOutput = await runCliJson({
    cli: p.cli,
    prompt,
    model: p.model,
  });

  // Parse JSONL output — silently skip lines that don't parse or fail validation
  const knownIds = new Set(p.units.map((u) => u.unit_id));
  const results: NameResult[] = [];
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
    const result = parseNameResult(parsed, knownIds);
    if (!result) continue;
    // Deduplicate: keep first result per unit_id in case the CLI repeats itself
    if (seen.has(result.unit_id)) continue;
    seen.add(result.unit_id);
    results.push(result);
  }

  // POST to the ingest endpoint even on partial results so partial progress
  // is recorded (the caller can re-run the job for remaining unit IDs).
  if (results.length > 0) {
    await postResults(p.workspaceId, results);
  }

  return {
    repo: p.repo,
    batch_size: p.units.length,
    named: results.length,
    missed: p.units.length - results.length,
  };
};
