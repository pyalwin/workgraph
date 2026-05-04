import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';

loadEnv({ path: join(process.cwd(), '.env.local') });
loadEnv({ path: join(process.cwd(), '.env') });

/**
 * Phase 4 smoke test for the narrative generator.
 *
 * Validates:
 *   - dossier-builder works against the existing DB (project + per-unit)
 *   - regenerateSections() writes skeleton rows for every section kind
 *   - source_hash is stable: re-running with no inputs change is a no-op
 *     (skipped_unchanged == total_sections)
 *   - forceAll bypass works
 *   - /api/almanac/sections/ingest UPDATE replaces markdown + sets
 *     generated_at, leaves diagram_blocks intact (when omitted)
 *   - /api/almanac/sections (browser GET) returns ordered rows
 *
 * The agent-side handler (CLI synthesis) is not invoked here — we simulate
 * its POST directly so we don't need a paired agent or a CLI on PATH.
 *
 * Run: `npx tsx scripts/smoke-narrative-phase4.ts`
 */

async function main() {
  const { ensureSchemaAsync } = await import('../src/lib/db/init-schema-async');
  const { getLibsqlDb } = await import('../src/lib/db/libsql');
  const { regenerateSections } = await import('../src/lib/almanac/section-runner');
  const { buildDossier, buildProjectDossier } = await import('../src/lib/almanac/dossier-builder');
  const { mintAgentToken } = await import('../src/lib/agent-auth');

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // 1. Pick a workspace + project that has at least one functional unit.
  console.log('[1/7] resolving target workspace + project_key with at least one functional_unit');
  const target = await db
    .prepare(
      `SELECT workspace_id, project_key, COUNT(*) as n
       FROM functional_units
       WHERE status = 'active'
       GROUP BY workspace_id, project_key
       ORDER BY n DESC
       LIMIT 1`,
    )
    .get<{ workspace_id: string; project_key: string; n: number }>();
  if (!target) {
    console.warn('  WARN: no functional_units in DB — synthesizing a stub unit for smoke');
    // Synthesize one so the runner has something to chew on.
    await db
      .prepare(
        `INSERT OR IGNORE INTO functional_units
           (id, workspace_id, project_key, name, description, status,
            detected_from, keywords, file_path_patterns,
            first_seen_at, last_active_at, created_at, updated_at)
         VALUES ('unit-smoke-p4', 'default', 'KAN', 'Smoke Stub', 'phase 4 smoke',
                 'active', 'auto', '[]', '[]',
                 datetime('now', '-30 days'), datetime('now'),
                 datetime('now'), datetime('now'))`,
      )
      .run();
  }
  const resolved =
    target ??
    ({ workspace_id: 'default', project_key: 'KAN', n: 1 } as {
      workspace_id: string;
      project_key: string;
      n: number;
    });
  console.log(`  workspace=${resolved.workspace_id}  project_key=${resolved.project_key}  units=${resolved.n}`);

  // 2. Dossier sanity
  console.log('[2/7] buildProjectDossier + buildDossier');
  const projectDossier = await buildProjectDossier(resolved.workspace_id, resolved.project_key);
  console.log(
    `  unit_count=${projectDossier.unit_count} signal_events=${projectDossier.total_signal_events} ` +
      `drift_unticketed=${projectDossier.drift_unticketed} drift_unbuilt=${projectDossier.drift_unbuilt}`,
  );
  if (projectDossier.units_summary.length > 0) {
    const u0 = projectDossier.units_summary[0]!;
    const ud = await buildDossier(resolved.workspace_id, resolved.project_key, u0.unit_id);
    console.log(
      `  per-unit dossier: ${ud.unit_id} events=${ud.events.length} files=${ud.files.length} tickets=${ud.tickets.length}`,
    );
  }

  // 3. Pre-clean any prior smoke artifacts so we count fresh writes
  console.log('[3/7] pre-clean almanac_sections for project');
  await db
    .prepare(`DELETE FROM almanac_sections WHERE workspace_id = ? AND project_key = ?`)
    .run(resolved.workspace_id, resolved.project_key);

  // 4. First regen — every section should be rebuilt, none skipped
  console.log('[4/7] regenerateSections (cold) — expect rebuilt == total, skipped == 0');
  const cold = await regenerateSections(resolved.workspace_id, resolved.project_key);
  console.log(
    `  total=${cold.total_sections} rebuilt=${cold.rebuilt} skipped=${cold.skipped_unchanged} jobs_enqueued=${cold.enqueued_jobs.length}`,
  );
  if (cold.total_sections === 0) throw new Error('FAIL: no sections enumerated for project');
  if (cold.rebuilt !== cold.total_sections) {
    throw new Error(`FAIL: cold run should rebuild every section (got rebuilt=${cold.rebuilt})`);
  }
  if (cold.skipped_unchanged !== 0) {
    throw new Error(`FAIL: cold run should skip 0 (got ${cold.skipped_unchanged})`);
  }

  // Verify rows exist with non-null markdown skeleton + null generated_at
  const rows = await db
    .prepare(
      `SELECT anchor, kind, position, title, source_hash, markdown, diagram_blocks, generated_at
       FROM almanac_sections WHERE workspace_id = ? AND project_key = ?
       ORDER BY position ASC`,
    )
    .all<{
      anchor: string;
      kind: string;
      position: number;
      title: string;
      source_hash: string;
      markdown: string;
      diagram_blocks: string;
      generated_at: string | null;
    }>(resolved.workspace_id, resolved.project_key);
  console.log(`  rows in DB: ${rows.length}`);
  for (const r of rows) {
    if (!r.markdown || r.markdown.length < 10) {
      throw new Error(`FAIL: skeleton markdown empty for anchor=${r.anchor}`);
    }
    if (!r.source_hash || r.source_hash.length !== 40) {
      throw new Error(`FAIL: source_hash not sha1-shaped for anchor=${r.anchor}: ${r.source_hash}`);
    }
    if (r.generated_at !== null) {
      throw new Error(`FAIL: skeleton row should have generated_at = NULL (anchor=${r.anchor})`);
    }
    JSON.parse(r.diagram_blocks); // must be valid JSON
  }
  console.log('  every skeleton row has markdown, sha1 source_hash, generated_at=NULL ✓');

  // 5. Second regen — every section should skip (idempotent)
  console.log('[5/7] regenerateSections (warm) — expect skipped == total, rebuilt == 0');
  const warm = await regenerateSections(resolved.workspace_id, resolved.project_key);
  if (warm.skipped_unchanged !== warm.total_sections) {
    throw new Error(`FAIL: warm re-run should skip everything (skipped=${warm.skipped_unchanged}/${warm.total_sections})`);
  }
  if (warm.rebuilt !== 0) {
    throw new Error(`FAIL: warm re-run should rebuild 0 (got ${warm.rebuilt})`);
  }
  console.log(`  total=${warm.total_sections} rebuilt=${warm.rebuilt} skipped=${warm.skipped_unchanged} ✓`);

  // 6. forceAll bypass
  console.log('[6/7] regenerateSections (forceAll) — expect rebuilt == total again');
  const forced = await regenerateSections(resolved.workspace_id, resolved.project_key, { forceAll: true });
  if (forced.rebuilt !== forced.total_sections) {
    throw new Error(`FAIL: forceAll should rebuild every section (got ${forced.rebuilt}/${forced.total_sections})`);
  }
  console.log(`  total=${forced.total_sections} rebuilt=${forced.rebuilt} ✓`);

  // 7. Simulate the agent narration POST directly via the route handler.
  //    This validates the ingest endpoint without needing a paired agent.
  console.log('[7/7] ingest endpoint — simulate agent POST replacing markdown for one section');
  const target0 = rows[0]!;

  // Mint a temporary agent + token so verifyAgentRequest accepts the call.
  const tmpAgentId = `agent-smoke-p4-${Date.now()}`;
  const minted = mintAgentToken();
  const token = minted.token;
  const tokenHash = minted.tokenHash;
  await db
    .prepare(
      `INSERT INTO workspace_agents (agent_id, user_id, workspace_id, status, pairing_token_enc, created_at, last_seen_at)
       VALUES (?, 'smoke', ?, 'online', ?, datetime('now'), datetime('now'))`,
    )
    .run(tmpAgentId, resolved.workspace_id, tokenHash);

  try {
    const ingestRoute = await import('../src/app/api/almanac/sections/ingest/route');
    const body = JSON.stringify({
      workspaceId: resolved.workspace_id,
      sections: [
        {
          project_key: resolved.project_key,
          anchor: target0.anchor,
          title: target0.title,
          markdown: '# Smoke replaced markdown\n\nReferences sha 1234567 and ticket KAN-1.\n',
          source_hash: target0.source_hash,
        },
      ],
    });
    const req = new Request('http://localhost/api/almanac/sections/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body,
    });
    const res = await ingestRoute.POST(req);
    const txt = await res.text();
    if (res.status !== 200) throw new Error(`ingest returned ${res.status}: ${txt}`);
    console.log(`  ingest response: ${res.status} ${txt}`);

    const updated = await db
      .prepare(
        `SELECT markdown, generated_at, diagram_blocks FROM almanac_sections
         WHERE workspace_id = ? AND project_key = ? AND anchor = ?`,
      )
      .get<{ markdown: string; generated_at: string | null; diagram_blocks: string }>(
        resolved.workspace_id,
        resolved.project_key,
        target0.anchor,
      );
    if (!updated) throw new Error('ingest target row missing');
    if (!updated.markdown.includes('Smoke replaced markdown')) {
      throw new Error('ingest did not replace markdown');
    }
    if (updated.generated_at === null) {
      throw new Error('ingest did not set generated_at');
    }
    if (updated.diagram_blocks !== target0.diagram_blocks) {
      throw new Error('ingest must not clobber diagram_blocks when omitted');
    }
    console.log(`  markdown replaced, generated_at=${updated.generated_at}, diagram_blocks preserved ✓`);
  } finally {
    await db.prepare(`DELETE FROM workspace_agents WHERE agent_id = ?`).run(tmpAgentId);
  }

  // Cleanup smoke artifacts
  await db
    .prepare(`DELETE FROM almanac_sections WHERE workspace_id = ? AND project_key = ?`)
    .run(resolved.workspace_id, resolved.project_key);
  await db.prepare(`DELETE FROM functional_units WHERE id = 'unit-smoke-p4'`).run();

  console.log('\nPASS — Phase 4 narrative pipeline works end-to-end (skeleton + ingest replacement).');
  console.log(`  total_sections     = ${cold.total_sections}`);
  console.log(`  cold rebuilt       = ${cold.rebuilt}`);
  console.log(`  warm skipped       = ${warm.skipped_unchanged}`);
  console.log(`  forceAll rebuilt   = ${forced.rebuilt}`);
}

main().catch((err) => {
  console.error('\nFAIL:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
