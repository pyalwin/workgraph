/**
 * Project lifecycle: explicit create / delete operations.
 *
 * The project_summaries table is the canonical project registry. Historically
 * rows were created implicitly by the JIRA sync (every JIRA project key →
 * one row). After decoupling from JIRA, projects can also be created
 * manually or implicitly when a connector is attached.
 *
 * Spec: docs/superpowers/specs/2026-05-07-decouple-project-from-jira-design.md
 */

import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { validateProjectKey } from '@/lib/project-connectors';

export type CreatedVia = 'manual' | 'jira-sync' | 'connector-attach';

export interface ProjectRecord {
  projectKey: string;
  name: string;
  createdVia: CreatedVia | null;
  updatedAt: string | null;
}

export class ProjectKeyExistsError extends Error {
  constructor(public readonly key: string) {
    super(`project_key already exists: ${key}`);
    this.name = 'ProjectKeyExistsError';
  }
}

export async function getProject(projectKey: string): Promise<ProjectRecord | null> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const row = await db
    .prepare(
      `SELECT project_key, name, created_via, updated_at
       FROM project_summaries WHERE project_key = ?`,
    )
    .get<{
      project_key: string;
      name: string;
      created_via: string | null;
      updated_at: string | null;
    }>(projectKey.toUpperCase());
  if (!row) return null;
  return {
    projectKey: row.project_key,
    name: row.name,
    createdVia: (row.created_via as CreatedVia | null) ?? null,
    updatedAt: row.updated_at,
  };
}

export async function createProject(input: {
  key: string;
  name: string;
  createdVia: CreatedVia;
}): Promise<ProjectRecord> {
  await ensureSchemaAsync();

  const projectKey = input.key.toUpperCase();
  validateProjectKey(projectKey);

  const db = getLibsqlDb();
  const existing = await db
    .prepare(`SELECT project_key FROM project_summaries WHERE project_key = ?`)
    .get<{ project_key: string }>(projectKey);
  if (existing) throw new ProjectKeyExistsError(projectKey);

  const name = input.name.trim() || projectKey;
  await db
    .prepare(
      `INSERT INTO project_summaries (project_key, name, created_via, updated_at)
       VALUES (?, ?, ?, datetime('now'))`,
    )
    .run(projectKey, name, input.createdVia);

  const created = await getProject(projectKey);
  if (!created) throw new Error('createProject succeeded but row not readable');
  return created;
}

/**
 * Deletes a project and its project-owned dependents.
 *
 * Cascades:
 *   - project_connectors        (bindings)
 *   - almanac_docs              (and almanac_doc_sections via FK CASCADE)
 *   - goals (project_key = ?)   (project-anchored OKRs)
 *   - project_github_configs    (deprecated table; clean up regardless)
 *   - project_summaries         (the project itself)
 *
 * Items synced from connectors (work_items) are workspace-owned and kept;
 * any rows tagged with this project_key would be re-tagged null but
 * work_items doesn't carry project_key directly (it's resolved at query
 * time from source/metadata), so no UPDATE is needed there.
 */
export async function deleteProject(projectKey: string): Promise<boolean> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const key = projectKey.toUpperCase();

  const existing = await db
    .prepare(`SELECT project_key FROM project_summaries WHERE project_key = ?`)
    .get<{ project_key: string }>(key);
  if (!existing) return false;

  // Dependent rows. Order doesn't strictly matter here because there are no
  // FKs declared between these tables in our schema, but listing them keeps
  // the intent explicit.
  await db.prepare(`DELETE FROM project_connectors WHERE project_key = ?`).run(key);
  await db.prepare(`DELETE FROM project_github_configs WHERE project_key = ?`).run(key);
  await db.prepare(`DELETE FROM almanac_docs WHERE project_key = ?`).run(key);
  // goals are workspace-scoped (Phase 3); deleting a project clears its
  // OKRs across every workspace that may have rows for the same project_key.
  // In practice a project_key is owned by one workspace so this is the same
  // row set as before, but the explicit project_key match is the intended
  // contract.
  await db.prepare(`DELETE FROM goals WHERE project_key = ?`).run(key);
  await db.prepare(`DELETE FROM project_summaries WHERE project_key = ?`).run(key);

  return true;
}
