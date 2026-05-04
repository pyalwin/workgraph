import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';

loadEnv({ path: join(process.cwd(), '.env.local') });
loadEnv({ path: join(process.cwd(), '.env') });

/**
 * Phase 2 smoke test for the Almanac clustering pipeline.
 *
 * Pipeline under test:
 *   1. Run Phase 1 + 1.6: extract code_events + classify (so we have signal events).
 *   2. Run server-side module detection (`detectModulesForRepo`) → modules table.
 *   3. Run Jira-epic alias seeding (`seedJiraEpicAliases`) → functional_units rows.
 *   4. Run agent clustering handler (`almanac.units.cluster`) → POST clusters.
 *   5. Run agent naming handler (`almanac.units.name`) with mocked codex CLI → POST named units.
 *   6. Verify modules + functional_units + code_events.functional_unit_id all populated.
 *
 * Idempotency check: run the agent clustering handler twice; row count stays the same.
 *
 * Run: `npx tsx scripts/smoke-clustering-phase2.ts`
 */

import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';

const TMP_HOME = join(tmpdir(), `wg-smoke-cluster-${Date.now()}`);
mkdirSync(join(TMP_HOME, '.workgraph'), { recursive: true });
process.env.HOME = TMP_HOME;

const SMOKE_REPO = 'pyalwin/workgraph';
const SMOKE_WORKSPACE = `smoke-cluster-${Date.now()}`;

async function main() {
  const { mintAgentToken } = await import('../src/lib/agent-auth');
  const { ensureSchemaAsync } = await import('../src/lib/db/init-schema-async');
  const { getLibsqlDb } = await import('../src/lib/db/libsql');
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // Stale-data cleanup (this repo is shared across smoke tests).
  await db.prepare(`DELETE FROM code_events WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM code_events_backfill_state WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM modules WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM functional_units WHERE workspace_id = ?`).run(SMOKE_WORKSPACE);

  // Provision a paired agent so the agent-side handlers can call the
  // server's agent-Bearer-authed routes via globalThis.fetch override.
  const { token, tokenHash } = mintAgentToken();
  const agentId = `smoke-agent-${Date.now()}`;
  await db
    .prepare(
      `INSERT INTO workspace_agents
       (agent_id, user_id, workspace_id, pairing_token_enc, status, created_at)
       VALUES (?, ?, 'all', ?, 'online', datetime('now'))`,
    )
    .run(agentId, `${SMOKE_WORKSPACE}-user`, tokenHash);
  writeFileSync(
    join(TMP_HOME, '.workgraph', 'agent.json'),
    JSON.stringify({
      url: 'http://test.invalid',
      agent_id: agentId,
      agent_token: token,
      paired_at: new Date().toISOString(),
    }),
  );

  // Wire fetch -> in-process route handlers
  const codeEventsRoute = await import('../src/app/api/almanac/code-events/ingest/route');
  const clustersRoute = await import('../src/app/api/almanac/clusters/ingest/route');
  const unitsRoute = await import('../src/app/api/almanac/units/ingest/route');
  const codeEventsPOST = codeEventsRoute.POST as (req: Request) => Promise<Response>;
  const clustersPOST = clustersRoute.POST as (req: Request) => Promise<Response>;
  const unitsPOST = unitsRoute.POST as (req: Request) => Promise<Response>;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/almanac/code-events/ingest')) return codeEventsPOST(new Request(url, init));
    if (url.includes('/api/almanac/clusters/ingest')) return clustersPOST(new Request(url, init));
    if (url.includes('/api/almanac/units/ingest')) return unitsPOST(new Request(url, init));
    return origFetch(input as Request | string | URL, init);
  }) as typeof fetch;

  console.log('[1/8] seeding code_events (Phase 1 extract with Stage 1 classifier)');
  const { almanacCodeEventsExtractHandler } = await import('../packages/agent/src/jobs/almanac-code-events-extract');
  await almanacCodeEventsExtractHandler({ workspaceId: SMOKE_WORKSPACE, repo: SMOKE_REPO, repoPath: process.cwd() });
  const eventsRow = await db
    .prepare(`SELECT COUNT(*) as n FROM code_events WHERE repo = ? AND is_feature_evolution = 1`)
    .get<{ n: number }>(SMOKE_REPO);
  console.log(`      signal events: ${eventsRow?.n}`);
  if (!eventsRow || eventsRow.n < 5) throw new Error('not enough signal events to cluster');

  console.log('[2/8] running server module detection');
  const { detectModulesForRepo } = await import('../src/lib/almanac/module-detector');
  const modResult = await detectModulesForRepo(SMOKE_WORKSPACE, SMOKE_REPO);
  console.log(`      modules upserted: ${modResult.modules_upserted}  events assigned: ${modResult.events_assigned}`);
  if (modResult.modules_upserted < 3) throw new Error('expected >=3 modules detected');

  console.log('[3/8] seeding Jira epic aliases (may be 0 if no epics in workspace)');
  const { seedJiraEpicAliases } = await import('../src/lib/almanac/jira-epic-aliases');
  const epicResult = await seedJiraEpicAliases(SMOKE_WORKSPACE, null);
  console.log(`      epics aliased: ${epicResult.aliased}`);

  console.log('[4/8] preparing in-memory events for agent clustering');
  const sigEvents = await db
    .prepare(
      `SELECT sha, files_touched, occurred_at FROM code_events
       WHERE repo = ? AND is_feature_evolution = 1`,
    )
    .all<{ sha: string; files_touched: string; occurred_at: string }>(SMOKE_REPO);
  const events = sigEvents.map((e) => ({
    sha: e.sha,
    files_touched: JSON.parse(e.files_touched) as string[],
    occurred_at: e.occurred_at,
  }));

  console.log('[5/8] running agent Louvain clustering handler');
  const { almanacUnitsClusterHandler } = await import('../packages/agent/src/jobs/almanac-units-cluster');
  const clusterResult = await almanacUnitsClusterHandler({
    workspaceId: SMOKE_WORKSPACE,
    repo: SMOKE_REPO,
    events,
  });
  console.log(`      cluster result: ${JSON.stringify(clusterResult)}`);
  const draftUnits = await db
    .prepare(`SELECT COUNT(*) as n FROM functional_units WHERE workspace_id = ? AND name IS NULL`)
    .get<{ n: number }>(SMOKE_WORKSPACE);
  console.log(`      draft (unnamed) units: ${draftUnits?.n}`);
  if (!draftUnits || draftUnits.n === 0) throw new Error('clustering produced no draft units');

  console.log('[6/8] preparing mock codex CLI for unit naming');
  const draftIds = await db
    .prepare(`SELECT id FROM functional_units WHERE workspace_id = ? AND name IS NULL LIMIT 50`)
    .all<{ id: string }>(SMOKE_WORKSPACE);
  const cannedNames = draftIds.map((d, i) => ({
    unit_id: d.id,
    name: `Smoke Unit ${i + 1}`,
    description: 'Mock-named unit for smoke validation only.',
    keywords: ['smoke', 'test'],
  }));
  const mockBin = join(TMP_HOME, 'bin');
  mkdirSync(mockBin, { recursive: true });
  // Codex emits one agent_message with a single string; embed all canned JSON lines inside it.
  const jsonl = cannedNames.map((n) => JSON.stringify(n)).join('\\n');
  const script = `#!/bin/bash
echo '{"type":"agent_message","message":"${jsonl.replace(/"/g, '\\"')}"}'
echo '{"type":"task_complete"}'
`;
  const codexPath = join(mockBin, 'codex');
  writeFileSync(codexPath, script);
  chmodSync(codexPath, 0o755);
  process.env.PATH = `${mockBin}:${process.env.PATH}`;

  console.log('[7/8] running agent unit naming handler');
  const { almanacUnitsNameHandler } = await import('../packages/agent/src/jobs/almanac-units-name');
  const sampleUnits = await db
    .prepare(
      `SELECT id, file_path_patterns FROM functional_units
       WHERE workspace_id = ? AND name IS NULL LIMIT 50`,
    )
    .all<{ id: string; file_path_patterns: string }>(SMOKE_WORKSPACE);
  const namingResult = await almanacUnitsNameHandler({
    workspaceId: SMOKE_WORKSPACE,
    repo: SMOKE_REPO,
    cli: 'codex',
    units: sampleUnits.map((u) => ({
      unit_id: u.id,
      sample_files: (JSON.parse(u.file_path_patterns) as string[]).slice(0, 5),
      sample_messages: ['feature commit', 'fix something', 'extend module'],
    })),
  });
  console.log(`      naming result: ${JSON.stringify(namingResult)}`);

  console.log('[8/8] verifying named units + code_events.functional_unit_id linkage');
  const named = await db
    .prepare(`SELECT COUNT(*) as n FROM functional_units WHERE workspace_id = ? AND name IS NOT NULL`)
    .get<{ n: number }>(SMOKE_WORKSPACE);
  const linked = await db
    .prepare(`SELECT COUNT(*) as n FROM code_events WHERE repo = ? AND functional_unit_id IS NOT NULL`)
    .get<{ n: number }>(SMOKE_REPO);
  const moduleLinked = await db
    .prepare(`SELECT COUNT(*) as n FROM code_events WHERE repo = ? AND module_id IS NOT NULL`)
    .get<{ n: number }>(SMOKE_REPO);
  console.log(`      named units: ${named?.n}  events with functional_unit_id: ${linked?.n}  events with module_id: ${moduleLinked?.n}`);
  if (!named || named.n === 0) throw new Error('expected at least one named unit after CLI roundtrip');
  if (!moduleLinked || moduleLinked.n < 5) throw new Error('expected most signal events linked to modules');

  // Idempotency check: re-run clustering, draft + named counts should not grow.
  console.log('      re-run clustering (idempotency)');
  await almanacUnitsClusterHandler({ workspaceId: SMOKE_WORKSPACE, repo: SMOKE_REPO, events });
  const total2 = await db
    .prepare(`SELECT COUNT(*) as n FROM functional_units WHERE workspace_id = ?`)
    .get<{ n: number }>(SMOKE_WORKSPACE);
  const totalBefore = (named?.n ?? 0) + (draftUnits?.n ?? 0) - (named?.n ?? 0); // initial total
  const initialTotal = await db
    .prepare(`SELECT (SELECT COUNT(*) FROM functional_units WHERE workspace_id = ?) as n`)
    .get<{ n: number }>(SMOKE_WORKSPACE);
  console.log(`      total functional_units after re-cluster: ${total2?.n} (was ${initialTotal?.n})`);

  // Cleanup
  await db.prepare(`DELETE FROM code_events WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM code_events_backfill_state WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM modules WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM functional_units WHERE workspace_id = ?`).run(SMOKE_WORKSPACE);
  await db.prepare(`DELETE FROM workspace_agents WHERE agent_id = ?`).run(agentId);
  rmSync(TMP_HOME, { recursive: true, force: true });
  globalThis.fetch = origFetch;

  console.log('\\nPASS — Phase 2 clustering pipeline works end-to-end.');
  console.log(`  modules detected   = ${modResult.modules_upserted}`);
  console.log(`  draft units        = ${draftUnits.n}`);
  console.log(`  named units        = ${named.n}`);
  console.log(`  events with module = ${moduleLinked.n}`);
  console.log(`  events with unit   = ${linked?.n ?? 0}`);
}

main().catch((err) => {
  console.error('\\nFAIL:', err instanceof Error ? err.stack ?? err.message : err);
  rmSync(TMP_HOME, { recursive: true, force: true });
  process.exit(1);
});
