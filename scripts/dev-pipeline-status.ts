/**
 * Direct DB peek at what the Almanac pipeline has done — no auth required.
 * Run: npx tsx scripts/dev-pipeline-status.ts
 */
import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';
loadEnv({ path: join(process.cwd(), '.env.local') });
loadEnv({ path: join(process.cwd(), '.env') });

async function main() {
  const { ensureSchemaAsync } = await import('../src/lib/db/init-schema-async');
  const { getLibsqlDb } = await import('../src/lib/db/libsql');
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  console.log(`DATABASE_URL=${process.env.DATABASE_URL}\n`);

  // workspace_agents
  const agents = await db.prepare(
    `SELECT agent_id, user_id, workspace_id, status, last_seen_at FROM workspace_agents`,
  ).all<{ agent_id: string; user_id: string; workspace_id: string; status: string; last_seen_at: string | null }>();
  console.log(`workspace_agents (${agents.length}):`);
  for (const a of agents) {
    console.log(`  ${a.agent_id.slice(0, 12)}  user=${a.user_id?.slice(0, 12)}  ws=${a.workspace_id}  status=${a.status}  last_seen=${a.last_seen_at}`);
  }

  // agent_jobs by status
  console.log('\nagent_jobs by status:');
  const jobs = await db.prepare(
    `SELECT status, kind, COUNT(*) as c FROM agent_jobs GROUP BY status, kind ORDER BY status, kind`,
  ).all<{ status: string; kind: string; c: number }>();
  for (const j of jobs) {
    console.log(`  ${j.status.padEnd(10)} ${j.kind.padEnd(40)} ${j.c}`);
  }

  // Recent agent_jobs
  console.log('\nlatest 10 agent_jobs:');
  const recent = await db.prepare(
    `SELECT id, kind, status, created_at, started_at, completed_at,
            substr(coalesce(error, ''), 1, 100) as err
     FROM agent_jobs ORDER BY created_at DESC LIMIT 10`,
  ).all<{ id: string; kind: string; status: string; created_at: string; started_at: string | null; completed_at: string | null; err: string }>();
  for (const r of recent) {
    console.log(`  ${r.id.slice(0, 8)} ${r.kind.padEnd(40)} ${r.status.padEnd(10)} created=${r.created_at} started=${r.started_at ?? '—'} done=${r.completed_at ?? '—'}`);
    if (r.err) console.log(`    err: ${r.err}`);
  }

  // code_events
  const ce = await db.prepare(`SELECT COUNT(*) as c FROM code_events`).get<{ c: number }>();
  console.log(`\ncode_events total: ${ce?.c ?? 0}`);

  // backfill state
  const bf = await db.prepare(
    `SELECT repo, total_events, last_run_at, last_status, substr(coalesce(last_error,''),1,140) as err
     FROM code_events_backfill_state`,
  ).all<{ repo: string; total_events: number | null; last_run_at: string | null; last_status: string | null; err: string }>();
  console.log(`\ncode_events_backfill_state (${bf.length}):`);
  for (const b of bf) {
    console.log(`  ${b.repo}  events=${b.total_events ?? 0}  status=${b.last_status}  ran=${b.last_run_at}`);
    if (b.err) console.log(`    err: ${b.err}`);
  }

  // workspace connectors
  const conn = await db.prepare(
    `SELECT workspace_id, slot, source, status, substr(coalesce(last_error,''),1,120) as err
     FROM workspace_connector_configs LIMIT 20`,
  ).all<{ workspace_id: string; slot: string; source: string; status: string; err: string }>();
  console.log(`\nworkspace_connector_configs (${conn.length}):`);
  for (const c of conn) {
    console.log(`  ws=${c.workspace_id}  slot=${c.slot}  source=${c.source}  status=${c.status}`);
    if (c.err) console.log(`    err: ${c.err}`);
  }

  // GitHub repos linked
  const repos = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%repo%' OR name LIKE '%github%' ORDER BY name`,
  ).all<{ name: string }>();
  console.log(`\nrepo-ish tables: ${repos.map((r) => r.name).join(', ')}`);
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
