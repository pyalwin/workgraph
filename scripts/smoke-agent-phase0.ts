import { config } from 'dotenv';
import { join } from 'path';

config({ path: join(process.cwd(), '.env.local') });
config({ path: join(process.cwd(), '.env') });

/**
 * Phase 0 smoke test for the local-agent control-plane protocol.
 *
 * Calls the Next.js route handlers directly (in-process), so this works
 * without the dev server and without WorkOS env vars. Exercises:
 *
 *   POST /api/agent/pair/start
 *   POST /api/agent/pair/poll
 *   POST /api/agent/heartbeat
 *   POST /api/agent/jobs/poll
 *   POST /api/agent/jobs/result
 *
 * The browser-side step (`POST /api/agent/pair/confirm` under withAuth) is
 * simulated with a direct DB write — the actual confirm UI is Phase 5.
 *
 * Run: `npx tsx scripts/smoke-agent-phase0.ts`
 */

import { v4 as uuidv4 } from 'uuid';

interface JsonResponse {
  status: number;
  body: unknown;
}

async function callRoute(
  handler: (req: Request) => Promise<Response>,
  url: string,
  init: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<JsonResponse> {
  const req = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const res = await handler(req);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function assertOk(res: JsonResponse, label: string) {
  if (res.status >= 400) {
    throw new Error(`${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
  }
}

async function main() {
  const { getLibsqlDb } = await import('../src/lib/db/libsql');
  const { ensureSchemaAsync } = await import('../src/lib/db/init-schema-async');
  const { mintAgentToken } = await import('../src/lib/agent-auth');

  const pairStart = (await import('../src/app/api/agent/pair/start/route')).POST;
  const pairPoll = (await import('../src/app/api/agent/pair/poll/route')).POST;
  const heartbeat = (await import('../src/app/api/agent/heartbeat/route')).POST;
  const jobsPoll = (await import('../src/app/api/agent/jobs/poll/route')).POST;
  const jobsResult = (await import('../src/app/api/agent/jobs/result/route')).POST;

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  console.log('[1/8] pair/start');
  const start = await callRoute(pairStart, 'http://test.local/api/agent/pair/start');
  assertOk(start, 'pair/start');
  const startBody = start.body as { pairing_id: string; user_code: string; verification_url: string };
  console.log(`      pairing_id=${startBody.pairing_id}  code=${startBody.user_code}`);

  console.log('[2/8] pair/poll (pre-confirm) — expect status:pending');
  const poll1 = await callRoute(pairPoll, 'http://test.local/api/agent/pair/poll', {
    body: { pairing_id: startBody.pairing_id },
  });
  assertOk(poll1, 'pair/poll pre-confirm');
  if ((poll1.body as { status: string }).status !== 'pending') {
    throw new Error(`expected pending, got ${JSON.stringify(poll1.body)}`);
  }

  console.log('[3/8] simulating browser /pair/confirm via direct DB write');
  const userId = `smoke-user-${Date.now()}`;
  const agentId = uuidv4();
  const { token, tokenHash } = mintAgentToken();
  await db
    .prepare(
      `INSERT INTO workspace_agents
       (agent_id, user_id, workspace_id, pairing_token_enc, status, created_at)
       VALUES (?, ?, 'all', ?, 'offline', datetime('now'))`,
    )
    .run(agentId, userId, tokenHash);
  await db
    .prepare(
      `UPDATE agent_pairings
       SET user_id = ?, agent_id = ?, agent_token_enc = ?, status = 'confirmed'
       WHERE pairing_id = ?`,
    )
    .run(userId, agentId, token, startBody.pairing_id);

  console.log('[4/8] pair/poll (post-confirm) — expect confirmed + token');
  const poll2 = await callRoute(pairPoll, 'http://test.local/api/agent/pair/poll', {
    body: { pairing_id: startBody.pairing_id },
  });
  assertOk(poll2, 'pair/poll post-confirm');
  const poll2Body = poll2.body as { status: string; agent_id?: string; agent_token?: string };
  if (poll2Body.status !== 'confirmed' || poll2Body.agent_id !== agentId || poll2Body.agent_token !== token) {
    throw new Error(`unexpected poll2: ${JSON.stringify(poll2Body)}`);
  }

  console.log('[5/8] heartbeat (Bearer)');
  const hb = await callRoute(heartbeat, 'http://test.local/api/agent/heartbeat', {
    headers: { authorization: `Bearer ${token}` },
    body: { hostname: 'smoke.local', platform: 'darwin', version: '0.0.0-smoke' },
  });
  assertOk(hb, 'heartbeat');
  const agentRow = await db
    .prepare(`SELECT status, hostname, last_seen_at FROM workspace_agents WHERE agent_id = ?`)
    .get<{ status: string; hostname: string; last_seen_at: string }>(agentId);
  if (agentRow?.status !== 'online' || agentRow.hostname !== 'smoke.local') {
    throw new Error(`heartbeat did not update agent row: ${JSON.stringify(agentRow)}`);
  }

  console.log('[6/8] enqueue noop job server-side');
  const jobId = uuidv4();
  await db
    .prepare(
      `INSERT INTO agent_jobs (id, agent_id, kind, params, status)
       VALUES (?, ?, 'noop', ?, 'queued')`,
    )
    .run(jobId, agentId, JSON.stringify({ hello: 'world' }));

  console.log('[7/8] jobs/poll — expect to claim the noop job');
  const polled = await callRoute(jobsPoll, 'http://test.local/api/agent/jobs/poll', {
    headers: { authorization: `Bearer ${token}` },
    body: { wait_ms: 5000 },
  });
  assertOk(polled, 'jobs/poll');
  const polledBody = polled.body as {
    job: { id: string; kind: string; params: unknown; attempt: number } | null;
  };
  if (!polledBody.job || polledBody.job.id !== jobId) {
    throw new Error(`did not claim job: ${JSON.stringify(polledBody)}`);
  }
  if (polledBody.job.kind !== 'noop' || polledBody.job.attempt !== 1) {
    throw new Error(`unexpected job shape: ${JSON.stringify(polledBody.job)}`);
  }

  console.log('[8/8] jobs/result — done');
  const done = await callRoute(jobsResult, 'http://test.local/api/agent/jobs/result', {
    headers: { authorization: `Bearer ${token}` },
    body: { job_id: jobId, status: 'done', result: { echo: polledBody.job.params } },
  });
  assertOk(done, 'jobs/result');
  const finalRow = await db
    .prepare(`SELECT status, result, completed_at FROM agent_jobs WHERE id = ?`)
    .get<{ status: string; result: string; completed_at: string }>(jobId);
  if (finalRow?.status !== 'done' || !finalRow.completed_at) {
    throw new Error(`job not marked done: ${JSON.stringify(finalRow)}`);
  }

  // Cleanup so the smoke test is repeatable.
  await db.prepare(`DELETE FROM agent_jobs WHERE id = ?`).run(jobId);
  await db.prepare(`DELETE FROM workspace_agents WHERE agent_id = ?`).run(agentId);
  await db.prepare(`DELETE FROM agent_pairings WHERE pairing_id = ?`).run(startBody.pairing_id);

  console.log('\nPASS — Phase 0 wire protocol works end-to-end.');
  console.log(`  agent_id     = ${agentId}`);
  console.log(`  job_id       = ${jobId}  status=${finalRow.status}`);
  console.log(`  agent.status = ${agentRow.status}  last_seen_at=${agentRow.last_seen_at}`);
}

main().catch((err) => {
  console.error('\nFAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
