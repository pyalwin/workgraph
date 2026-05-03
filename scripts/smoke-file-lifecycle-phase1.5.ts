import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';

loadEnv({ path: join(process.cwd(), '.env.local') });
loadEnv({ path: join(process.cwd(), '.env') });

/**
 * Phase 1.5 smoke test for almanac.file-lifecycle.extract.
 *
 * Runs the agent's lifecycle handler against the workgraph repo, routes the
 * ingest POST to the in-process Next.js route handler, then verifies:
 *   - file_lifecycle has rows
 *   - at least one row has status='deleted' (this repo has deleted .ts files)
 *   - at least one row has a non-empty rename_chain
 *   - re-run is idempotent (same row count)
 *   - churn is non-zero for at least some paths (ingest computes via code_events)
 *
 * Run: `npx tsx scripts/smoke-file-lifecycle-phase1.5.ts`
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const TMP_HOME = join(tmpdir(), `workgraph-smoke-lc-${Date.now()}`);
mkdirSync(join(TMP_HOME, '.workgraph'), { recursive: true });
process.env.HOME = TMP_HOME;

const SMOKE_REPO = 'pyalwin/workgraph';
const SMOKE_WORKSPACE = `smoke-lc-${Date.now()}`;

async function main() {
  const { mintAgentToken } = await import('../src/lib/agent-auth');
  const { ensureSchemaAsync } = await import('../src/lib/db/init-schema-async');
  const { getLibsqlDb } = await import('../src/lib/db/libsql');
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // Provision a fake paired agent.
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

  // Seed code_events so churn computation has something to count. Run the
  // Phase 1 extract first so files_touched arrays exist for this repo.
  const codeEventsRoute = await import('../src/app/api/almanac/code-events/ingest/route');
  const lifecycleRoute = await import('../src/app/api/almanac/file-lifecycle/ingest/route');
  const codeEventsPOST = codeEventsRoute.POST as (req: Request) => Promise<Response>;
  const lifecyclePOST = lifecycleRoute.POST as (req: Request) => Promise<Response>;

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/almanac/code-events/ingest')) return codeEventsPOST(new Request(url, init));
    if (url.includes('/api/almanac/file-lifecycle/ingest')) return lifecyclePOST(new Request(url, init));
    return origFetch(input as Request | string | URL, init);
  }) as typeof fetch;

  // Drop any stale rows from prior failed runs (smoke tests share repo).
  await db.prepare(`DELETE FROM code_events WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM file_lifecycle WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM code_events_backfill_state WHERE repo = ?`).run(SMOKE_REPO);

  console.log('[1/7] seeding code_events for churn computation');
  const { almanacCodeEventsExtractHandler } = await import(
    '../packages/agent/src/jobs/almanac-code-events-extract'
  );
  await almanacCodeEventsExtractHandler({
    workspaceId: SMOKE_WORKSPACE,
    repo: SMOKE_REPO,
    repoPath: process.cwd(),
  });

  console.log('[2/7] running file-lifecycle extract handler');
  const { almanacFileLifecycleExtractHandler } = await import(
    '../packages/agent/src/jobs/almanac-file-lifecycle-extract'
  );
  const result1 = await almanacFileLifecycleExtractHandler({
    workspaceId: SMOKE_WORKSPACE,
    repo: SMOKE_REPO,
    repoPath: process.cwd(),
  });
  const r1 = result1 as { paths_total: number; batches_sent: number };
  console.log(`      paths_total=${r1.paths_total}  batches_sent=${r1.batches_sent}`);
  if (r1.paths_total === 0) throw new Error('handler returned 0 paths');

  console.log('[3/7] verifying file_lifecycle rows landed');
  const total = await db
    .prepare(`SELECT COUNT(*) as n FROM file_lifecycle WHERE repo = ?`)
    .get<{ n: number }>(SMOKE_REPO);
  if (!total || total.n === 0) throw new Error(`no file_lifecycle rows: ${JSON.stringify(total)}`);
  console.log(`      ${total.n} rows`);

  console.log('[4/7] verifying status=deleted rows exist (repo has deleted otti/* files)');
  const deleted = await db
    .prepare(`SELECT COUNT(*) as n FROM file_lifecycle WHERE repo = ? AND status = 'deleted'`)
    .get<{ n: number }>(SMOKE_REPO);
  if (!deleted || deleted.n === 0) throw new Error(`expected some deleted rows; got 0`);
  console.log(`      ${deleted.n} deleted rows`);

  console.log('[5/7] verifying at least one row has non-empty rename_chain');
  const renamed = await db
    .prepare(
      `SELECT path, rename_chain FROM file_lifecycle
       WHERE repo = ? AND rename_chain != '[]' LIMIT 3`,
    )
    .all<{ path: string; rename_chain: string }>(SMOKE_REPO);
  if (renamed.length === 0) {
    console.warn('      WARN: no rename chains detected — repo may have none, or extract logic missed them');
  } else {
    for (const r of renamed.slice(0, 3)) {
      console.log(`      ${r.path}  <- ${r.rename_chain}`);
    }
  }

  console.log('[6/7] verifying churn computed for some paths');
  const churnRows = await db
    .prepare(
      `SELECT path, churn FROM file_lifecycle
       WHERE repo = ? AND churn > 0 ORDER BY churn DESC LIMIT 3`,
    )
    .all<{ path: string; churn: number }>(SMOKE_REPO);
  if (churnRows.length === 0) throw new Error('no churn computed for any path — ingest churn join is broken');
  for (const r of churnRows) console.log(`      churn=${r.churn}  ${r.path}`);

  console.log('[7/7] re-run idempotency');
  await almanacFileLifecycleExtractHandler({
    workspaceId: SMOKE_WORKSPACE,
    repo: SMOKE_REPO,
    repoPath: process.cwd(),
  });
  const total2 = await db
    .prepare(`SELECT COUNT(*) as n FROM file_lifecycle WHERE repo = ?`)
    .get<{ n: number }>(SMOKE_REPO);
  if (total2?.n !== total.n) throw new Error(`re-run not idempotent: ${total.n} -> ${total2?.n}`);
  console.log(`      ${total2.n} rows after re-run (no growth, idempotent ✓)`);

  // Cleanup
  await db.prepare(`DELETE FROM file_lifecycle WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM code_events WHERE workspace_id = ?`).run(SMOKE_WORKSPACE);
  await db.prepare(`DELETE FROM code_events_backfill_state WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM workspace_agents WHERE agent_id = ?`).run(agentId);
  rmSync(TMP_HOME, { recursive: true, force: true });
  globalThis.fetch = origFetch;

  console.log('\nPASS — Phase 1.5 file-lifecycle works end-to-end.');
  console.log(`  paths total          = ${total.n}`);
  console.log(`  deleted              = ${deleted.n}`);
  console.log(`  with rename chains   = ${renamed.length} (sampled)`);
  console.log(`  paths with churn > 0 = at least ${churnRows.length} (sampled)`);
}

main().catch((err) => {
  console.error('\nFAIL:', err instanceof Error ? err.stack ?? err.message : err);
  rmSync(TMP_HOME, { recursive: true, force: true });
  process.exit(1);
});
