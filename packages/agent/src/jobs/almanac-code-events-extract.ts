import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { apiFetch } from "../client.js";
import { resolveRepoPath } from "../lib/resolve-repo-path.js";
import type { JobHandler } from "./noop.js";

// ---------------------------------------------------------------------------
// DIFF_SKIP_PATTERNS — verbatim copy from src/lib/sync/github-trails.ts
// (packages/agent is a standalone npm package; no runtime deps on the main repo)
// ---------------------------------------------------------------------------
const DIFF_SKIP_PATTERNS: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)bun\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.sum$/,
  /\.svg$/i,
  /\.png$/i,
  /\.jpg$/i,
  /\.jpeg$/i,
  /\.gif$/i,
  /\.ico$/i,
  /\.pdf$/i,
  /\.min\.(js|css)$/i,
  /\.snap$/i,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)node_modules\//,
  /\.generated\.(ts|js|tsx|jsx|py|go)$/i,
];

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface ExtractParams {
  workspaceId: string;
  repo: string;       // "owner/name"
  repoPath: string;   // absolute path to local clone
  sinceIso?: string;  // optional ISO-8601 cursor (exclusive)
  branch?: string;    // default "main", fallback "master"
}

function assertString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`almanac.code-events.extract: param '${name}' must be a non-empty string`);
  }
  return v;
}

function parseParams(params: unknown): ExtractParams {
  if (typeof params !== "object" || params === null) {
    throw new Error("almanac.code-events.extract: params must be an object");
  }
  const p = params as Record<string, unknown>;
  const repo = assertString(p["repo"], "repo");
  const result: ExtractParams = {
    workspaceId: assertString(p["workspaceId"], "workspaceId"),
    repo,
    // repoPath is locally resolved on the agent — server can't know where
    // your laptop has the clone. Falls back to $WORKGRAPH_REPO_DIR/<name>
    // or ~/code/<name> if the param isn't passed.
    repoPath: resolveRepoPath(repo, p["repoPath"]),
  };
  if (p["sinceIso"] !== undefined) {
    result.sinceIso = assertString(p["sinceIso"], "sinceIso");
  }
  if (p["branch"] !== undefined) {
    result.branch = assertString(p["branch"], "branch");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

type Convention = "merge" | "squash" | "unknown";

/** Runs a git command synchronously via spawn, collects stdout as a string. */
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
  // Try listing remote-tracking refs to confirm
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
    // Try master as fallback
    try {
      const lines = await gitLines(cwd, ["branch", "--list", "master"]);
      if (lines.some((l) => l.trim().replace(/^\*\s*/, "") === "master")) {
        return "master";
      }
      // check remote
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

  // Default: return whatever was passed; git will error at log time if invalid
  return preferred;
}

async function detectConvention(cwd: string, branch: string): Promise<Convention> {
  // Check for GitHub merge-commit style
  try {
    const mergeLines = await gitLines(cwd, [
      "log",
      "--merges",
      "--first-parent",
      "--max-count=10",
      "--pretty=format:%s",
      branch,
    ]);
    if (mergeLines.some((s) => /Merge pull request #\d+/.test(s))) {
      return "merge";
    }
  } catch {
    // ignore — may be an empty repo or no merges
  }

  // Check for squash-merge style  "(#NNN)" at end of subject
  try {
    const squashLines = await gitLines(cwd, [
      "log",
      "--first-parent",
      "--max-count=20",
      "--pretty=format:%s",
      branch,
    ]);
    if (squashLines.some((s) => /\(#\d+\)\s*$/.test(s))) {
      return "squash";
    }
  } catch {
    // ignore
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Parsed commit event
// ---------------------------------------------------------------------------

interface CodeEvent {
  id: string;
  workspace_id: string;
  repo: string;
  sha: string;
  pr_number: number | null;
  kind: "pr_merged" | "direct_commit";
  author_login: string | null;
  author_email: string | null;
  occurred_at: string;
  message: string;
  files_touched: string[];
  additions: number;
  deletions: number;
}

// ---------------------------------------------------------------------------
// Streaming git log parser
// ---------------------------------------------------------------------------

// Commit record format (one per commit):
//   <<<COMMIT>>><sha>\t<aI: author ISO date>\t<aL: author login/mailmap>\t<aE: author email>\t<s: subject>\t<b: body>
// Then git appends --shortstat and --name-only lines after the body.
// We use the <<<COMMIT>>> sentinel as the boundary between commits.
//
// NOTE: We use --pretty=format (no trailing newline per commit) combined with
//       --shortstat --name-only. Git emits the format string, then a blank
//       line, then the stats/names. The sentinel prefix makes boundaries clear.

const COMMIT_SENTINEL = "<<<COMMIT>>>";

interface RawCommit {
  sha: string;
  authorIso: string;
  authorLogin: string;
  authorEmail: string;
  subject: string;
  body: string;
  files: string[];
  additions: number;
  deletions: number;
}

function parseShortstat(line: string): { additions: number; deletions: number } {
  // e.g. " 3 files changed, 42 insertions(+), 7 deletions(-)"
  //      " 1 file changed, 1 insertion(+)"
  const ins = line.match(/(\d+) insertion/);
  const del = line.match(/(\d+) deletion/);
  return {
    additions: ins ? parseInt(ins[1]!, 10) : 0,
    deletions: del ? parseInt(del[1]!, 10) : 0,
  };
}

function buildEvent(
  raw: RawCommit,
  workspaceId: string,
  repo: string,
  convention: Convention
): CodeEvent {
  const { sha, authorIso, authorLogin, authorEmail, subject, files, additions, deletions } =
    raw;

  // Deterministic ID: sha1 of "owner/name:sha"
  const id = createHash("sha1").update(`${repo}:${sha}`).digest("hex");

  let prNumber: number | null = null;
  let kind: "pr_merged" | "direct_commit" = "direct_commit";

  const mergeMatch = subject.match(/Merge pull request #(\d+)/);
  if (mergeMatch) {
    prNumber = parseInt(mergeMatch[1]!, 10);
    kind = "pr_merged";
  } else if (convention === "squash") {
    const squashMatch = subject.match(/\(#(\d+)\)\s*$/);
    if (squashMatch) {
      prNumber = parseInt(squashMatch[1]!, 10);
      kind = "pr_merged";
    }
  }

  const filteredFiles = files.filter(
    (f) => !DIFF_SKIP_PATTERNS.some((re) => re.test(f))
  );

  return {
    id,
    workspace_id: workspaceId,
    repo,
    sha,
    pr_number: prNumber,
    kind,
    author_login: authorLogin.trim() !== "" ? authorLogin.trim() : null,
    author_email: authorEmail.trim() !== "" ? authorEmail.trim() : null,
    occurred_at: authorIso,
    message: subject,
    files_touched: filteredFiles,
    additions,
    deletions,
  };
}

// ---------------------------------------------------------------------------
// Streaming git log + parse
// ---------------------------------------------------------------------------

// State machine for parsing the interleaved git log output.
// git log with --shortstat --name-only emits:
//
//   <<<COMMIT>>><fields>
//   [optional multi-line body continues here]
//   <blank line>
//    N files changed, X insertions(+), Y deletions(-)
//   <blank line>
//   filename1
//   filename2
//   ...
//   <blank line>
//   <<<COMMIT>>> (next commit)
//
// When body exists it appears before the stats. The sentinel line starts a
// new record so any accumulated file/stat data for the prior record can be
// finalised.

type ParseState = "body" | "stat" | "files";

interface MutableCommit {
  sha: string;
  authorIso: string;
  authorLogin: string;
  authorEmail: string;
  subject: string;
  body: string;
  files: string[];
  additions: number;
  deletions: number;
  state: ParseState;
  seenStat: boolean;
}

function startCommit(headerLine: string): MutableCommit {
  // Strip sentinel prefix
  const payload = headerLine.slice(COMMIT_SENTINEL.length);
  const parts = payload.split("\t");
  // parts: [sha, authorIso, authorLogin, authorEmail, subject, ...body-remainder]
  const sha = parts[0] ?? "";
  const authorIso = parts[1] ?? "";
  const authorLogin = parts[2] ?? "";
  const authorEmail = parts[3] ?? "";
  const subject = parts[4] ?? "";
  // Body may be present as remaining tab-joined content on the first line,
  // though typically it's empty here (git puts it on subsequent lines).
  const bodyStart = parts.slice(5).join("\t");

  return {
    sha,
    authorIso,
    authorLogin,
    authorEmail,
    subject,
    body: bodyStart,
    files: [],
    additions: 0,
    deletions: 0,
    state: "body",
    seenStat: false,
  };
}

async function streamCommits(
  cwd: string,
  branch: string,
  sinceIso: string | undefined,
  workspaceId: string,
  repo: string,
  convention: Convention,
  onBatch: (events: CodeEvent[]) => Promise<void>,
  batchSize: number
): Promise<{ totalEvents: number; lastSha: string; lastOccurredAt: string }> {
  const args = [
    "log",
    "--first-parent",
    branch,
    // tab-separated fields; sentinel prefix makes boundary detection reliable
    `--pretty=format:${COMMIT_SENTINEL}%H\t%aI\t%aL\t%aE\t%s\t%b`,
    // --numstat gives per-file `add\tdel\tpath` lines. We previously tried
    // --shortstat --name-only together but git only honors one — name-only
    // wins, so files_touched filled but additions/deletions stayed 0. With
    // --numstat we get both: parser sums adds/dels and collects filenames.
    "--numstat",
  ];

  if (sinceIso) {
    args.push(`--since=${sinceIso}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rl = createInterface({ input: child.stdout! });

    let current: MutableCommit | null = null;
    const batch: CodeEvent[] = [];
    let totalEvents = 0;
    let lastSha = "";
    let lastOccurredAt = "";
    let pendingBatch: Promise<void> = Promise.resolve();

    function finalise(commit: MutableCommit): void {
      const event = buildEvent(commit, workspaceId, repo, convention);
      batch.push(event);
      totalEvents++;
      if (!lastSha) {
        // First commit processed = most recent (git log is newest-first)
        lastSha = commit.sha;
        lastOccurredAt = commit.authorIso;
      }
      if (batch.length >= batchSize) {
        const toSend = batch.splice(0, batch.length);
        // Chain batch sends so they stay ordered and errors surface
        pendingBatch = pendingBatch.then(() => onBatch(toSend));
      }
    }

    rl.on("line", (rawLine: string) => {
      // New commit sentinel
      if (rawLine.startsWith(COMMIT_SENTINEL)) {
        if (current !== null) {
          finalise(current);
        }
        current = startCommit(rawLine);
        return;
      }

      if (current === null) {
        // Lines before the first sentinel (shouldn't happen, but be safe)
        return;
      }

      const trimmed = rawLine.trim();

      // numstat lines look like: "<add>\t<del>\t<path>" or "-\t-\t<path>" (binary).
      // They have exactly two tabs and a non-empty path component.
      const numstatMatch = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(rawLine);
      if (numstatMatch) {
        const adds = numstatMatch[1] === "-" ? 0 : parseInt(numstatMatch[1]!, 10);
        const dels = numstatMatch[2] === "-" ? 0 : parseInt(numstatMatch[2]!, 10);
        const filePath = numstatMatch[3]!;
        current.additions += adds;
        current.deletions += dels;
        current.files.push(filePath);
        // First numstat line implicitly closes the body — body text never
        // starts with a number followed by tab.
        return;
      }

      if (trimmed === "") return;

      // Anything else while we haven't seen numstat yet is body text.
      // (A numstat line for a file with literal tab-numbers in the body
      // is essentially impossible because git wraps body text and
      // wouldn't emit `<num>\t<num>\t<text>`.)
      current.body += (current.body ? "\n" : "") + rawLine;
    });

    rl.on("close", () => {
      // Finalise last commit
      if (current !== null) {
        finalise(current);
      }
      // Flush remaining partial batch
      if (batch.length > 0) {
        const toSend = batch.splice(0, batch.length);
        pendingBatch = pendingBatch.then(() => onBatch(toSend));
      }
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`git log exited with code ${code}`));
        return;
      }
      // Wait for all pending batch sends before resolving
      pendingBatch
        .then(() => resolve({ totalEvents, lastSha, lastOccurredAt }))
        .catch(reject);
    });

    // Surface stderr for debugging without blocking
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[almanac-extract git stderr] ${chunk.toString()}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Ingest POST
// ---------------------------------------------------------------------------

interface IngestBody {
  workspaceId: string;
  repo: string;
  events: CodeEvent[];
  cursor?: { last_sha: string; last_occurred_at: string };
  done?: boolean;
}

async function postBatch(
  workspaceId: string,
  repo: string,
  events: CodeEvent[],
  cursor: { last_sha: string; last_occurred_at: string } | undefined,
  done: boolean
): Promise<void> {
  const body: IngestBody = { workspaceId, repo, events };
  if (cursor) body.cursor = cursor;
  if (done) body.done = true;
  // apiFetch throws on non-2xx; no retry here — Inngest requeues the job
  await apiFetch("/api/almanac/code-events/ingest", { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Job result
// ---------------------------------------------------------------------------

interface ExtractResult {
  repo: string;
  total_events: number;
  batches_sent: number;
  convention: Convention;
  last_sha: string;
  last_occurred_at: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const BATCH_SIZE = 1000;

export const almanacCodeEventsExtractHandler: JobHandler = async (
  params: unknown
): Promise<ExtractResult> => {
  const p = parseParams(params);

  // 1. Verify repoPath is a git repository
  if (!existsSync(`${p.repoPath}/.git`)) {
    throw new Error(
      `almanac.code-events.extract: '${p.repoPath}' is not a git repository (no .git directory)`
    );
  }

  // 2. Resolve branch
  const preferredBranch = p.branch ?? "main";
  const branch = await resolveBranch(p.repoPath, preferredBranch);

  // 3. Detect merge convention
  const convention = await detectConvention(p.repoPath, branch);

  // 4. Stream, parse, batch-POST
  let batchesSent = 0;
  // cursor tracks the last successfully sent batch's tip (git is newest-first,
  // so we capture the first event we ever see as the overall last_sha/last_occurred_at
  // for the cursor to return to the caller; per-batch cursor points to each batch's last item)
  let overallLastSha = "";
  let overallLastOccurredAt = "";
  let firstBatch = true;

  const onBatch = async (events: CodeEvent[]): Promise<void> => {
    // Build cursor from the last event in this batch
    // (git log is newest-first; batches are emitted in that order)
    const last = events[events.length - 1]!;
    const cursor: { last_sha: string; last_occurred_at: string } = {
      last_sha: last.sha,
      last_occurred_at: last.occurred_at,
    };

    // done=false on streaming batches; we send a final done=true marker after
    // streamCommits resolves so the server can flip backfill_state.last_status to 'ok'.
    await postBatch(p.workspaceId, p.repo, events, cursor, false);
    batchesSent++;

    // Track the very first event overall (= most recent commit in the repo)
    if (firstBatch) {
      firstBatch = false;
      overallLastSha = events[0]!.sha;
      overallLastOccurredAt = events[0]!.occurred_at;
    }
  };

  const { totalEvents, lastSha, lastOccurredAt } = await streamCommits(
    p.repoPath,
    branch,
    p.sinceIso,
    p.workspaceId,
    p.repo,
    convention,
    onBatch,
    BATCH_SIZE
  );

  // For empty repos totalEvents = 0; streamCommits returns empty strings
  if (totalEvents > 0 && overallLastSha === "") {
    // onBatch wasn't called (shouldn't reach here, but guard)
    overallLastSha = lastSha;
    overallLastOccurredAt = lastOccurredAt;
  }

  // Final completion marker — empty events, done:true. Tells the server to
  // flip code_events_backfill_state.last_status from 'partial' to 'ok'.
  if (batchesSent > 0) {
    await postBatch(p.workspaceId, p.repo, [], undefined, true);
  }

  return {
    repo: p.repo,
    total_events: totalEvents,
    batches_sent: batchesSent,
    convention,
    last_sha: overallLastSha || lastSha,
    last_occurred_at: overallLastOccurredAt || lastOccurredAt,
  };
};
