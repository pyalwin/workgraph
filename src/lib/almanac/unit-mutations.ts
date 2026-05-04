/**
 * Almanac Phase 6 — functional unit mutation helpers.
 *
 * Routes are thin wrappers that call these after auth.
 * The smoke test calls these helpers directly (bypasses auth).
 */
import { v4 as uuidv4 } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { inngest } from '@/inngest/client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UnitRow {
  id: string;
  workspace_id: string;
  project_key: string;
  name: string | null;
  description: string | null;
  status: string;
  detected_from: string;
  jira_epic_key: string | null;
  keywords: string;
  file_path_patterns: string;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UnitListItem {
  id: string;
  name: string | null;
  description: string | null;
  status: string;
  jira_epic_key: string | null;
  detected_from: string;
  ticket_count: number;
  code_event_count: number;
  last_active_at: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function emitRegen(workspaceId: string, forceUnits?: string[]) {
  try {
    await inngest.send({
      name: 'workgraph/almanac.narrative.regen',
      data: { workspaceId, forceUnits },
    });
  } catch (err) {
    // Non-fatal — Inngest dev server may not be running
    console.warn('[unit-mutations] inngest.send failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

// ─── createUnit ───────────────────────────────────────────────────────────────

export interface CreateUnitInput {
  workspaceId: string;
  projectKey: string;
  name: string;
  description?: string;
  filePathPatterns?: string[];
}

export async function createUnit(input: CreateUnitInput): Promise<{ id: string; name: string }> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const id = `manual:${uuidv4()}`;
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO functional_units
         (id, workspace_id, project_key, name, description, status,
          detected_from, keywords, file_path_patterns,
          first_seen_at, last_active_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', 'manual', '[]', ?,
               ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.workspaceId,
      input.projectKey,
      input.name,
      input.description ?? null,
      JSON.stringify(input.filePathPatterns ?? []),
      now,
      now,
      now,
      now,
    );

  await emitRegen(input.workspaceId, [id]);

  return { id, name: input.name };
}

// ─── listUnits ────────────────────────────────────────────────────────────────

export async function listUnits(
  workspaceId: string,
  projectKey: string,
): Promise<UnitListItem[]> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const rows = await db
    .prepare(
      `SELECT
         fu.id, fu.name, fu.description, fu.status,
         fu.jira_epic_key, fu.detected_from, fu.last_active_at,
         (SELECT COUNT(*) FROM code_events ce WHERE ce.functional_unit_id = fu.id) AS code_event_count,
         (SELECT COUNT(DISTINCT ce2.linked_item_id) FROM code_events ce2
          WHERE ce2.functional_unit_id = fu.id AND ce2.linked_item_id IS NOT NULL) AS ticket_count
       FROM functional_units fu
       WHERE fu.workspace_id = ? AND fu.project_key = ?
       ORDER BY fu.last_active_at DESC NULLS LAST`,
    )
    .all<UnitListItem>(workspaceId, projectKey);

  return rows;
}

// ─── renameUnit ───────────────────────────────────────────────────────────────

export interface RenameUnitInput {
  unitId: string;
  name?: string;
  description?: string;
}

export interface RenameUnitResult {
  id: string;
  name: string | null;
  description: string | null;
  updated_at: string;
}

export async function renameUnit(input: RenameUnitInput): Promise<RenameUnitResult | null> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const existing = await db
    .prepare(`SELECT id, workspace_id, project_key, name, description FROM functional_units WHERE id = ?`)
    .get<UnitRow>(input.unitId);

  if (!existing) return null;

  const newName = input.name ?? existing.name;
  const newDesc = input.description !== undefined ? input.description : existing.description;
  const now = nowIso();

  // Record old name as alias if name is changing
  if (input.name && input.name !== existing.name && existing.name) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO functional_unit_aliases (unit_id, alias, source, applied_at)
         VALUES (?, ?, 'rename', ?)`,
      )
      .run(input.unitId, existing.name, now);
  }

  await db
    .prepare(
      `UPDATE functional_units SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
    )
    .run(newName, newDesc, now, input.unitId);

  await emitRegen(existing.workspace_id, [input.unitId]);

  return { id: input.unitId, name: newName, description: newDesc, updated_at: now };
}

// ─── archiveUnit ──────────────────────────────────────────────────────────────

export async function archiveUnit(unitId: string): Promise<{ ok: boolean }> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const existing = await db
    .prepare(`SELECT id, workspace_id FROM functional_units WHERE id = ?`)
    .get<{ id: string; workspace_id: string }>(unitId);

  if (!existing) return { ok: false };

  const now = nowIso();
  await db
    .prepare(`UPDATE functional_units SET status = 'archived', updated_at = ? WHERE id = ?`)
    .run(now, unitId);

  return { ok: true };
}

// ─── mergeUnits ───────────────────────────────────────────────────────────────

export interface MergeUnitsInput {
  absorbedId: string; // the unit being merged away (id)
  survivingId: string; // the unit that absorbs (into)
}

export interface MergeUnitsResult {
  ok: boolean;
  surviving: string;
  absorbed: string;
  code_events_remapped: number;
}

export async function mergeUnits(input: MergeUnitsInput): Promise<MergeUnitsResult | { error: string; status: number }> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  if (input.absorbedId === input.survivingId) {
    return { error: 'Cannot merge a unit into itself', status: 400 };
  }

  const absorbed = await db
    .prepare(`SELECT id, workspace_id, project_key, name FROM functional_units WHERE id = ?`)
    .get<{ id: string; workspace_id: string; project_key: string; name: string | null }>(input.absorbedId);

  const surviving = await db
    .prepare(`SELECT id, workspace_id, project_key FROM functional_units WHERE id = ?`)
    .get<{ id: string; workspace_id: string; project_key: string }>(input.survivingId);

  if (!absorbed) return { error: `Unit not found: ${input.absorbedId}`, status: 404 };
  if (!surviving) return { error: `Unit not found: ${input.survivingId}`, status: 404 };

  if (absorbed.workspace_id !== surviving.workspace_id || absorbed.project_key !== surviving.project_key) {
    return { error: 'Units must belong to the same workspace and project', status: 400 };
  }

  const now = nowIso();

  // Alias: surviving unit gets alias pointing to absorbed unit id
  await db
    .prepare(
      `INSERT OR IGNORE INTO functional_unit_aliases (unit_id, alias, source, applied_at)
       VALUES (?, ?, 'merge', ?)`,
    )
    .run(input.survivingId, input.absorbedId, now);

  // Also alias the absorbed unit's name if it has one
  if (absorbed.name) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO functional_unit_aliases (unit_id, alias, source, applied_at)
         VALUES (?, ?, 'merge', ?)`,
      )
      .run(input.survivingId, absorbed.name, now);
  }

  // Remap code_events
  const remapResult = await db
    .prepare(`UPDATE code_events SET functional_unit_id = ? WHERE functional_unit_id = ?`)
    .run(input.survivingId, input.absorbedId);

  // Remap almanac_sections
  await db
    .prepare(`UPDATE almanac_sections SET unit_id = ? WHERE unit_id = ?`)
    .run(input.survivingId, input.absorbedId);

  // Mark absorbed unit as merged
  await db
    .prepare(`UPDATE functional_units SET status = 'merged', updated_at = ? WHERE id = ?`)
    .run(now, input.absorbedId);

  // Delete the merged unit's section (surviving unit's section will regenerate)
  await db
    .prepare(`DELETE FROM almanac_sections WHERE anchor = ?`)
    .run(`unit-${input.absorbedId}`);

  await emitRegen(absorbed.workspace_id, [input.survivingId]);

  return {
    ok: true,
    surviving: input.survivingId,
    absorbed: input.absorbedId,
    code_events_remapped: remapResult.changes,
  };
}

// ─── splitUnit ────────────────────────────────────────────────────────────────

export interface SplitFilter {
  pathPattern?: string;
  messageContains?: string;
}

export interface SplitUnitInput {
  sourceUnitId: string;
  filter: SplitFilter;
  newName: string;
  newDescription?: string;
}

export interface SplitUnitResult {
  ok: boolean;
  new_unit_id: string;
  code_events_moved: number;
}

export async function splitUnit(
  input: SplitUnitInput,
): Promise<SplitUnitResult | { error: string; status: number }> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  if (!input.filter.pathPattern && !input.filter.messageContains) {
    return { error: 'filter must specify at least one of: pathPattern, messageContains', status: 400 };
  }

  const source = await db
    .prepare(`SELECT id, workspace_id, project_key FROM functional_units WHERE id = ?`)
    .get<{ id: string; workspace_id: string; project_key: string }>(input.sourceUnitId);

  if (!source) return { error: `Unit not found: ${input.sourceUnitId}`, status: 404 };

  // Build WHERE predicate for matching events
  const predicates: string[] = ['functional_unit_id = ?'];
  const args: (string | number)[] = [input.sourceUnitId];

  if (input.filter.pathPattern) {
    // Match against files_touched JSON string (v1 approximation)
    predicates.push(`files_touched LIKE ?`);
    args.push(`%${input.filter.pathPattern}%`);
  }

  if (input.filter.messageContains) {
    predicates.push(`message LIKE ?`);
    args.push(`%${input.filter.messageContains}%`);
  }

  const whereClause = predicates.join(' AND ');
  const matching = await db
    .prepare(`SELECT id FROM code_events WHERE ${whereClause}`)
    .all<{ id: string }>(...args);

  if (matching.length === 0) {
    return {
      error: 'No matching code events found for the given filter',
      status: 400,
    };
  }

  const matchingIds = matching.map((r) => r.id);
  const newUnitId = `manual:${uuidv4()}`;
  const now = nowIso();

  // Create new unit
  await db
    .prepare(
      `INSERT INTO functional_units
         (id, workspace_id, project_key, name, description, status,
          detected_from, keywords, file_path_patterns,
          first_seen_at, last_active_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', 'manual', '[]', '[]',
               ?, ?, ?, ?)`,
    )
    .run(
      newUnitId,
      source.workspace_id,
      source.project_key,
      input.newName,
      input.newDescription ?? null,
      now,
      now,
      now,
      now,
    );

  // Record split alias
  await db
    .prepare(
      `INSERT OR IGNORE INTO functional_unit_aliases (unit_id, alias, source, applied_at)
       VALUES (?, ?, 'split', ?)`,
    )
    .run(newUnitId, `split_from:${input.sourceUnitId}`, now);

  // Move matching code events to new unit
  // Process in batches of 100 to avoid too-many-args issues
  let moved = 0;
  const batchSize = 100;
  for (let i = 0; i < matchingIds.length; i += batchSize) {
    const batch = matchingIds.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(', ');
    const result = await db
      .prepare(`UPDATE code_events SET functional_unit_id = ? WHERE id IN (${placeholders})`)
      .run(newUnitId, ...batch);
    moved += result.changes;
  }

  await emitRegen(source.workspace_id, [input.sourceUnitId, newUnitId]);

  return { ok: true, new_unit_id: newUnitId, code_events_moved: moved };
}
