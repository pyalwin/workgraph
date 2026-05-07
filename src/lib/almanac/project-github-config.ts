/**
 * Project ↔ GitHub repo mapping. Used by /api/projects/[key]/github-config to
 * let a user pin one or more GitHub repos to a project (so almanac jobs and
 * other repo-aware features know where to look).
 */

import { randomUUID } from 'crypto';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export interface ProjectGithubConfig {
  id: string;
  workspaceId: string;
  projectKey: string;
  repo: string;
  defaultBranch: string;
  pathPrefixes: string[];
  ticketPrefixes: string[];
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

interface ConfigRow {
  id: string;
  workspace_id: string;
  project_key: string;
  repo: string;
  default_branch: string;
  path_prefixes: string;
  ticket_prefixes: string;
  enabled: number;
  created_at: string | null;
  updated_at: string | null;
}

function rowToConfig(row: ConfigRow): ProjectGithubConfig {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectKey: row.project_key,
    repo: row.repo,
    defaultBranch: row.default_branch,
    pathPrefixes: parseJsonArray(row.path_prefixes),
    ticketPrefixes: parseJsonArray(row.ticket_prefixes),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export async function listProjectGithubConfigs(
  workspaceId: string,
  projectKey: string,
): Promise<ProjectGithubConfig[]> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const rows = await db
    .prepare(
      `SELECT * FROM project_github_configs
       WHERE workspace_id = ? AND project_key = ?
       ORDER BY enabled DESC, repo ASC`,
    )
    .all<ConfigRow>(workspaceId, projectKey.toUpperCase());
  return rows.map(rowToConfig);
}

export interface UpsertInput {
  workspaceId: string;
  projectKey: string;
  repo: string;
  defaultBranch?: string;
  pathPrefixes?: string[];
  ticketPrefixes?: string[];
  enabled?: boolean;
}

export async function upsertProjectGithubConfig(input: UpsertInput): Promise<ProjectGithubConfig> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const projectKey = input.projectKey.toUpperCase();
  const repo = input.repo.trim();
  if (!/^[^\s\/]+\/[^\s\/]+$/.test(repo)) {
    throw new Error(`repo must be in 'owner/name' shape (got: ${input.repo})`);
  }

  const existing = await db
    .prepare(
      `SELECT id FROM project_github_configs
       WHERE workspace_id = ? AND project_key = ? AND repo = ?`,
    )
    .get<{ id: string }>(input.workspaceId, projectKey, repo);

  const defaultBranch = input.defaultBranch?.trim() || 'main';
  const pathPrefixes = JSON.stringify(input.pathPrefixes ?? []);
  const ticketPrefixes = JSON.stringify(input.ticketPrefixes ?? []);
  const enabled = input.enabled === false ? 0 : 1;

  if (existing) {
    await db
      .prepare(
        `UPDATE project_github_configs
         SET default_branch = ?, path_prefixes = ?, ticket_prefixes = ?, enabled = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(defaultBranch, pathPrefixes, ticketPrefixes, enabled, existing.id);
  } else {
    await db
      .prepare(
        `INSERT INTO project_github_configs
         (id, workspace_id, project_key, repo, default_branch, path_prefixes, ticket_prefixes, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.workspaceId,
        projectKey,
        repo,
        defaultBranch,
        pathPrefixes,
        ticketPrefixes,
        enabled,
      );
  }

  const row = await db
    .prepare(
      `SELECT * FROM project_github_configs
       WHERE workspace_id = ? AND project_key = ? AND repo = ?`,
    )
    .get<ConfigRow>(input.workspaceId, projectKey, repo);
  if (!row) throw new Error('upsert succeeded but row not readable');
  return rowToConfig(row);
}

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
