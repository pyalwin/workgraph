import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';

loadEnv({ path: join(process.cwd(), '.env.local') });
loadEnv({ path: join(process.cwd(), '.env') });

/**
 * Phase 1 smoke test for the almanac.code-events.extract pipeline.
 *
 * Runs the agent's extract handler against the workgraph repo itself,
 * routes the ingest POST to the in-process Next.js route handler (no dev
 * server, no WorkOS), then verifies code_events rows landed and a re-run
 * is idempotent.
 *
 * Run: `npx tsx scripts/smoke-code-events-phase1.ts`
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// We must set HOME *before* importing the agent package, because
// packages/agent/src/config.ts resolves `os.homedir()` at module-load time.
const TMP_HOME = join(tmpdir(), `workgraph-smoke-${Date.now()}`);
mkdirSync(join(TMP_HOME, '.workgraph'), { recursive: true });
process.env.HOME = TMP_HOME;

const SMOKE_WORKSPACE = `smoke-${Date.now()}`;
const SMOKE_REPO = 'pyalwin/workgraph';

async function main() {
  const { mintAgentToken } = await import('../src/lib/agent-auth');
  const { ensureSchemaAsync } = await import('../src/lib/db/init-schema-async');
  const { getLibsqlDb } = await import('../src/lib/db/libsql');
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // Provision a fake paired agent: row in workspace_agents (so the ingest
  // route's verifyAgentRequest succeeds) + agent config on disk (so the
  // handler's apiFetch can read URL+token).
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

  // Route the ingest POST to the in-process route handler.
  const ingestRoute = await import('../src/app/api/almanac/code-events/ingest/route');
  const ingestPOST = ingestRoute.POST as (req: Request) => Promise<Response>;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/almanac/code-events/ingest')) {
      const req = new Request(url, init);
      return ingestPOST(req);
    }
    return origFetch(input as Request | string | URL, init);
  }) as typeof fetch;

  // Now import the handler — config + fetch overrides are in place.
  const { almanacCodeEventsExtractHandler } = await import(
    '../packages/agent/src/jobs/almanac-code-events-extract'
  );

  console.log(`[1/5] running extract handler on ${process.cwd()}`);
  const result1 = await almanacCodeEventsExtractHandler({
    workspaceId: SMOKE_WORKSPACE,
    repo: SMOKE_REPO,
    repoPath: process.cwd(),
  });
  console.log(`      total_events=${(result1 as { total_events: number }).total_events}  convention=${(result1 as { convention: string }).convention}  batches=${(result1 as { batches_sent: number }).batches_sent}`);
  if ((result1 as { total_events: number }).total_events === 0) {
    throw new Error('handler returned 0 events — git history extraction failed');
  }

  console.log('[2/5] verifying code_events landed in DB');
  const count1 = await db
    .prepare(`SELECT COUNT(*) as n FROM code_events WHERE workspace_id = ?`)
    .get<{ n: number }>(SMOKE_WORKSPACE);
  if (!count1 || count1.n === 0) {
    throw new Error(`expected rows in code_events; got ${JSON.stringify(count1)}`);
  }
  console.log(`      ${count1.n} rows in code_events for ${SMOKE_WORKSPACE}`);

  console.log('[3/5] verifying backfill_state cursor');
  const state1 = await db
    .prepare(`SELECT last_sha, last_occurred_at, total_events, last_status FROM code_events_backfill_state WHERE repo = ?`)
    .get<{ last_sha: string; last_occurred_at: string; total_events: number; last_status: string }>(SMOKE_REPO);
  if (!state1?.last_sha) {
    throw new Error(`backfill_state row missing or no cursor: ${JSON.stringify(state1)}`);
  }
  console.log(`      last_sha=${state1.last_sha.slice(0, 8)}  total=${state1.total_events}  status=${state1.last_status}`);

  console.log('[4/5] re-running handler — expect idempotent (no new rows)');
  const result2 = await almanacCodeEventsExtractHandler({
    workspaceId: SMOKE_WORKSPACE,
    repo: SMOKE_REPO,
    repoPath: process.cwd(),
  });
  const count2 = await db
    .prepare(`SELECT COUNT(*) as n FROM code_events WHERE workspace_id = ?`)
    .get<{ n: number }>(SMOKE_WORKSPACE);
  if (count2?.n !== count1.n) {
    throw new Error(`re-run was NOT idempotent: ${count1.n} -> ${count2?.n}`);
  }
  console.log(`      re-run produced ${(result2 as { total_events: number }).total_events} parsed events but inserted 0 new rows (idempotent ✓)`);

  console.log('[5/5] cleanup');
  await db.prepare(`DELETE FROM code_events WHERE workspace_id = ?`).run(SMOKE_WORKSPACE);
  await db.prepare(`DELETE FROM code_events_backfill_state WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM workspace_agents WHERE agent_id = ?`).run(agentId);
  rmSync(TMP_HOME, { recursive: true, force: true });
  globalThis.fetch = origFetch;

  console.log('\nPASS — Phase 1 code-events extract works end-to-end.');
  console.log(`  events extracted    = ${count1.n}`);
  console.log(`  convention detected = ${(result1 as { convention: string }).convention}`);
  console.log(`  cursor sha          = ${state1.last_sha.slice(0, 8)}`);
}

main().catch((err) => {
  console.error('\nFAIL:', err instanceof Error ? err.stack ?? err.message : err);
  rmSync(TMP_HOME, { recursive: true, force: true });
  process.exit(1);
});
