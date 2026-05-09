/**
 * Resolves the agent's config / data directory.
 *
 * Default: `~/.workgraph` (backwards compatible).
 *
 * Override with the `WORKGRAPH_CONFIG_DIR` env var — useful when running
 * the local dev agent alongside a globally-installed `@workgraph/agent`
 * so the two don't clash on credentials, repo mappings, or auto-managed
 * clones. Example:
 *
 *     WORKGRAPH_CONFIG_DIR=~/.workgraph-dev npm run dev
 *
 * The path is expanded for a leading `~` and resolved relative to the
 * user's home directory.
 */

import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

export function configDir(): string {
  const override = process.env.WORKGRAPH_CONFIG_DIR?.trim();
  if (override) return expandHome(override);
  return join(homedir(), '.workgraph');
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (isAbsolute(p)) return p;
  return p;
}
