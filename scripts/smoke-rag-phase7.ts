/**
 * Phase 7 smoke test — RAG wiring: almanac section chunking + chat tools.
 *
 * Seeds deterministic data, exercises every new function, then cleans up.
 * Embedding step is gracefully skipped if HF_API_KEY is unset.
 *
 * Run: `npx tsx scripts/smoke-rag-phase7.ts`
 */
import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';

loadEnv({ path: join(process.cwd(), '.env.local') });
loadEnv({ path: join(process.cwd(), '.env') });

async function main() {
  const { ensureSchemaAsync } = await import('../src/lib/db/init-schema-async');
  const { getLibsqlDb } = await import('../src/lib/db/libsql');
  const { rechunkAlmanacSection, embedAlmanacSection } = await import('../src/lib/almanac/chunks');
  const { almanacTools } = await import('../src/lib/almanac/chat-tools');

  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // ─── IDs ──────────────────────────────────────────────────────────────────
  const workspaceId = 'smoke-p7-ws';
  const projectKey = 'SMOKEY';
  const unitId = 'smoke-p7-unit-0001';
  const sectionId = 'smoke-p7-section-0001';
  const wiId = 'smoke-p7-wi-0001';
  const jiraKey = 'SMOKEY-1';

  // ─── Cleanup helper ───────────────────────────────────────────────────────
  async function cleanup() {
    // chunk_embeddings_meta has no cascade; delete before item_chunks
    const oldChunks = await db
      .prepare(`SELECT id FROM item_chunks WHERE item_id = ?`)
      .all<{ id: number }>(sectionId);
    if (oldChunks.length > 0) {
      const placeholders = oldChunks.map(() => '?').join(',');
      await db.prepare(`DELETE FROM chunk_embeddings_meta WHERE chunk_id IN (${placeholders})`).run(...oldChunks.map((c) => c.id));
    }
    await db.prepare(`DELETE FROM item_chunks WHERE item_id = ?`).run(sectionId);
    await db.prepare(`DELETE FROM almanac_sections WHERE id = ?`).run(sectionId);
    // Delete synthetic work_items row created by rechunkAlmanacSection
    await db.prepare(`DELETE FROM work_items WHERE id = ? AND source = 'almanac'`).run(sectionId);
    await db.prepare(`DELETE FROM code_events WHERE repo = 'smoke-org/smoke-repo'`).run();
    await db.prepare(`DELETE FROM functional_unit_aliases WHERE unit_id = ?`).run(unitId);
    await db.prepare(`DELETE FROM functional_units WHERE id = ?`).run(unitId);
    await db.prepare(`DELETE FROM work_items WHERE id = ?`).run(wiId);
  }
  await cleanup(); // pre-clean in case a prior run left debris

  // ─── [1] Seed ─────────────────────────────────────────────────────────────
  console.log('[1/7] seeding data...');

  await db
    .prepare(
      `INSERT INTO work_items (id, source, source_id, item_type, title, status, created_at, updated_at, synced_at)
       VALUES (?, 'jira', ?, 'task', 'Smoke ticket for P7', 'done', datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run(wiId, jiraKey);

  await db
    .prepare(
      `INSERT INTO functional_units
         (id, workspace_id, project_key, name, description, status, detected_from, keywords, first_seen_at, last_active_at)
       VALUES (?, ?, ?, 'SmokeAuthService', 'Authentication service unit for phase 7 smoke', 'active',
               'manual', '["auth","login"]', datetime('now'), datetime('now'))`,
    )
    .run(unitId, workspaceId, projectKey);

  await db
    .prepare(`INSERT INTO functional_unit_aliases (unit_id, alias, source) VALUES (?, ?, 'manual')`)
    .run(unitId, 'auth-service');

  const now = new Date().toISOString();
  const filesJson = JSON.stringify(['src/auth/login.ts', 'src/auth/token.ts']);
  // Event 1: linked to ticket
  await db
    .prepare(
      `INSERT INTO code_events
         (workspace_id, repo, sha, kind, author_login, author_email, occurred_at, message,
          files_touched, additions, deletions, functional_unit_id, ticket_link_status, linked_item_id,
          is_feature_evolution, noise_class)
       VALUES (?, 'smoke-org/smoke-repo', 'aaabbb0001', 'commit', 'alice', 'alice@ex.com', ?,
               'feat: add login flow for SMOKEY-1', ?, 10, 2, ?, 'linked', ?, 1, 'signal')`,
    )
    .run(workspaceId, now, filesJson, unitId, wiId);
  // Event 2: unlinked
  await db
    .prepare(
      `INSERT INTO code_events
         (workspace_id, repo, sha, kind, author_login, author_email, occurred_at, message,
          files_touched, additions, deletions, functional_unit_id, ticket_link_status,
          is_feature_evolution, noise_class)
       VALUES (?, 'smoke-org/smoke-repo', 'aaabbb0002', 'commit', 'bob', 'bob@ex.com', ?,
               'refactor: token refresh logic', ?, 5, 1, ?, 'unlinked', 0, 'signal')`,
    )
    .run(workspaceId, now, filesJson, unitId);
  // Event 3: unlinked, is_feature_evolution=1
  await db
    .prepare(
      `INSERT INTO code_events
         (workspace_id, repo, sha, kind, author_login, author_email, occurred_at, message,
          files_touched, additions, deletions, functional_unit_id, ticket_link_status,
          is_feature_evolution, noise_class)
       VALUES (?, 'smoke-org/smoke-repo', 'aaabbb0003', 'commit', 'alice', 'alice@ex.com', ?,
               'feat: MFA support added to auth flow', ?, 30, 0, ?, 'unlinked', 1, 'signal')`,
    )
    .run(workspaceId, now, filesJson, unitId);

  const sectionMarkdown = `
# Authentication Service

This section documents the authentication service functional unit.

It handles login, token refresh, and MFA flows across the platform.

## History

Originally introduced in Q1 2023, the auth service was built to replace the legacy session model.
It now supports OAuth2, JWT tokens with rotating keys, and time-based MFA.

:::diagram:::
graph TD
  A[User] --> B[Login Endpoint]
  B --> C[Token Generator]
:::

## Design Decisions

The team chose JWT over opaque tokens to allow stateless validation at the edge.
Refresh tokens are stored in an HttpOnly cookie and rotated on every use.

## Evolution Notes

The service has grown from a simple username/password flow to a full OAuth2 provider.
Several unlinked refactors were made to improve token expiry handling.
`.repeat(3); // Repeat to push past 2500 chars for multi-chunk test

  await db
    .prepare(
      `INSERT INTO almanac_sections
         (id, workspace_id, project_key, unit_id, kind, anchor, position,
          title, markdown, diagram_blocks, source_hash, generated_at, created_at)
       VALUES (?, ?, ?, ?, 'unit', 'unit-smoke-p7', 0, 'Authentication Service',
               ?, '[]', 'smoke-hash-p7', NULL, datetime('now'))`,
    )
    .run(sectionId, workspaceId, projectKey, unitId, sectionMarkdown);

  console.log('   seeded: unit, 3 code_events, 1 almanac_section');

  // ─── [2] rechunkAlmanacSection ────────────────────────────────────────────
  console.log('[2/7] rechunkAlmanacSection...');
  const { chunkIds } = await rechunkAlmanacSection(sectionId);
  console.log(`   created ${chunkIds.length} chunk(s)`);

  if (chunkIds.length === 0) throw new Error('Expected at least 1 chunk');

  const chunks = await db
    .prepare(`SELECT item_id, chunk_type, chunk_text, metadata FROM item_chunks WHERE id IN (${chunkIds.map(() => '?').join(',')})`)
    .all<{ item_id: string; chunk_type: string; chunk_text: string; metadata: string }>(...chunkIds);

  for (const c of chunks) {
    if (c.item_id !== sectionId) throw new Error(`item_id mismatch: ${c.item_id}`);
    if (c.chunk_type !== 'almanac_section') throw new Error(`chunk_type wrong: ${c.chunk_type}`);
    if (c.chunk_text.includes(':::diagram:::')) throw new Error('diagram fence not stripped!');
    const meta = JSON.parse(c.metadata) as Record<string, unknown>;
    if (meta['section_id'] !== sectionId) throw new Error('metadata.section_id mismatch');
  }
  console.log(`   chunk item_id, chunk_type, diagram stripping, metadata all correct ✓`);

  // Idempotency: re-run should replace chunks (same count, new ids)
  const { chunkIds: chunkIds2 } = await rechunkAlmanacSection(sectionId);
  if (chunkIds2.length !== chunkIds.length)
    throw new Error(`re-chunk count changed: ${chunkIds.length} → ${chunkIds2.length}`);
  console.log(`   re-chunk idempotent (same count ${chunkIds2.length}) ✓`);

  // ─── [3] embedAlmanacSection ──────────────────────────────────────────────
  console.log('[3/7] embedAlmanacSection (skip gracefully if HF API unavailable)...');
  const hfKey = process.env.HF_API_KEY ?? process.env.HUGGINGFACE_API_KEY ?? process.env.HUGGINGFACEHUB_API_TOKEN;
  if (!hfKey) {
    console.warn('   SKIP: HF_API_KEY not set — embedding step skipped (non-blocking)');
  } else {
    try {
      await embedAlmanacSection(sectionId);
      console.log('   embedding completed ✓');
    } catch (err) {
      console.warn(`   WARN: embed failed (${(err as Error).message}) — non-blocking`);
    }
  }

  // Helper: call a tool's execute method
  async function callTool<T extends Record<string, unknown>>(
    toolName: string,
    args: T,
  ): Promise<unknown> {
    const tools = almanacTools as unknown as Record<string, { execute: (a: T, ctx: object) => Promise<unknown> }>;
    const t = tools[toolName];
    if (!t) throw new Error(`Tool not found: ${toolName}`);
    return t.execute(args, {});
  }

  // ─── [4] getFunctionalUnit ────────────────────────────────────────────────
  console.log('[4/7] getFunctionalUnit...');
  const fuByName = await callTool('getFunctionalUnit', { name: 'SmokeAuthService', projectKey }) as Record<string, unknown>;
  if (!fuByName['found']) throw new Error('getFunctionalUnit by name failed');
  const fuUnit = fuByName['unit'] as Record<string, unknown>;
  if (fuUnit['id'] !== unitId) throw new Error('getFunctionalUnit returned wrong unit');
  console.log(`   by name ✓  (id=${fuUnit['id']})`);

  const fuByAlias = await callTool('getFunctionalUnit', { name: 'auth-service', projectKey }) as Record<string, unknown>;
  if (!fuByAlias['found']) throw new Error('getFunctionalUnit by alias failed');
  console.log(`   by alias ✓`);

  const fuById = await callTool('getFunctionalUnit', { id: unitId }) as Record<string, unknown>;
  if (!fuById['found']) throw new Error('getFunctionalUnit by id failed');
  console.log(`   by id ✓`);

  // ─── [5] listUnitEvolution ────────────────────────────────────────────────
  console.log('[5/7] listUnitEvolution...');
  const evo = await callTool('listUnitEvolution', { unitId, granularity: 'month' }) as Record<string, unknown>;
  const buckets = evo['buckets'] as unknown[];
  if (!Array.isArray(buckets)) throw new Error('listUnitEvolution: expected buckets array');
  console.log(`   ${buckets.length} bucket(s) ✓  (total_events=${evo['total_events']})`);

  // ─── [6] getDriftForUnit ──────────────────────────────────────────────────
  console.log('[6/7] getDriftForUnit...');
  const drift = await callTool('getDriftForUnit', { unitId }) as Record<string, unknown>;
  if (typeof drift['unlinked_commit_count'] !== 'number')
    throw new Error('getDriftForUnit: missing unlinked_commit_count');
  if (drift['unlinked_commit_count'] !== 2)
    throw new Error(`getDriftForUnit: expected 2 unlinked, got ${drift['unlinked_commit_count']}`);
  console.log(`   unlinked_commit_count = ${drift['unlinked_commit_count']} ✓`);

  // ─── [7a] findUnitsByFile ─────────────────────────────────────────────────
  console.log('[7a/7] findUnitsByFile...');
  const byFile = await callTool('findUnitsByFile', { path: 'src/auth/login.ts' }) as Record<string, unknown>;
  if (!byFile['found']) throw new Error('findUnitsByFile: expected found=true');
  const fileUnits = byFile['units'] as unknown[];
  if (!Array.isArray(fileUnits) || fileUnits.length === 0) throw new Error('findUnitsByFile: no units returned');
  console.log(`   found ${fileUnits.length} unit(s) for path ✓`);

  // ─── [7b] findUnitsByTicket ───────────────────────────────────────────────
  console.log('[7b/7] findUnitsByTicket...');
  const byTicket = await callTool('findUnitsByTicket', { jiraKey }) as Record<string, unknown>;
  if (!byTicket['found']) throw new Error('findUnitsByTicket: expected found=true');
  const ticketUnits = byTicket['units'] as unknown[];
  if (!Array.isArray(ticketUnits) || ticketUnits.length === 0) throw new Error('findUnitsByTicket: no units returned');
  console.log(`   found ${ticketUnits.length} unit(s) for ${jiraKey} ✓`);

  // ─── [7c] searchCommitHistory ─────────────────────────────────────────────
  console.log('[7c/7] searchCommitHistory...');
  const hist = await callTool('searchCommitHistory', { query: 'login flow', limit: 10 }) as Record<string, unknown>;
  if (typeof hist['count'] !== 'number') throw new Error('searchCommitHistory: missing count');
  if ((hist['count'] as number) < 1) throw new Error('searchCommitHistory: expected >= 1 result');
  console.log(`   found ${hist['count']} commit(s) ✓`);

  // Query sanitisation check
  const bad = await callTool('searchCommitHistory', { query: "'; DROP TABLE code_events; --", limit: 1 }) as Record<string, unknown>;
  if (!bad['error']) throw new Error('searchCommitHistory: expected sanitisation rejection');
  console.log(`   SQL injection rejected ✓`);

  // ─── Cleanup ──────────────────────────────────────────────────────────────
  console.log('[cleanup] removing seeded data...');
  await cleanup();
  console.log('   done');

  console.log('\nPASS — Phase 7 RAG wiring smoke test complete.');
}

main().catch((err) => {
  console.error('\nFAIL:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
