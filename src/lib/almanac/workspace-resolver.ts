/**
 * resolveAlmanacWorkspaceId
 *
 * Maps a projectKey to the workspaceId that owns it. In this app,
 * workspaceId === workspace_config.id (a short slug like 'default' or
 * 'acme-engineering'). The almanac_docs table stores the workspace_id
 * directly so the resolver is only needed at doc-creation time and for
 * access-control checks.
 *
 * Resolution order:
 *   1. Look for an almanac_docs row for this projectKey and return its
 *      workspace_id (fast path for existing docs).
 *   2. Look for an enabled workspace_config row that has the projectKey
 *      stored in its config JSON under `projectKeys[]` or as `id` (a
 *      workspace whose id === projectKey.toLowerCase()).
 *   3. Fall back to 'default'.
 *
 * TODO(phase-2): When a proper project→workspace mapping table is added,
 * replace steps 1-3 with a single FK lookup. For now this heuristic is
 * sufficient for single-workspace installs and is safe to call repeatedly
 * (no writes).
 */

import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export async function resolveAlmanacWorkspaceId(projectKey: string): Promise<string> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // Fast path: an existing doc already recorded which workspace this project lives in.
  const existingDoc = await db
    .prepare(
      `SELECT workspace_id FROM almanac_docs WHERE project_key = ? LIMIT 1`,
    )
    .get<{ workspace_id: string }>(projectKey.toUpperCase());

  if (existingDoc) return existingDoc.workspace_id;

  // Check workspace_config rows for a workspace whose id matches
  // projectKey (case-insensitive slug).
  const slug = projectKey.toLowerCase();
  const directHit = await db
    .prepare(
      `SELECT id FROM workspace_config WHERE id = ? AND enabled = 1 LIMIT 1`,
    )
    .get<{ id: string }>(slug);

  if (directHit) return directHit.id;

  // No direct match: use the same heuristic as agent pair/confirm — the
  // first enabled workspace_config row alphabetically. This keeps doc
  // creation and agent pairing on the same workspace_id, which is what
  // the agent poll endpoint filters by.
  const firstEnabled = await db
    .prepare(
      `SELECT id FROM workspace_config WHERE enabled = 1 ORDER BY id ASC LIMIT 1`,
    )
    .get<{ id: string }>();

  return firstEnabled?.id ?? 'default';
}
