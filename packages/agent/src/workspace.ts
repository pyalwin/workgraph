/**
 * workspace.ts — Workspace resolver for the Workgraph local agent.
 *
 * Manages ~/.workgraph/repos.json (user-mapped repos) and
 * ~/.workgraph/workspaces/<owner>/<name>/ (auto-managed clones).
 *
 * Key design decisions:
 *   - ZERO runtime deps. Node built-ins only (fs/promises, path, os, child_process).
 *   - git operations use spawn() — never exec — to avoid shell injection.
 *   - Per-repo in-process lock serialises concurrent resolveWorkspace() calls for
 *     the same repoKey. Different repoKeys resolve in parallel.
 *     NOTE: This lock is in-process only. Multiple agent processes running on the
 *     same machine could race; that scenario is out of scope for v1.
 *   - Auto-managed clone dirs get a `.workgraph-managed` marker file at clone time
 *     so future cleanup code can distinguish them from user paths.
 *   - User-mapped paths are never mutated if the working tree is dirty.
 */

import { readFile, writeFile, mkdir, stat, access, rename, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = join(homedir(), '.workgraph');
const REPOS_JSON = join(DATA_DIR, 'repos.json');
const WORKSPACES_DIR = join(DATA_DIR, 'workspaces');
const MANAGED_MARKER = '.workgraph-managed';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates that repoKey is exactly <owner>/<name> —
 * one slash, no spaces, no dotdot, non-empty segments.
 */
export function validateRepoKey(repoKey: string): void {
  if (!repoKey || typeof repoKey !== 'string') {
    throw new Error(`Invalid repoKey: must be a non-empty string, got: ${JSON.stringify(repoKey)}`);
  }
  const parts = repoKey.split('/');
  if (parts.length !== 2) {
    throw new Error(
      `Invalid repoKey "${repoKey}": must be exactly <owner>/<name> (one slash).`,
    );
  }
  const [owner, name] = parts;
  if (!owner || !name) {
    throw new Error(
      `Invalid repoKey "${repoKey}": owner and name must be non-empty.`,
    );
  }
  if (/\s/.test(repoKey)) {
    throw new Error(`Invalid repoKey "${repoKey}": must not contain whitespace.`);
  }
  if (owner === '..' || name === '..' || owner.includes('..') || name.includes('..')) {
    throw new Error(`Invalid repoKey "${repoKey}": must not contain path-traversal segments.`);
  }
}

// ---------------------------------------------------------------------------
// Repo map (repos.json)
// ---------------------------------------------------------------------------

export async function readRepoMap(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(REPOS_JSON, 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * Atomically writes the repo map via a temp file + rename.
 * Permissions 0644 (world-readable, user-writable).
 */
export async function writeRepoMap(map: Record<string, string>): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = join(tmpdir(), `repos-${randomBytes(6).toString('hex')}.json`);
  await writeFile(tmp, JSON.stringify(map, null, 2), { encoding: 'utf8', mode: 0o644 });
  await rename(tmp, REPOS_JSON);
}

export async function addRepo(repoKey: string, path: string): Promise<void> {
  validateRepoKey(repoKey);
  const map = await readRepoMap();
  map[repoKey] = path;
  await writeRepoMap(map);
}

export async function removeRepo(repoKey: string): Promise<void> {
  validateRepoKey(repoKey);
  const map = await readRepoMap();
  if (!(repoKey in map)) {
    throw new Error(`Repo "${repoKey}" is not in the repo map.`);
  }
  delete map[repoKey];
  await writeRepoMap(map);
}

// ---------------------------------------------------------------------------
// List repos
// ---------------------------------------------------------------------------

export interface RepoEntry {
  repoKey: string;
  path: string;
  source: 'mapped' | 'managed';
}

/**
 * Returns all known repos: user-mapped ones (from repos.json) plus any
 * auto-managed clones discovered under ~/.workgraph/workspaces/.
 * Mapped entries take precedence — if a repoKey exists in both, only the
 * mapped entry is returned.
 */
export async function listRepos(): Promise<RepoEntry[]> {
  const map = await readRepoMap();
  const results: RepoEntry[] = [];

  // Collect managed clones first.
  const managedEntries = new Map<string, string>();
  try {
    const owners = await readdir(WORKSPACES_DIR);
    for (const owner of owners) {
      const ownerDir = join(WORKSPACES_DIR, owner);
      let names: string[];
      try {
        names = await readdir(ownerDir);
      } catch {
        continue;
      }
      for (const name of names) {
        const wsPath = join(ownerDir, name);
        // Only include dirs that have the managed marker.
        const marker = join(wsPath, MANAGED_MARKER);
        try {
          await access(marker, constants.F_OK);
          managedEntries.set(`${owner}/${name}`, wsPath);
        } catch {
          // No marker — skip.
        }
      }
    }
  } catch (err: unknown) {
    // If workspaces dir doesn't exist yet, that's fine.
    if (!isNodeError(err) || err.code !== 'ENOENT') throw err;
  }

  // Merge: mapped entries override managed ones.
  const seen = new Set<string>();
  for (const [repoKey, repoPath] of Object.entries(map)) {
    results.push({ repoKey, path: repoPath, source: 'mapped' });
    seen.add(repoKey);
  }
  for (const [repoKey, repoPath] of managedEntries) {
    if (!seen.has(repoKey)) {
      results.push({ repoKey, path: repoPath, source: 'managed' });
    }
  }

  results.sort((a, b) => a.repoKey.localeCompare(b.repoKey));
  return results;
}

// ---------------------------------------------------------------------------
// Per-repo in-process lock (single-flight)
// ---------------------------------------------------------------------------

/**
 * Module-level lock map: repoKey → Promise of the in-flight resolution.
 *
 * Purpose: if two concurrent jobs target the same repo, the second waits for
 * the first's clone+fetch+checkout to finish before it begins its own. This
 * avoids race conditions on the git index.
 *
 * Scope: in-process only. Running two agent processes on the same machine can
 * still race — solving that would require a filesystem-level lock (e.g. a
 * .lock file), which is out of scope for v1.
 */
const repoLocks = new Map<string, Promise<{ path: string; sha: string }>>();

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Spawner type — injectable for tests.
 */
export type Spawner = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Default spawner using child_process.spawn.
 * Throws with command + stderr on non-zero exit or signal kill.
 * Honours AbortSignal: kills the child when the signal fires.
 */
export const defaultSpawner: Spawner = (cmd, args, { cwd, signal }) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const onAbort = () => {
      child.kill('SIGTERM');
      reject(new Error(`Aborted: ${cmd} ${args.join(' ')}`));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `Command failed (exit ${code}): ${cmd} ${args.join(' ')}\n${stderr.trim()}`,
          ),
        );
      }
    });

    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new Error(`Spawn error for ${cmd}: ${err.message}`));
    });
  });

// ---------------------------------------------------------------------------
// resolveWorkspace
// ---------------------------------------------------------------------------

export interface ResolveOpts {
  repoKey: string;
  ref: string;
  signal?: AbortSignal;
  /** Injectable for testing. Defaults to defaultSpawner. */
  _spawner?: Spawner;
}

/**
 * Resolves the local workspace for a given repoKey + ref.
 *
 * Flow (spec §4):
 *   1. Look up repoKey in repos.json. If found → use that path (user-mapped).
 *   2. Else → target ~/.workgraph/workspaces/<owner>/<name>.
 *      If missing → git clone https://github.com/<repoKey>.git into it.
 *   3. If user-mapped AND working tree is dirty → throw (don't clobber WIP).
 *   4. git fetch origin <ref>, git checkout <ref>.
 *   5. Return { path, sha } where sha = git rev-parse HEAD.
 *
 * Concurrency: per-repo lock (single-flight). Parallel for different repoKeys.
 */
export async function resolveWorkspace(opts: ResolveOpts): Promise<{ path: string; sha: string }> {
  const { repoKey, ref, signal } = opts;
  const spawner = opts._spawner ?? defaultSpawner;

  validateRepoKey(repoKey);

  // Single-flight: wait for any in-flight resolution of the same repo.
  const existing = repoLocks.get(repoKey);
  if (existing) {
    return existing;
  }

  const promise = _resolveWorkspaceInner(repoKey, ref, signal, spawner);
  repoLocks.set(repoKey, promise);

  try {
    const result = await promise;
    return result;
  } finally {
    // Remove the lock once settled so future calls can re-resolve freely.
    repoLocks.delete(repoKey);
  }
}

async function _resolveWorkspaceInner(
  repoKey: string,
  ref: string,
  signal: AbortSignal | undefined,
  spawner: Spawner,
): Promise<{ path: string; sha: string }> {
  const map = await readRepoMap();
  const isUserMapped = repoKey in map;

  let repoPath: string;

  if (isUserMapped) {
    repoPath = map[repoKey];
  } else {
    const [owner, name] = repoKey.split('/');
    repoPath = join(WORKSPACES_DIR, owner, name);

    // Clone if the directory doesn't exist yet.
    const exists = await directoryExists(repoPath);
    if (!exists) {
      await mkdir(dirname(repoPath), { recursive: true });
      await spawner('git', ['clone', `https://github.com/${repoKey}.git`, repoPath], { signal });
      // Write the managed marker so cleanup code can identify this dir.
      await writeFile(join(repoPath, MANAGED_MARKER), '', 'utf8');
    }
  }

  // Dirty-tree guard: only applies to user-mapped paths.
  if (isUserMapped) {
    const { stdout: statusOut } = await spawner('git', ['status', '--porcelain'], {
      cwd: repoPath,
      signal,
    });
    if (statusOut.trim().length > 0) {
      throw new Error(
        `Refusing to checkout "${ref}" in user-mapped repo "${repoKey}" at "${repoPath}": ` +
          `working tree has uncommitted changes. Commit or stash your work first.\n` +
          `Dirty files:\n${statusOut.trim()}`,
      );
    }
  }

  // Fetch + checkout.
  await spawner('git', ['fetch', 'origin', ref], { cwd: repoPath, signal });
  await spawner('git', ['checkout', ref], { cwd: repoPath, signal });

  // Resolve the actual SHA.
  const { stdout: shaOut } = await spawner('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath,
    signal,
  });
  const sha = shaOut.trim();

  return { path: repoPath, sha };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function directoryExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
