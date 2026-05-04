/**
 * Almanac · sync phase helpers
 *
 * Library functions that mirror what each Inngest cron function does.
 * Used by /api/admin/almanac/sync-all to drive the pipeline inline,
 * bypassing Inngest event dispatch (which is flaky in dev when the
 * dev-server / app start in different orders).
 *
 * The Inngest cron functions still exist for prod scheduling — they
 * delegate to these helpers (or duplicate the logic for now).
 */
import { v4 as uuidv4 } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { getConnectorConfigBySource } from '@/lib/connectors/config-store';
import { resolveAgentForWorkspace } from '@/lib/almanac/agent-resolver';

interface RepoEntry {
  id: string;
}

interface BackfillCursor {
  last_sha: string | null;
  last_occurred_at: string | null;
}

interface PhaseEnqueueResult {
  ok: boolean;
  reason?: string;
  workspaceId: string;
  agent_id?: string;
  repos?: number;
  enqueued?: number;
  skipped_existing?: number;
}

interface PendingEvent {
  id: string;
  sha: string;
  message: string | null;
  files_touched: string;
}

const NOISE_BATCH_SIZE = 50;

async function listRepos(workspaceId: string, filterRepo?: string): Promise<RepoEntry[]> {
  const cfg = await getConnectorConfigBySource(workspaceId, 'github');
  if (!cfg) return [];
  // Connector OAuth flow stores repos in two places that have evolved at
  // different times:
  //   - options.repos              — array of strings (selected repos)
  //   - options.discovered.repos   — array of { id, label, hint } (catalog)
  // Either may be present. Selected (options.repos) takes precedence; we fall
  // back to discovered. Normalise both into { id: string }.
  const opts = cfg.config.options as
    | {
        repos?: (string | { id?: string })[];
        discovered?: { repos?: (string | { id?: string })[] };
      }
    | undefined;
  const raw = opts?.repos ?? opts?.discovered?.repos ?? [];
  const all: RepoEntry[] = raw
    .map((r) => (typeof r === 'string' ? { id: r } : r?.id ? { id: r.id } : null))
    .filter((r): r is RepoEntry => r !== null);
  return filterRepo ? all.filter((r) => r.id === filterRepo) : all;
}

/**
 * Phase 1 — enqueue code-events.extract + file-lifecycle.extract jobs
 * for every repo in the workspace's GitHub connector. Idempotent per
 * (agent_id, idempotency_key): re-running the same calendar day inserts
 * 0 new rows.
 */
export async function enqueueBackfill(
  workspaceId: string,
  opts: { repo?: string } = {},
): Promise<PhaseEnqueueResult> {
  await ensureSchemaAsync();
  const repos = await listRepos(workspaceId, opts.repo);
  if (repos.length === 0) return { ok: true, reason: 'no_repos', workspaceId, repos: 0, enqueued: 0 };

  const agentId = await resolveAgentForWorkspace(workspaceId);
  if (!agentId) return { ok: false, reason: 'no_online_agent', workspaceId };

  const db = getLibsqlDb();
  const today = new Date().toISOString().slice(0, 10);
  let enqueued = 0;

  for (const repo of repos) {
    // read cursor
    const cursor = (await db
      .prepare(`SELECT last_sha, last_occurred_at FROM code_events_backfill_state WHERE repo = ?`)
      .get<BackfillCursor>(repo.id)) ?? { last_sha: null, last_occurred_at: null };

    const ceParams = {
      workspaceId,
      repo: repo.id,
      repoPath: null,
      sinceIso: cursor.last_occurred_at,
      branch: 'main',
    };
    const ceResult = await db
      .prepare(
        `INSERT OR IGNORE INTO agent_jobs (id, agent_id, kind, params, status, idempotency_key, created_at)
         VALUES (?, ?, 'almanac.code-events.extract', ?, 'queued', ?, datetime('now'))`,
      )
      .run(uuidv4(), agentId, JSON.stringify(ceParams), `almanac-code-events-${repo.id}-${today}`);
    if ((ceResult.changes ?? 0) > 0) enqueued++;

    const flParams = { workspaceId, repo: repo.id, repoPath: null, branch: 'main' };
    const flResult = await db
      .prepare(
        `INSERT OR IGNORE INTO agent_jobs (id, agent_id, kind, params, status, idempotency_key, created_at)
         VALUES (?, ?, 'almanac.file-lifecycle.extract', ?, 'queued', ?, datetime('now'))`,
      )
      .run(uuidv4(), agentId, JSON.stringify(flParams), `almanac-file-lifecycle-${repo.id}-${today}`);
    if ((flResult.changes ?? 0) > 0) enqueued++;
  }

  return {
    ok: true,
    workspaceId,
    agent_id: agentId,
    repos: repos.length,
    enqueued,
    skipped_existing: repos.length * 2 - enqueued,
  };
}

/**
 * Phase 1.6 — enqueue noise-classify jobs for batches of pending events
 * (signal events whose intent column is still NULL).
 */
export async function enqueueNoiseClassify(
  workspaceId: string,
  opts: { repo?: string; cli?: string; model?: string } = {},
): Promise<PhaseEnqueueResult> {
  await ensureSchemaAsync();
  const repos = await listRepos(workspaceId, opts.repo);
  if (repos.length === 0) return { ok: true, reason: 'no_repos', workspaceId, repos: 0, enqueued: 0 };

  const agentId = await resolveAgentForWorkspace(workspaceId);
  if (!agentId) return { ok: false, reason: 'no_online_agent', workspaceId };

  const db = getLibsqlDb();
  const today = new Date().toISOString().slice(0, 10);
  let enqueued = 0;

  for (const repo of repos) {
    const pending = await db
      .prepare(
        `SELECT id, sha, message, files_touched FROM code_events
         WHERE workspace_id = ? AND repo = ?
           AND noise_class = 'signal' AND intent IS NULL
         ORDER BY occurred_at ASC
         LIMIT ?`,
      )
      .all<PendingEvent>(workspaceId, repo.id, NOISE_BATCH_SIZE * 4);

    for (let i = 0; i < pending.length; i += NOISE_BATCH_SIZE) {
      const batch = pending.slice(i, i + NOISE_BATCH_SIZE);
      const params = {
        workspaceId,
        repo: repo.id,
        cli: opts.cli ?? 'codex',
        model: opts.model ?? null,
        events: batch.map((e) => ({
          id: e.id,
          sha: e.sha,
          message: e.message ?? '',
          files_touched: e.files_touched,
        })),
      };
      const idemKey = `almanac-noise-classify-${repo.id}-${today}-batch${Math.floor(i / NOISE_BATCH_SIZE)}`;
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO agent_jobs (id, agent_id, kind, params, status, idempotency_key, created_at)
           VALUES (?, ?, 'almanac.noise.classify', ?, 'queued', ?, datetime('now'))`,
        )
        .run(uuidv4(), agentId, JSON.stringify(params), idemKey);
      if ((result.changes ?? 0) > 0) enqueued++;
    }
  }

  return { ok: true, workspaceId, agent_id: agentId, repos: repos.length, enqueued };
}

/**
 * Phase 2 — server-side module detection (instant) + enqueue cluster job
 * per repo + naming jobs for unnamed units. Returns the union of inserts.
 */
export async function runDetectUnits(
  workspaceId: string,
  opts: { repo?: string; cli?: string; model?: string } = {},
): Promise<PhaseEnqueueResult & { modules_upserted?: number; epic_aliases_seeded?: number }> {
  await ensureSchemaAsync();
  const { detectModulesForRepo } = await import('@/lib/almanac/module-detector');
  const { seedJiraEpicAliases } = await import('@/lib/almanac/jira-epic-aliases');

  const repos = await listRepos(workspaceId, opts.repo);
  if (repos.length === 0) return { ok: true, reason: 'no_repos', workspaceId, repos: 0, enqueued: 0 };

  const agentId = await resolveAgentForWorkspace(workspaceId);
  // detectModules + seed aliases run server-side regardless of agent presence
  let modulesUpserted = 0;
  for (const r of repos) {
    const result = await detectModulesForRepo(workspaceId, r.id);
    modulesUpserted += result.modules_upserted;
  }
  const epicAliasResult = await seedJiraEpicAliases(workspaceId, null);

  if (!agentId) {
    return {
      ok: false,
      reason: 'no_online_agent',
      workspaceId,
      repos: repos.length,
      modules_upserted: modulesUpserted,
      epic_aliases_seeded: epicAliasResult.aliased,
    };
  }

  const db = getLibsqlDb();
  const today = new Date().toISOString().slice(0, 10);
  let enqueued = 0;

  for (const repo of repos) {
    const params = { workspaceId, repo: repo.id };
    const idemKey = `almanac-units-cluster-${repo.id}-${today}`;
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO agent_jobs (id, agent_id, kind, params, status, idempotency_key, created_at)
         VALUES (?, ?, 'almanac.units.cluster', ?, 'queued', ?, datetime('now'))`,
      )
      .run(uuidv4(), agentId, JSON.stringify(params), idemKey);
    if ((result.changes ?? 0) > 0) enqueued++;
  }

  return {
    ok: true,
    workspaceId,
    agent_id: agentId,
    repos: repos.length,
    enqueued,
    modules_upserted: modulesUpserted,
    epic_aliases_seeded: epicAliasResult.aliased,
  };
}
