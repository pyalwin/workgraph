/**
 * project_connectors — generic project↔connector bindings.
 *
 * Replaces the JIRA-implicit / per-kind-table model: each row binds a project
 * to one slice of a workspace-level connector (a JIRA project, a GitHub repo,
 * a Slack channel, a Notion DB/page). See
 * docs/superpowers/specs/2026-05-07-decouple-project-from-jira-design.md.
 */

import { randomUUID } from 'crypto';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export type ConnectorKind = 'jira' | 'github' | 'slack' | 'notion';
export const CONNECTOR_KINDS: readonly ConnectorKind[] = ['jira', 'github', 'slack', 'notion'];

export interface ProjectConnector {
  id: string;
  workspaceId: string;
  projectKey: string;
  kind: ConnectorKind;
  ref: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ConnectorRow {
  id: string;
  workspace_id: string;
  project_key: string;
  kind: string;
  ref: string;
  config: string;
  created_at: string;
  updated_at: string;
}

function rowToConnector(row: ConnectorRow): ProjectConnector {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectKey: row.project_key,
    kind: row.kind as ConnectorKind,
    ref: row.ref,
    config: safeParseObject(row.config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParseObject(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function isConnectorKind(value: unknown): value is ConnectorKind {
  return typeof value === 'string' && (CONNECTOR_KINDS as readonly string[]).includes(value);
}

export async function listProjectConnectors(
  workspaceId: string,
  projectKey: string,
): Promise<ProjectConnector[]> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const rows = await db
    .prepare(
      `SELECT * FROM project_connectors
       WHERE workspace_id = ? AND project_key = ?
       ORDER BY kind ASC, ref ASC`,
    )
    .all<ConnectorRow>(workspaceId, projectKey.toUpperCase());
  return rows.map(rowToConnector);
}

export async function listConnectorsByKind(
  workspaceId: string,
  kind: ConnectorKind,
): Promise<ProjectConnector[]> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const rows = await db
    .prepare(
      `SELECT * FROM project_connectors
       WHERE workspace_id = ? AND kind = ?
       ORDER BY project_key ASC, ref ASC`,
    )
    .all<ConnectorRow>(workspaceId, kind);
  return rows.map(rowToConnector);
}

/** Reverse lookup: which project owns this (kind, ref) in this workspace? */
export async function findProjectByRef(
  workspaceId: string,
  kind: ConnectorKind,
  ref: string,
): Promise<ProjectConnector | null> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const row = await db
    .prepare(
      `SELECT * FROM project_connectors
       WHERE workspace_id = ? AND kind = ? AND ref = ?
       LIMIT 1`,
    )
    .get<ConnectorRow>(workspaceId, kind, ref);
  return row ? rowToConnector(row) : null;
}

export interface AttachInput {
  workspaceId: string;
  projectKey: string;
  kind: ConnectorKind;
  ref: string;
  config?: Record<string, unknown>;
}

export class ConnectorRefConflictError extends Error {
  constructor(public readonly conflictingProjectKey: string) {
    super(`(kind, ref) is already bound to project ${conflictingProjectKey}`);
    this.name = 'ConnectorRefConflictError';
  }
}

export async function attachProjectConnector(input: AttachInput): Promise<ProjectConnector> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const projectKey = input.projectKey.toUpperCase();
  const ref = input.ref.trim();
  if (!ref) throw new Error('ref is required');
  validateRefShape(input.kind, ref);

  // Conflict check: same (workspace, kind, ref) attached to a different project.
  const conflict = await db
    .prepare(
      `SELECT project_key FROM project_connectors
       WHERE workspace_id = ? AND kind = ? AND ref = ?
       LIMIT 1`,
    )
    .get<{ project_key: string }>(input.workspaceId, input.kind, ref);
  if (conflict && conflict.project_key !== projectKey) {
    throw new ConnectorRefConflictError(conflict.project_key);
  }

  // Idempotent upsert on (workspace, project, kind, ref).
  const existing = await db
    .prepare(
      `SELECT id FROM project_connectors
       WHERE workspace_id = ? AND project_key = ? AND kind = ? AND ref = ?`,
    )
    .get<{ id: string }>(input.workspaceId, projectKey, input.kind, ref);

  const config = JSON.stringify(input.config ?? {});

  if (existing) {
    await db
      .prepare(
        `UPDATE project_connectors
         SET config = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(config, existing.id);
  } else {
    await db
      .prepare(
        `INSERT INTO project_connectors
         (id, workspace_id, project_key, kind, ref, config)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), input.workspaceId, projectKey, input.kind, ref, config);
  }

  const row = await db
    .prepare(
      `SELECT * FROM project_connectors
       WHERE workspace_id = ? AND project_key = ? AND kind = ? AND ref = ?`,
    )
    .get<ConnectorRow>(input.workspaceId, projectKey, input.kind, ref);
  if (!row) throw new Error('attach succeeded but row not readable');
  return rowToConnector(row);
}

export async function detachProjectConnector(workspaceId: string, id: string): Promise<boolean> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const result = await db
    .prepare(`DELETE FROM project_connectors WHERE workspace_id = ? AND id = ?`)
    .run(workspaceId, id);
  return result.changes > 0;
}

const REF_PATTERNS: Record<ConnectorKind, { pattern: RegExp; hint: string }> = {
  jira: { pattern: /^[A-Z][A-Z0-9_]{0,31}$/, hint: 'JIRA project key, uppercase letters/digits/underscore' },
  github: { pattern: /^[^\s\/]+\/[^\s\/]+$/, hint: "owner/name (e.g. 'octocat/hello-world')" },
  // Slack channel ids look like 'C0123ABCD' but private channels and DMs have
  // other shapes; keep the validator permissive — rely on the connector itself
  // for canonical resolution.
  slack: { pattern: /^[A-Za-z0-9_.-]{1,64}$/, hint: 'Slack channel id or name' },
  notion: { pattern: /^[A-Za-z0-9_-]{1,128}$/, hint: 'Notion database or page id' },
};

export function validateRefShape(kind: ConnectorKind, ref: string): void {
  const rule = REF_PATTERNS[kind];
  if (!rule.pattern.test(ref)) {
    throw new Error(`invalid ref for kind '${kind}': expected ${rule.hint} (got: ${ref})`);
  }
}

export const PROJECT_KEY_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

export function validateProjectKey(key: string): void {
  if (!PROJECT_KEY_PATTERN.test(key)) {
    throw new Error(
      `invalid project key '${key}': must match ${PROJECT_KEY_PATTERN.source} (uppercase, alphanumeric + _/-, max 32)`,
    );
  }
}

/**
 * Builds a SQL fragment that matches `work_items` rows belonging to the
 * given project across any connector binding (JIRA, GitHub, etc.).
 *
 * Returns `{ sql, params }` to be inlined into a WHERE clause:
 *
 *     const filter = await buildProjectItemFilter(workspaceId, projectKey);
 *     db.prepare(`SELECT * FROM work_items wi WHERE ${filter.sql}`)
 *       .all(...filter.params);
 *
 * `tableAlias` lets callers prefix metadata accessors when needed (e.g.
 * `'wi'`); pass an empty string for unqualified queries.
 *
 * Fallback: if the project has no `project_connectors` rows yet (legacy
 * data), assume the project_key is a JIRA project key — that matches the
 * historical behavior before the decoupling change.
 */
export async function buildProjectItemFilter(
  workspaceId: string,
  projectKey: string,
  tableAlias = '',
): Promise<{ sql: string; params: string[] }> {
  const connectors = await listProjectConnectors(workspaceId, projectKey);
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const sourceCol = `${prefix}source`;
  const meta = (path: string) => `json_extract(${prefix}metadata, '${path}')`;

  // Group refs by kind.
  const jiraRefs = connectors.filter((c) => c.kind === 'jira').map((c) => c.ref);
  const githubRefs = connectors.filter((c) => c.kind === 'github').map((c) => c.ref);
  const slackRefs = connectors.filter((c) => c.kind === 'slack').map((c) => c.ref);
  const notionRefs = connectors.filter((c) => c.kind === 'notion').map((c) => c.ref);

  // Legacy fallback: no bindings yet, behave as before (JIRA key = project key).
  if (jiraRefs.length === 0 && githubRefs.length === 0 && slackRefs.length === 0 && notionRefs.length === 0) {
    return {
      sql: `(${sourceCol} = 'jira' AND ${meta('$.project')} = ?)`,
      params: [projectKey.toUpperCase()],
    };
  }

  const clauses: string[] = [];
  const params: string[] = [];

  if (jiraRefs.length > 0) {
    const placeholders = jiraRefs.map(() => '?').join(', ');
    // Both metadata.project (sync-jira.ts) and metadata.entity_key
    // (atlassian connector pipeline) carry the JIRA project key.
    clauses.push(
      `(${sourceCol} = 'jira' AND (${meta('$.project')} IN (${placeholders}) OR ${meta('$.entity_key')} IN (${placeholders})))`,
    );
    params.push(...jiraRefs, ...jiraRefs);
  }

  if (githubRefs.length > 0) {
    const placeholders = githubRefs.map(() => '?').join(', ');
    // GitHub adapter sets metadata.repo (releases) or metadata.repo_full_name
    // (repository nodes). Match either.
    clauses.push(
      `(${sourceCol} = 'github' AND (${meta('$.repo')} IN (${placeholders}) OR ${meta('$.repo_full_name')} IN (${placeholders})))`,
    );
    params.push(...githubRefs, ...githubRefs);
  }

  if (slackRefs.length > 0) {
    const placeholders = slackRefs.map(() => '?').join(', ');
    clauses.push(
      `(${sourceCol} = 'slack' AND (${meta('$.channel_id')} IN (${placeholders}) OR ${meta('$.channel')} IN (${placeholders})))`,
    );
    params.push(...slackRefs, ...slackRefs);
  }

  if (notionRefs.length > 0) {
    const placeholders = notionRefs.map(() => '?').join(', ');
    clauses.push(
      `(${sourceCol} = 'notion' AND (${meta('$.database_id')} IN (${placeholders}) OR ${meta('$.page_id')} IN (${placeholders})))`,
    );
    params.push(...notionRefs, ...notionRefs);
  }

  return {
    sql: `(${clauses.join(' OR ')})`,
    params,
  };
}
