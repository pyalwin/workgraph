import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, basename } from "node:path";

/**
 * Resolve the absolute path to a local clone of `<owner>/<name>`.
 *
 * Resolution order:
 *   1. Explicit `paramRepoPath` from the job params, if a non-empty string
 *      that points at a real directory.
 *   2. `$WORKGRAPH_REPO_DIR/<name>` — the user can set this once in their
 *      shell (e.g. `export WORKGRAPH_REPO_DIR=$HOME/code`) and every repo
 *      under it gets picked up.
 *   3. `$HOME/code/<name>` — the v1 convention.
 *   4. The current working directory if its basename matches `<name>`.
 *
 * Throws a friendly error if none of these exist as a git repo.
 */
export function resolveRepoPath(repo: string, paramRepoPath?: unknown): string {
  const name = basename(repo); // "owner/name" → "name"

  const candidates: string[] = [];
  if (typeof paramRepoPath === "string" && paramRepoPath.trim()) {
    candidates.push(resolve(paramRepoPath.trim()));
  }
  const envDir = process.env["WORKGRAPH_REPO_DIR"]?.trim();
  if (envDir) candidates.push(resolve(envDir, name));
  candidates.push(resolve(homedir(), "code", name));
  // CWD fallback — useful when running the agent from inside a checkout
  const cwd = process.cwd();
  if (basename(cwd) === name) candidates.push(cwd);

  for (const p of candidates) {
    if (existsSync(`${p}/.git`)) return p;
  }

  throw new Error(
    `Could not locate a local clone of '${repo}'. Tried:\n` +
      candidates.map((c) => `  - ${c}`).join("\n") +
      `\n\nFix one of:\n` +
      `  • clone the repo to ~/code/${name}, or\n` +
      `  • set WORKGRAPH_REPO_DIR=<parent-dir> and ensure ${name}/ exists under it, or\n` +
      `  • re-run the agent with --repo-path / pass repoPath in the job params.`,
  );
}
