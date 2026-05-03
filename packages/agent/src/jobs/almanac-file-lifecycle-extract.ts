import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { apiFetch } from "../client.js";
import type { JobHandler } from "./noop.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface LifecycleParams {
  workspaceId: string;
  repo: string;      // "owner/name"
  repoPath: string;  // absolute path to local clone
  branch?: string;   // default "main", fallback "master"
}

function assertString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`almanac.file-lifecycle.extract: param '${name}' must be a non-empty string`);
  }
  return v;
}

function parseParams(params: unknown): LifecycleParams {
  if (typeof params !== "object" || params === null) {
    throw new Error("almanac.file-lifecycle.extract: params must be an object");
  }
  const p = params as Record<string, unknown>;
  const result: LifecycleParams = {
    workspaceId: assertString(p["workspaceId"], "workspaceId"),
    repo: assertString(p["repo"], "repo"),
    repoPath: assertString(p["repoPath"], "repoPath"),
  };
  if (p["branch"] !== undefined) {
    result.branch = assertString(p["branch"], "branch");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Git helpers (verbatim from almanac-code-events-extract.ts)
// packages/agent is a standalone npm package; no shared utils file needed.
// ---------------------------------------------------------------------------

/** Runs a git command, collects stdout as lines. */
function gitLines(cwd: string, args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => lines.push(line));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`git ${args[0]} exited with code ${code}`));
      else resolve(lines);
    });
    child.on("error", reject);
  });
}

/** Resolves the actual branch name, falling back from "main" → "master". */
async function resolveBranch(cwd: string, preferred: string): Promise<string> {
  try {
    const lines = await gitLines(cwd, ["branch", "--list", preferred]);
    if (lines.some((l) => l.trim().replace(/^\*\s*/, "") === preferred)) {
      return preferred;
    }
  } catch {
    // ignore
  }
  try {
    const lines = await gitLines(cwd, [
      "branch",
      "--list",
      "--remote",
      `origin/${preferred}`,
    ]);
    if (lines.length > 0) return preferred;
  } catch {
    // ignore
  }

  if (preferred === "main") {
    try {
      const lines = await gitLines(cwd, ["branch", "--list", "master"]);
      if (lines.some((l) => l.trim().replace(/^\*\s*/, "") === "master")) {
        return "master";
      }
      const rlines = await gitLines(cwd, [
        "branch",
        "--list",
        "--remote",
        "origin/master",
      ]);
      if (rlines.length > 0) return "master";
    } catch {
      // ignore
    }
  }

  return preferred;
}

// ---------------------------------------------------------------------------
// Path record
// ---------------------------------------------------------------------------

type FileStatus = "extant" | "deleted";

interface PathRecord {
  path: string;
  first_sha: string;
  first_at: string;
  last_sha: string;
  last_at: string;
  status: FileStatus;
  /** Ordered list of prior names, oldest-first. E.g. ["old/a.ts", "b.ts"]. */
  rename_chain: string[];
}

// ---------------------------------------------------------------------------
// Ingest types
// ---------------------------------------------------------------------------

interface LifecycleRecord {
  path: string;
  first_sha: string;
  first_at: string;
  last_sha: string;
  last_at: string;
  status: FileStatus;
  rename_chain: string[];
}

interface IngestBody {
  workspaceId: string;
  repo: string;
  paths: LifecycleRecord[];
  done?: boolean;
}

// ---------------------------------------------------------------------------
// Date comparison helpers
// ---------------------------------------------------------------------------

/** Returns the earlier of two ISO-8601 date strings. */
function minIso(a: string, b: string): string {
  return a < b ? a : b;
}

/** Returns the later of two ISO-8601 date strings. */
function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

// ---------------------------------------------------------------------------
// PathRecord helpers
// ---------------------------------------------------------------------------

/**
 * Touch a path record with a new commit SHA + ISO date.
 * Keeps first_at = min, last_at = max across all sightings.
 */
function touchRecord(
  rec: PathRecord,
  sha: string,
  iso: string
): void {
  if (rec.first_at === "" || iso < rec.first_at) {
    rec.first_at = iso;
    rec.first_sha = sha;
  }
  if (rec.last_at === "" || iso > rec.last_at) {
    rec.last_at = iso;
    rec.last_sha = sha;
  }
}

/**
 * Apply a terminal-state update (extant/deleted) only when this commit is
 * the chronologically latest sighting for the path. Without this gate,
 * a newest-first walk would see a D commit set status='deleted', then later
 * see the original A commit and incorrectly flip it back to 'extant'.
 */
function setStatusIfNewest(
  rec: PathRecord,
  status: "extant" | "deleted",
  iso: string
): void {
  if (rec.last_at === "" || iso >= rec.last_at) {
    rec.status = status;
  }
}

// ---------------------------------------------------------------------------
// Core streaming parser
// ---------------------------------------------------------------------------

// git log format used:
//   --format=tformat:%x00COMMIT%x00%H%x00%cI
//   --diff-filter=ADR --name-status --all
//
// Output structure:
//   <NUL>COMMIT<NUL><sha><NUL><ISO>        ← commit header line (contains NUL bytes)
//   A\t<path>                               ← added file
//   D\t<path>                               ← deleted file
//   R<score>\t<from>\t<to>                  ← rename
//   C<score>\t<from>\t<to>                  ← copy (treated as fresh Add of <to>)
//   <blank line>                            ← separates commits in name-status output
//
// We stream stdout line-by-line. Lines containing NUL are commit headers (because
// tformat emits the NUL bytes literally and readline splits on \n, not \0).
// All other non-blank lines are name-status entries.
//
// Walk order: git log is newest-first by default. We use min/max comparisons on
// ISO dates so first_at = oldest and last_at = newest regardless of walk order.

async function buildPathMap(
  cwd: string
): Promise<Map<string, PathRecord>> {
  // Map keyed by current canonical path (after all renames).
  const pathMap = new Map<string, PathRecord>();

  const args = [
    "log",
    "--all",
    "--diff-filter=ADRC",
    "--name-status",
    `--format=tformat:|||COMMIT|||%H|||%cI`,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rl = createInterface({ input: child.stdout! });

    let currentSha = "";
    let currentIso = "";

    function getOrCreate(path: string): PathRecord {
      let rec = pathMap.get(path);
      if (!rec) {
        rec = {
          path,
          first_sha: "",
          first_at: "",
          last_sha: "",
          last_at: "",
          status: "extant",
          rename_chain: [],
        };
        pathMap.set(path, rec);
      }
      return rec;
    }

    rl.on("line", (rawLine: string) => {
      // Commit header line uses a printable triple-pipe sentinel because
      // child_process.spawn rejects null bytes in args.
      // Format: |||COMMIT|||<sha>|||<iso>
      // Split on "|||" yields: ["", "COMMIT", sha, iso]
      if (rawLine.startsWith("|||COMMIT|||")) {
        const parts = rawLine.split("|||");
        currentSha = parts[2] ?? "";
        currentIso = parts[3] ?? "";
        return;
      }

      if (currentSha === "") return; // before any commit header
      const trimmed = rawLine.trim();
      if (trimmed === "") return; // blank separator lines

      // Name-status line: either "<STATUS>\t<path>" or "<STATUS>\t<from>\t<to>"
      const tabIdx = trimmed.indexOf("\t");
      if (tabIdx === -1) return; // malformed; skip

      const statusField = trimmed.slice(0, tabIdx);
      const rest = trimmed.slice(tabIdx + 1);

      if (statusField === "A") {
        const rec = getOrCreate(rest);
        setStatusIfNewest(rec, "extant", currentIso);
        touchRecord(rec, currentSha, currentIso);
        return;
      }

      if (statusField === "D") {
        const rec = getOrCreate(rest);
        setStatusIfNewest(rec, "deleted", currentIso);
        touchRecord(rec, currentSha, currentIso);
        return;
      }

      if (statusField.startsWith("R")) {
        // Rename: R<score>\t<from>\t<to>
        const secondTab = rest.indexOf("\t");
        if (secondTab === -1) return; // malformed rename line

        const fromPath = rest.slice(0, secondTab);
        const toPath = rest.slice(secondTab + 1);

        // Retrieve (or create) the record previously living under fromPath.
        // If it already has a record, migrate it to toPath.
        const existing = pathMap.get(fromPath);

        if (existing) {
          existing.rename_chain.push(fromPath);
          existing.path = toPath;
          pathMap.delete(fromPath);
          pathMap.set(toPath, existing);
          setStatusIfNewest(existing, "extant", currentIso);
          touchRecord(existing, currentSha, currentIso);
        } else {
          const rec = getOrCreate(toPath);
          if (!rec.rename_chain.includes(fromPath)) {
            rec.rename_chain.push(fromPath);
          }
          setStatusIfNewest(rec, "extant", currentIso);
          touchRecord(rec, currentSha, currentIso);
        }
        return;
      }

      if (statusField.startsWith("C")) {
        // Copy creates a new independent file at <to>. Treat as Add of <to>.
        const secondTab = rest.indexOf("\t");
        if (secondTab === -1) return;
        const toPath = rest.slice(secondTab + 1);
        const rec = getOrCreate(toPath);
        setStatusIfNewest(rec, "extant", currentIso);
        touchRecord(rec, currentSha, currentIso);
        return;
      }

      // Other status codes (M, T, etc.) can appear if the diff-filter is broader;
      // we only requested ADRC so this shouldn't happen, but handle gracefully.
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`git log (file-lifecycle) exited with code ${code}`));
        return;
      }
      resolve(pathMap);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[almanac-file-lifecycle git stderr] ${chunk.toString()}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Ingest POST
// ---------------------------------------------------------------------------

async function postBatch(
  workspaceId: string,
  repo: string,
  paths: LifecycleRecord[],
  done: boolean
): Promise<void> {
  const body: IngestBody = { workspaceId, repo, paths };
  if (done) body.done = true;
  await apiFetch("/api/almanac/file-lifecycle/ingest", { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Job result
// ---------------------------------------------------------------------------

interface LifecycleResult {
  repo: string;
  paths_total: number;
  batches_sent: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const BATCH_SIZE = 1000;

export const almanacFileLifecycleExtractHandler: JobHandler = async (
  params: unknown
): Promise<LifecycleResult> => {
  const p = parseParams(params);

  // 1. Verify repoPath is a git repository
  if (!existsSync(`${p.repoPath}/.git`)) {
    throw new Error(
      `almanac.file-lifecycle.extract: '${p.repoPath}' is not a git repository (no .git directory)`
    );
  }

  // 2. Resolve branch (main → master fallback)
  // resolveBranch is used here to validate the preferred branch exists and
  // normalise the name; the git log command itself uses --all so it covers
  // all branches regardless, but we capture the preferred branch for context.
  const preferredBranch = p.branch ?? "main";
  await resolveBranch(p.repoPath, preferredBranch);

  // 3. Stream all paths from full git history and build the path map
  const pathMap = await buildPathMap(p.repoPath);

  // 4. Collect records and batch-POST to the server
  const records: LifecycleRecord[] = [];
  for (const rec of pathMap.values()) {
    // Guard: skip any record that never got a commit date (shouldn't happen)
    if (rec.first_sha === "" || rec.last_sha === "") continue;
    records.push({
      path: rec.path,
      first_sha: rec.first_sha,
      first_at: rec.first_at,
      last_sha: rec.last_sha,
      last_at: rec.last_at,
      status: rec.status,
      rename_chain: rec.rename_chain,
    });
  }

  const pathsTotal = records.length;
  let batchesSent = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const isLast = i + BATCH_SIZE >= records.length;
    await postBatch(p.workspaceId, p.repo, batch, isLast);
    batchesSent++;
  }

  // If there were no records at all, send a done marker so the server knows
  // the job completed cleanly.
  if (records.length === 0) {
    await postBatch(p.workspaceId, p.repo, [], true);
    batchesSent++;
  }

  return {
    repo: p.repo,
    paths_total: pathsTotal,
    batches_sent: batchesSent,
  };
};
