/**
 * repo subcommand — manages local repo path mappings in ~/.workgraph/repos.json.
 *
 * Subcommands:
 *   workgraph repo add <owner/name> <path>   Map a local repo (skips auto-clone)
 *   workgraph repo list                       Show all known repos
 *   workgraph repo remove <owner/name>        Remove a repo mapping
 */
import { access, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { addRepo, removeRepo, listRepos, validateRepoKey } from '../workspace.js';

export async function repoCommand(subArgv: string[]): Promise<void> {
  const sub = subArgv[0];

  switch (sub) {
    case 'add':
      await handleAdd(subArgv.slice(1));
      break;
    case 'list':
      await handleList();
      break;
    case 'remove':
      await handleRemove(subArgv.slice(1));
      break;
    default: {
      const detail = sub ? `Unknown subcommand: ${sub}\n\n` : '';
      console.error(
        `${detail}Usage: workgraph repo <subcommand>\n\n` +
          `Subcommands:\n` +
          `  add <owner/name> <path>   Map a local repo path (skips auto-clone)\n` +
          `  list                      Show all known repos\n` +
          `  remove <owner/name>       Remove a repo mapping\n`,
      );
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

async function handleAdd(args: string[]): Promise<void> {
  if (args.length < 2) {
    console.error('Usage: workgraph repo add <owner/name> <path>');
    process.exit(1);
  }

  const [repoKey, rawPath] = args;
  const absPath = resolve(rawPath);

  // Validate shape first (throws with a human-readable message).
  try {
    validateRepoKey(repoKey);
  } catch (err: unknown) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  // Validate the path exists and is a directory.
  try {
    const s = await stat(absPath);
    if (!s.isDirectory()) {
      console.error(`Error: "${absPath}" is not a directory.`);
      process.exit(1);
    }
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      console.error(`Error: Path does not exist: "${absPath}"`);
    } else {
      console.error(`Error: Cannot access "${absPath}": ${(err as Error).message}`);
    }
    process.exit(1);
  }

  // Validate it is a git repo (.git exists).
  const gitDir = join(absPath, '.git');
  try {
    await access(gitDir, constants.F_OK);
  } catch {
    console.error(
      `Error: "${absPath}" does not appear to be a git repository (no .git found).`,
    );
    process.exit(1);
  }

  try {
    await addRepo(repoKey, absPath);
  } catch (err: unknown) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`Added repo mapping: ${repoKey} → ${absPath}`);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function handleList(): Promise<void> {
  let repos;
  try {
    repos = await listRepos();
  } catch (err: unknown) {
    console.error(`Error listing repos: ${(err as Error).message}`);
    process.exit(1);
  }

  if (repos.length === 0) {
    console.log(
      'No repos configured.\n\n' +
        'To add a local repo mapping:\n' +
        '  workgraph repo add <owner/name> /path/to/clone\n\n' +
        'Without a mapping, the agent will auto-clone repos under ~/.workgraph/workspaces/ as needed.',
    );
    return;
  }

  // Two-column table: KEY  PATH  SOURCE
  const header = ['KEY', 'PATH', 'SOURCE'];
  const rows = repos.map((r) => [r.repoKey, r.path, r.source]);

  // Calculate column widths.
  const colWidths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  const fmt = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(colWidths[i])).join('  ');

  console.log(fmt(header));
  console.log(colWidths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(fmt(row));
  }
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

async function handleRemove(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: workgraph repo remove <owner/name>');
    process.exit(1);
  }

  const [repoKey] = args;

  try {
    validateRepoKey(repoKey);
  } catch (err: unknown) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  try {
    await removeRepo(repoKey);
  } catch (err: unknown) {
    const msg = (err as Error).message;
    if (msg.includes('is not in the repo map')) {
      console.error(`Error: Repo "${repoKey}" is not in the repo map. Nothing to remove.`);
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  console.log(`Removed repo mapping: ${repoKey}`);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
