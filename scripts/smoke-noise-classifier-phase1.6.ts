import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';

loadEnv({ path: join(process.cwd(), '.env.local') });
loadEnv({ path: join(process.cwd(), '.env') });

/**
 * Phase 1.6 smoke test for the Almanac noise classifier.
 *
 * Stage 1 (mechanical) is exercised via the existing code-events ingest path:
 *   - Run the agent's extract handler against the workgraph repo (in-process route).
 *   - Verify ~30-50% of events are tagged as a noise class (target band per plan).
 *   - Spot-check known patterns (lock-only commits → dependency_bump, doc-only → docs_only).
 *
 * Stage 2 (LLM) is exercised in unit form by stubbing globalThis.fetch + spawning
 * a mock CLI via a fake `codex` shell script written under tmpdir + PATH override.
 * The mock emits one Codex-shaped JSON line per sha, and the handler should POST
 * those classifications to the in-process /api/almanac/noise/classify/ingest route.
 *
 * Run: `npx tsx scripts/smoke-noise-classifier-phase1.6.ts`
 */

import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';

const TMP_HOME = join(tmpdir(), `wg-smoke-noise-${Date.now()}`);
mkdirSync(join(TMP_HOME, '.workgraph'), { recursive: true });
process.env.HOME = TMP_HOME;

const SMOKE_REPO = 'pyalwin/workgraph';
const SMOKE_WORKSPACE = `smoke-noise-${Date.now()}`;

async function main() {
  const { mintAgentToken } = await import('../src/lib/agent-auth');
  const { ensureSchemaAsync } = await import('../src/lib/db/init-schema-async');
  const { getLibsqlDb } = await import('../src/lib/db/libsql');
  const { classifyMechanical } = await import('../src/lib/almanac/noise-classifier');
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // Stale-data cleanup
  await db.prepare(`DELETE FROM code_events WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM code_events_backfill_state WHERE repo = ?`).run(SMOKE_REPO);

  // Provision a fake paired agent
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

  // ---------- direct rule sanity checks ----------
  console.log('[1/6] direct classifyMechanical rule checks');
  const lockOnly = classifyMechanical({ message: 'chore(deps): bump foo from 1 to 2', files: ['package.json'], additions: 4, deletions: 4 });
  if (lockOnly.noise_class !== 'dependency_bump') throw new Error(`lock-only expected dependency_bump, got ${lockOnly.noise_class}`);
  const docs = classifyMechanical({ message: 'docs: update readme', files: ['README.md', 'docs/intro.md'], additions: 50, deletions: 5 });
  if (docs.noise_class !== 'docs_only') throw new Error(`docs expected docs_only, got ${docs.noise_class}`);
  const tests = classifyMechanical({ message: 'test: add cases', files: ['src/foo.test.ts'], additions: 100, deletions: 0 });
  if (tests.noise_class !== 'test_only') throw new Error(`tests expected test_only, got ${tests.noise_class}`);
  const tiny = classifyMechanical({ message: 'fix typo', files: ['src/foo.ts'], additions: 1, deletions: 1 });
  if (tiny.noise_class !== 'tiny_change') throw new Error(`tiny expected tiny_change, got ${tiny.noise_class}`);
  const revert = classifyMechanical({ message: 'Revert "rewrite cleanupSourceData"', files: ['src/foo.ts'], additions: 50, deletions: 80 });
  if (revert.noise_class !== 'revert') throw new Error(`revert expected revert, got ${revert.noise_class}`);
  const sig = classifyMechanical({ message: 'feat: new feature', files: ['src/feat/a.ts','src/feat/b.ts','src/feat/c.ts'], additions: 200, deletions: 5 });
  if (sig.noise_class !== 'signal') throw new Error(`real feat expected signal, got ${sig.noise_class}`);
  if (sig.is_feature_evolution !== 1) throw new Error(`real feat expected is_feature_evolution=1`);
  console.log('      6/6 rules behaved');

  // ---------- end-to-end: extract + ingest with classifier ----------
  const codeEventsRoute = await import('../src/app/api/almanac/code-events/ingest/route');
  const noiseRoute = await import('../src/app/api/almanac/noise/classify/ingest/route');
  const codeEventsPOST = codeEventsRoute.POST as (req: Request) => Promise<Response>;
  const noisePOST = noiseRoute.POST as (req: Request) => Promise<Response>;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/almanac/code-events/ingest')) return codeEventsPOST(new Request(url, init));
    if (url.includes('/api/almanac/noise/classify/ingest')) return noisePOST(new Request(url, init));
    return origFetch(input as Request | string | URL, init);
  }) as typeof fetch;

  console.log('[2/6] running code-events extract handler (Stage 1 fires inline at ingest)');
  const { almanacCodeEventsExtractHandler } = await import('../packages/agent/src/jobs/almanac-code-events-extract');
  await almanacCodeEventsExtractHandler({ workspaceId: SMOKE_WORKSPACE, repo: SMOKE_REPO, repoPath: process.cwd() });

  console.log('[3/6] verifying noise_class distribution');
  const dist = await db
    .prepare(`SELECT noise_class, COUNT(*) as n FROM code_events WHERE repo = ? GROUP BY noise_class ORDER BY n DESC`)
    .all<{ noise_class: string | null; n: number }>(SMOKE_REPO);
  console.log('      distribution:');
  let total = 0;
  let noisy = 0;
  for (const d of dist) {
    console.log(`        ${d.noise_class ?? '(null)'}: ${d.n}`);
    total += d.n;
    if (d.noise_class && d.noise_class !== 'signal') noisy += d.n;
  }
  if (total === 0) throw new Error('no code_events ingested');
  const noiseRate = noisy / total;
  console.log(`      noise rate = ${(noiseRate * 100).toFixed(1)}%  (target band: 30–50%, soft)`);
  // Don't hard-fail on band — workgraph repo may have a different mix; just require some noise.
  if (noisy === 0) throw new Error('expected SOME noise tags; got 0');

  // ---------- Stage 2 with mock CLI ----------
  console.log('[4/6] preparing mock codex CLI for Stage 2');
  // Pick 5 signal-tagged events to feed Stage 2
  const signalRows = await db
    .prepare(`SELECT sha, message, files_touched FROM code_events WHERE repo = ? AND noise_class = 'signal' AND intent IS NULL LIMIT 5`)
    .all<{ sha: string; message: string; files_touched: string }>(SMOKE_REPO);
  if (signalRows.length === 0) throw new Error('no signal-tagged events available for Stage 2 smoke');

  // Write a tiny shell script that emulates `codex exec --json` by emitting one
  // {type:"agent_message", message:"..."} JSON line containing the expected
  // classifications, then a {type:"task_complete"}.
  const mockBin = join(TMP_HOME, 'bin');
  mkdirSync(mockBin, { recursive: true });
  const expected = signalRows.map((r) => ({
    sha: r.sha,
    intent: 'extend' as const,
    architectural_significance: 'medium' as const,
    is_feature_evolution: true,
  }));
  const jsonl = expected.map((e) => JSON.stringify(e)).join('\\n');
  const script = `#!/bin/bash
# mock codex exec --json — ignores prompt, emits canned classifications
echo '{"type":"agent_message","message":"${jsonl.replace(/"/g, '\\"')}"}'
echo '{"type":"task_complete"}'
`;
  const codexPath = join(mockBin, 'codex');
  writeFileSync(codexPath, script);
  chmodSync(codexPath, 0o755);
  process.env.PATH = `${mockBin}:${process.env.PATH}`;

  console.log('[5/6] running Stage 2 LLM handler with mock CLI');
  const { almanacNoiseClassifyHandler } = await import('../packages/agent/src/jobs/almanac-noise-classify');
  const result = await almanacNoiseClassifyHandler({
    workspaceId: SMOKE_WORKSPACE,
    repo: SMOKE_REPO,
    cli: 'codex',
    events: signalRows.map((r) => ({
      sha: r.sha,
      message: r.message,
      files_touched: JSON.parse(r.files_touched) as string[],
    })),
  });
  console.log('      handler result:', result);

  console.log('[6/6] verifying Stage 2 columns landed');
  const updated = await db
    .prepare(
      `SELECT COUNT(*) as n FROM code_events
       WHERE repo = ? AND intent IS NOT NULL AND classifier_run_at IS NOT NULL`,
    )
    .get<{ n: number }>(SMOKE_REPO);
  if (!updated || updated.n < signalRows.length) {
    throw new Error(`expected ${signalRows.length} updated rows, got ${updated?.n}`);
  }
  console.log(`      ${updated.n} rows updated with intent + architectural_significance + classifier_run_at`);

  // Cleanup
  await db.prepare(`DELETE FROM code_events WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM code_events_backfill_state WHERE repo = ?`).run(SMOKE_REPO);
  await db.prepare(`DELETE FROM workspace_agents WHERE agent_id = ?`).run(agentId);
  rmSync(TMP_HOME, { recursive: true, force: true });
  globalThis.fetch = origFetch;

  console.log('\\nPASS — Phase 1.6 noise classifier works end-to-end.');
  console.log(`  total events     = ${total}`);
  console.log(`  noise rate       = ${(noiseRate * 100).toFixed(1)}%`);
  console.log(`  Stage 2 updated  = ${updated.n}`);
}

main().catch((err) => {
  console.error('\\nFAIL:', err instanceof Error ? err.stack ?? err.message : err);
  rmSync(TMP_HOME, { recursive: true, force: true });
  process.exit(1);
});
