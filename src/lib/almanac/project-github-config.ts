/**
 * GitHub repo discovery for workspace-level connectors.
 *
 * Project↔GitHub-repo bindings now live in the unified `project_connectors`
 * table; see `src/lib/project-connectors.ts`. The list/upsert helpers that
 * used to live here have been removed — callers should attach via
 * `attachProjectConnector({ kind: 'github', ... })`.
 */

/**
 * Available GitHub repos that the workspace's GitHub connector knows about.
 *
 * The GitHub connector that would populate this isn't part of the current
 * almanac/agent slice, so this returns an empty list for now. The route uses
 * it to populate a dropdown — when empty, the UI falls back to a free-text
 * input. Replace with a real connector lookup when the connector lands.
 */
export async function listGithubReposForWorkspace(_workspaceId: string): Promise<string[]> {
  return [];
}
