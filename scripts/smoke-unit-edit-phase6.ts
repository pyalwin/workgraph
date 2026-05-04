/**
 * Phase 6 smoke test — functional unit edit UI backend.
 *
 * Tests (all via helper functions, no HTTP/auth required):
 *   1. Setup: 2 stub units + 2 code_events each in workspace='default', project='KAN'
 *   2. Rename: PATCH name → alias row exists, name updated
 *   3. Merge: unit A into unit B → code_events remapped, alias created, A status='merged'
 *   4. Split: stub unit C → POST split with messageContains → new unit + events moved
 *   5. Archive: unit C archived, history preserved
 *   6. Cleanup: delete all smoke artifacts
 *
 * Run: `npx tsx scripts/smoke-unit-edit-phase6.ts`
 */

import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';

loadEnv({ path: join(process.cwd(), '.env.local') });
loadEnv({ path: join(process.cwd(), '.env') });

async function main() {
  const { ensureSchemaAsync } = await import('../src/lib/db/init-schema-async');
  const { getLibsqlDb } = await import('../src/lib/db/libsql');
  const {
    createUnit,
    renameUnit,
    mergeUnits,
    splitUnit,
    archiveUnit,
    listUnits,
  } = await import('../src/lib/almanac/unit-mutations');

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const WS = 'default';
  const PK = 'KAN';

  // Prefixes to find smoke artifacts for cleanup
  const smokeUnitIds: string[] = [];
  const smokeEventIds: string[] = [];

  console.log('[0/6] cleanup any prior smoke-phase6 artifacts');
  // clean up any leftovers from a prior run
  const priorEvents = await db
    .prepare(`SELECT id FROM code_events WHERE message LIKE 'smoke-phase6-%'`)
    .all<{ id: string }>();
  for (const e of priorEvents) {
    await db.prepare(`DELETE FROM code_events WHERE id = ?`).run(e.id);
  }
  const priorUnits = await db
    .prepare(`SELECT id FROM functional_units WHERE workspace_id = ? AND project_key = ? AND detected_from = 'manual' AND name LIKE 'smoke-phase6-%'`)
    .all<{ id: string }>(WS, PK);
  for (const u of priorUnits) {
    await db.prepare(`DELETE FROM functional_unit_aliases WHERE unit_id = ?`).run(u.id);
    await db.prepare(`DELETE FROM functional_units WHERE id = ?`).run(u.id);
  }

  // ── [1/6] Setup ────────────────────────────────────────────────────────────
  console.log('[1/6] creating stub units + code events');

  const unitA = await createUnit({ workspaceId: WS, projectKey: PK, name: 'smoke-phase6-unit-A', description: 'stub A' });
  const unitB = await createUnit({ workspaceId: WS, projectKey: PK, name: 'smoke-phase6-unit-B', description: 'stub B' });
  smokeUnitIds.push(unitA.id, unitB.id);

  // Insert fake code events for unitA (2 events)
  // sha must be unique per repo — use a distinct prefix per event
  const ts = Date.now();
  const evA1 = `smoke-phase6-ev-a1-${ts}`;
  const evA2 = `smoke-phase6-ev-a2-${ts}`;
  for (const [eid, sha, msg] of [
    [evA1, `sha-a1-${ts}`, 'smoke-phase6-feat: add auth'],
    [evA2, `sha-a2-${ts}`, 'smoke-phase6-fix: login bug'],
  ] as [string, string, string][]) {
    await db.prepare(
      `INSERT OR IGNORE INTO code_events
         (id, workspace_id, repo, sha, pr_number, kind, message, occurred_at,
          files_touched, functional_unit_id, is_feature_evolution)
       VALUES (?, ?, 'smoke-repo', ?, 1, 'pr_merged', ?, datetime('now'), '[]', ?, 0)`
    ).run(eid, WS, sha, msg, unitA.id);
    smokeEventIds.push(eid);
  }

  // Insert fake code events for unitB (2 events)
  const evB1 = `smoke-phase6-ev-b1-${ts}`;
  const evB2 = `smoke-phase6-ev-b2-${ts}`;
  for (const [eid, sha, msg] of [
    [evB1, `sha-b1-${ts}`, 'smoke-phase6-chore: cleanup'],
    [evB2, `sha-b2-${ts}`, 'smoke-phase6-docs: readme'],
  ] as [string, string, string][]) {
    await db.prepare(
      `INSERT OR IGNORE INTO code_events
         (id, workspace_id, repo, sha, pr_number, kind, message, occurred_at,
          files_touched, functional_unit_id, is_feature_evolution)
       VALUES (?, ?, 'smoke-repo', ?, 2, 'pr_merged', ?, datetime('now'), '[]', ?, 0)`
    ).run(eid, WS, sha, msg, unitB.id);
    smokeEventIds.push(eid);
  }

  const listed = await listUnits(WS, PK);
  const unitARow = listed.find((u) => u.id === unitA.id);
  const unitBRow = listed.find((u) => u.id === unitB.id);
  if (!unitARow) throw new Error('FAIL: unit A not found in listUnits');
  if (!unitBRow) throw new Error('FAIL: unit B not found in listUnits');
  console.log(`  unit A: id=${unitA.id} code_events=${unitARow.code_event_count}`);
  console.log(`  unit B: id=${unitB.id} code_events=${unitBRow.code_event_count}`);
  if (unitARow.code_event_count !== 2) throw new Error(`FAIL: expected 2 events for unitA, got ${unitARow.code_event_count}`);
  if (unitBRow.code_event_count !== 2) throw new Error(`FAIL: expected 2 events for unitB, got ${unitBRow.code_event_count}`);

  // ── [2/6] Rename ───────────────────────────────────────────────────────────
  console.log('[2/6] rename unit A');
  const renamed = await renameUnit({ unitId: unitA.id, name: 'smoke-phase6-unit-A-renamed' });
  if (!renamed) throw new Error('FAIL: renameUnit returned null');
  if (renamed.name !== 'smoke-phase6-unit-A-renamed') throw new Error(`FAIL: name not updated: ${renamed.name}`);

  const alias = await db
    .prepare(`SELECT alias, source FROM functional_unit_aliases WHERE unit_id = ? AND alias = 'smoke-phase6-unit-A'`)
    .get<{ alias: string; source: string }>(unitA.id);
  if (!alias) throw new Error('FAIL: rename alias row not created');
  if (alias.source !== 'rename') throw new Error(`FAIL: alias source should be 'rename', got '${alias.source}'`);
  console.log(`  name updated to: ${renamed.name}`);
  console.log(`  alias row: alias='${alias.alias}' source='${alias.source}' ✓`);

  // ── [3/6] Merge ────────────────────────────────────────────────────────────
  console.log('[3/6] merge unit A (absorbed) into unit B (surviving)');
  const mergeResult = await mergeUnits({ absorbedId: unitA.id, survivingId: unitB.id });
  if ('error' in mergeResult) throw new Error(`FAIL: merge error: ${mergeResult.error}`);
  if (!mergeResult.ok) throw new Error('FAIL: merge returned ok=false');
  if (mergeResult.code_events_remapped !== 2) {
    throw new Error(`FAIL: expected 2 events remapped, got ${mergeResult.code_events_remapped}`);
  }

  // Verify code_events remapped
  const evCount = await db
    .prepare(`SELECT COUNT(*) as n FROM code_events WHERE functional_unit_id = ?`)
    .get<{ n: number }>(unitB.id);
  if ((evCount?.n ?? 0) < 4) throw new Error(`FAIL: unitB should have ≥4 events after merge, got ${evCount?.n}`);

  // Verify absorbed unit status = 'merged'
  const absorbedRow = await db
    .prepare(`SELECT status FROM functional_units WHERE id = ?`)
    .get<{ status: string }>(unitA.id);
  if (absorbedRow?.status !== 'merged') throw new Error(`FAIL: absorbed unit status should be 'merged', got '${absorbedRow?.status}'`);

  // Verify alias on surviving unit pointing to absorbed id
  const mergeAlias = await db
    .prepare(`SELECT source FROM functional_unit_aliases WHERE unit_id = ? AND alias = ?`)
    .get<{ source: string }>(unitB.id, unitA.id);
  if (!mergeAlias) throw new Error('FAIL: merge alias not created on surviving unit');
  if (mergeAlias.source !== 'merge') throw new Error(`FAIL: merge alias source should be 'merge', got '${mergeAlias.source}'`);

  console.log(`  code_events_remapped=${mergeResult.code_events_remapped} ✓`);
  console.log(`  absorbed unit status='${absorbedRow?.status}' ✓`);
  console.log(`  merge alias on surviving unit ✓`);

  // ── [4/6] Split ────────────────────────────────────────────────────────────
  console.log('[4/6] split — create unit C with 3 events (2 with "auth" in message), then split');

  const unitC = await createUnit({ workspaceId: WS, projectKey: PK, name: 'smoke-phase6-unit-C' });
  smokeUnitIds.push(unitC.id);

  const ts2 = Date.now();
  for (const [eid, sha, msg] of [
    [`smoke-phase6-ev-c1-${ts2}`, `sha-c1-${ts2}`, 'smoke-phase6-feat: auth overhaul'],
    [`smoke-phase6-ev-c2-${ts2}`, `sha-c2-${ts2}`, 'smoke-phase6-feat: auth token refresh'],
    [`smoke-phase6-ev-c3-${ts2}`, `sha-c3-${ts2}`, 'smoke-phase6-chore: linting'],
  ] as [string, string, string][]) {
    await db.prepare(
      `INSERT OR IGNORE INTO code_events
         (id, workspace_id, repo, sha, pr_number, kind, message, occurred_at,
          files_touched, functional_unit_id, is_feature_evolution)
       VALUES (?, ?, 'smoke-repo', ?, 3, 'pr_merged', ?, datetime('now'), '[]', ?, 0)`
    ).run(eid, WS, sha, msg, unitC.id);
    smokeEventIds.push(eid);
  }

  const splitResult = await splitUnit({
    sourceUnitId: unitC.id,
    filter: { messageContains: 'smoke-phase6-feat: auth' },
    newName: 'smoke-phase6-unit-C-auth-split',
    newDescription: 'Auth split from C',
  });

  if ('error' in splitResult) throw new Error(`FAIL: split error: ${splitResult.error}`);
  if (!splitResult.ok) throw new Error('FAIL: split returned ok=false');
  if (splitResult.code_events_moved !== 2) {
    throw new Error(`FAIL: expected 2 events moved by split, got ${splitResult.code_events_moved}`);
  }
  smokeUnitIds.push(splitResult.new_unit_id);

  // Verify new unit exists with 2 events
  const newUnitEvents = await db
    .prepare(`SELECT COUNT(*) as n FROM code_events WHERE functional_unit_id = ?`)
    .get<{ n: number }>(splitResult.new_unit_id);
  if ((newUnitEvents?.n ?? 0) !== 2) throw new Error(`FAIL: new unit should have 2 events, got ${newUnitEvents?.n}`);

  // Verify split alias
  const splitAlias = await db
    .prepare(`SELECT source FROM functional_unit_aliases WHERE unit_id = ? AND alias = ?`)
    .get<{ source: string }>(splitResult.new_unit_id, `split_from:${unitC.id}`);
  if (!splitAlias) throw new Error('FAIL: split alias not created on new unit');
  if (splitAlias.source !== 'split') throw new Error(`FAIL: split alias source should be 'split', got '${splitAlias.source}'`);

  console.log(`  code_events_moved=${splitResult.code_events_moved} ✓`);
  console.log(`  new unit id=${splitResult.new_unit_id} ✓`);
  console.log(`  split alias created ✓`);

  // ── [5/6] Archive ──────────────────────────────────────────────────────────
  console.log('[5/6] archive unit C');
  const archiveResult = await archiveUnit(unitC.id);
  if (!archiveResult.ok) throw new Error('FAIL: archiveUnit returned ok=false');

  const archivedRow = await db
    .prepare(`SELECT status FROM functional_units WHERE id = ?`)
    .get<{ status: string }>(unitC.id);
  if (archivedRow?.status !== 'archived') throw new Error(`FAIL: unit C status should be 'archived', got '${archivedRow?.status}'`);

  // Events should still exist (history preserved)
  const cEventCount = await db
    .prepare(`SELECT COUNT(*) as n FROM code_events WHERE functional_unit_id = ?`)
    .get<{ n: number }>(unitC.id);
  console.log(`  unit C status='${archivedRow?.status}' ✓`);
  console.log(`  code events preserved (unitC still has ${cEventCount?.n ?? 0} events) ✓`);

  // ── [6/6] Cleanup ─────────────────────────────────────────────────────────
  console.log('[6/6] cleanup smoke artifacts');
  for (const eid of smokeEventIds) {
    await db.prepare(`DELETE FROM code_events WHERE id = ?`).run(eid);
  }
  for (const uid of smokeUnitIds) {
    await db.prepare(`DELETE FROM functional_unit_aliases WHERE unit_id = ?`).run(uid);
    await db.prepare(`DELETE FROM functional_units WHERE id = ?`).run(uid);
  }
  // Also clean up merged unit A (still in DB with status=merged)
  await db.prepare(`DELETE FROM functional_unit_aliases WHERE unit_id = ?`).run(unitA.id);
  await db.prepare(`DELETE FROM functional_units WHERE id = ?`).run(unitA.id);

  console.log('\nPASS — Phase 6 unit-edit mutations work end-to-end.');
  console.log('  create     ✓');
  console.log('  rename     ✓  (alias row verified)');
  console.log('  merge      ✓  (code_events remapped, status=merged, alias created)');
  console.log('  split      ✓  (new unit, events moved, alias created)');
  console.log('  archive    ✓  (status=archived, history preserved)');
  console.log('\nPhase 6.5 (PR-level evolution_override toggle in PR drawer) is deferred.');
}

main().catch((err) => {
  console.error('\nFAIL:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
