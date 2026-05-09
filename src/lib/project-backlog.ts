/**
 * Project backlog — AI-suggested + user-managed todos and feature ideas.
 *
 * Stable id (sha1 of `project_key|kind|normalized_title`) makes regen
 * idempotent: `INSERT OR IGNORE` on a re-ingested item is a no-op, so the
 * user's edits/state never get clobbered. The first occurrence of a given
 * (project, kind, title) wins; subsequent ingests of the same item update
 * only the description/evidence (so the LLM can refine its rationale)
 * without touching state.
 */

import { createHash, randomUUID } from 'crypto';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';

export type BacklogKind = 'todo' | 'feature';
export const BACKLOG_KINDS: readonly BacklogKind[] = ['todo', 'feature'];

export type BacklogState = 'open' | 'in_progress' | 'done' | 'dismissed';
export const BACKLOG_STATES: readonly BacklogState[] = ['open', 'in_progress', 'done', 'dismissed'];

export type BacklogSource = 'almanac' | 'manual';

export interface BacklogEvidence {
  paths?: string[];
  refs?: string[];
  commits?: string[];
  notes?: string;
}

export interface BacklogItem {
  id: string;
  workspaceId: string;
  projectKey: string;
  kind: BacklogKind;
  title: string;
  description: string | null;
  source: BacklogSource;
  state: BacklogState;
  aiGenerated: boolean;
  evidence: BacklogEvidence | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  dismissedAt: string | null;
}

interface BacklogRow {
  id: string;
  workspace_id: string;
  project_key: string;
  kind: string;
  title: string;
  description: string | null;
  source: string;
  state: string;
  ai_generated: number;
  evidence: string | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  dismissed_at: string | null;
}

function rowTo(row: BacklogRow): BacklogItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectKey: row.project_key,
    kind: row.kind as BacklogKind,
    title: row.title,
    description: row.description,
    source: (row.source as BacklogSource) ?? 'manual',
    state: row.state as BacklogState,
    aiGenerated: row.ai_generated === 1,
    evidence: parseEvidence(row.evidence),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    doneAt: row.done_at,
    dismissedAt: row.dismissed_at,
  };
}

function parseEvidence(raw: string | null): BacklogEvidence | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as BacklogEvidence) : null;
  } catch {
    return null;
  }
}

export function isBacklogKind(v: unknown): v is BacklogKind {
  return typeof v === 'string' && (BACKLOG_KINDS as readonly string[]).includes(v);
}

export function isBacklogState(v: unknown): v is BacklogState {
  return typeof v === 'string' && (BACKLOG_STATES as readonly string[]).includes(v);
}

/** Stable id: sha1('<projectKey>|<kind>|<normalized title>'). */
export function computeStableId(projectKey: string, kind: BacklogKind, title: string): string {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha1')
    .update(`${projectKey.toUpperCase()}|${kind}|${normalized}`)
    .digest('hex');
}

export interface ListFilter {
  state?: BacklogState | 'all';
  kind?: BacklogKind | 'all';
}

export async function listBacklog(
  workspaceId: string,
  projectKey: string,
  filter: ListFilter = {},
): Promise<BacklogItem[]> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const clauses: string[] = ['workspace_id = ?', 'project_key = ?'];
  const params: string[] = [workspaceId, projectKey.toUpperCase()];

  if (filter.state && filter.state !== 'all') {
    clauses.push('state = ?');
    params.push(filter.state);
  }
  if (filter.kind && filter.kind !== 'all') {
    clauses.push('kind = ?');
    params.push(filter.kind);
  }

  const rows = await db
    .prepare(
      `SELECT * FROM project_backlog_items
       WHERE ${clauses.join(' AND ')}
       ORDER BY
         CASE state
           WHEN 'in_progress' THEN 0
           WHEN 'open' THEN 1
           WHEN 'done' THEN 2
           WHEN 'dismissed' THEN 3
         END,
         CASE kind WHEN 'todo' THEN 0 WHEN 'feature' THEN 1 END,
         updated_at DESC`,
    )
    .all<BacklogRow>(...params);
  return rows.map(rowTo);
}

export interface UpsertInput {
  workspaceId: string;
  projectKey: string;
  kind: BacklogKind;
  title: string;
  description?: string | null;
  source?: BacklogSource;
  aiGenerated?: boolean;
  evidence?: BacklogEvidence | null;
}

/**
 * Idempotent ingest used by the LLM regen path.
 *
 * - If an item with the same stable id exists: refresh `description` and
 *   `evidence` (so LLM rationale can improve), but do NOT change `state`,
 *   `title`, `source`, or any user-set field. Bumps `updated_at`.
 * - If it doesn't exist: insert a new row with state='open'.
 *
 * Returns the resulting row.
 */
export async function ingestBacklogItem(input: UpsertInput): Promise<BacklogItem> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const projectKey = input.projectKey.toUpperCase();
  const id = computeStableId(projectKey, input.kind, input.title);

  const existing = await db
    .prepare(`SELECT id FROM project_backlog_items WHERE id = ?`)
    .get<{ id: string }>(id);

  const evidenceJson = input.evidence ? JSON.stringify(input.evidence) : null;

  if (existing) {
    await db
      .prepare(
        `UPDATE project_backlog_items
         SET description = COALESCE(?, description),
             evidence    = COALESCE(?, evidence),
             updated_at  = datetime('now')
         WHERE id = ?`,
      )
      .run(input.description ?? null, evidenceJson, id);
  } else {
    await db
      .prepare(
        `INSERT INTO project_backlog_items
         (id, workspace_id, project_key, kind, title, description,
          source, state, ai_generated, evidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        projectKey,
        input.kind,
        input.title.trim(),
        input.description ?? null,
        input.source ?? 'almanac',
        input.aiGenerated === false ? 0 : 1,
        evidenceJson,
      );
  }

  const row = await db
    .prepare(`SELECT * FROM project_backlog_items WHERE id = ?`)
    .get<BacklogRow>(id);
  if (!row) throw new Error('ingestBacklogItem: row not found after upsert');
  return rowTo(row);
}

/**
 * Manual creation. Differs from ingest in two ways:
 *   - source defaults to 'manual', ai_generated=0
 *   - if a stable-id collision exists, throws (so the user gets immediate
 *     feedback rather than silently no-oping)
 */
export async function createBacklogItem(input: UpsertInput): Promise<BacklogItem> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const projectKey = input.projectKey.toUpperCase();
  const title = input.title.trim();
  if (!title) throw new Error('title is required');
  const id = computeStableId(projectKey, input.kind, title);

  const existing = await db
    .prepare(`SELECT id FROM project_backlog_items WHERE id = ?`)
    .get<{ id: string }>(id);
  if (existing) {
    throw new Error('an item with this title already exists for this project');
  }

  // Use a fresh uuid here would defeat dedup, but stable id IS the primary
  // key — keep it. randomUUID isn't needed.
  void randomUUID;
  await db
    .prepare(
      `INSERT INTO project_backlog_items
       (id, workspace_id, project_key, kind, title, description,
        source, state, ai_generated, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, ?)`,
    )
    .run(
      id,
      input.workspaceId,
      projectKey,
      input.kind,
      title,
      input.description ?? null,
      input.source ?? 'manual',
      input.evidence ? JSON.stringify(input.evidence) : null,
    );

  const row = await db
    .prepare(`SELECT * FROM project_backlog_items WHERE id = ?`)
    .get<BacklogRow>(id);
  if (!row) throw new Error('createBacklogItem: row not found after insert');
  return rowTo(row);
}

export interface UpdateInput {
  state?: BacklogState;
  kind?: BacklogKind;
  title?: string;
  description?: string | null;
}

export async function updateBacklogItem(
  workspaceId: string,
  id: string,
  patch: UpdateInput,
): Promise<BacklogItem | null> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const existing = await db
    .prepare(`SELECT * FROM project_backlog_items WHERE workspace_id = ? AND id = ?`)
    .get<BacklogRow>(workspaceId, id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (patch.state) {
    sets.push('state = ?');
    params.push(patch.state);
    if (patch.state === 'done') {
      sets.push("done_at = datetime('now')");
    } else if (patch.state === 'dismissed') {
      sets.push("dismissed_at = datetime('now')");
    } else if (existing.state === 'done' || existing.state === 'dismissed') {
      // re-opening: clear the terminal-state timestamps
      sets.push('done_at = NULL', 'dismissed_at = NULL');
    }
  }
  if (patch.kind) {
    sets.push('kind = ?');
    params.push(patch.kind);
  }
  if (typeof patch.title === 'string' && patch.title.trim()) {
    sets.push('title = ?');
    params.push(patch.title.trim());
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    params.push(patch.description);
  }

  if (sets.length === 0) {
    return rowTo(existing);
  }

  sets.push("updated_at = datetime('now')");

  await db
    .prepare(`UPDATE project_backlog_items SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params, id);

  const row = await db
    .prepare(`SELECT * FROM project_backlog_items WHERE id = ?`)
    .get<BacklogRow>(id);
  return row ? rowTo(row) : null;
}

export async function deleteBacklogItem(workspaceId: string, id: string): Promise<boolean> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const result = await db
    .prepare(`DELETE FROM project_backlog_items WHERE workspace_id = ? AND id = ?`)
    .run(workspaceId, id);
  return result.changes > 0;
}

export async function getLastIngestAt(
  workspaceId: string,
  projectKey: string,
): Promise<string | null> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();
  const row = await db
    .prepare(
      `SELECT MAX(updated_at) AS latest FROM project_backlog_items
       WHERE workspace_id = ? AND project_key = ? AND source = 'almanac'`,
    )
    .get<{ latest: string | null }>(workspaceId, projectKey.toUpperCase());
  return row?.latest ?? null;
}
