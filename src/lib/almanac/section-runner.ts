/**
 * Almanac · Section Runner (Phase 4 — KAN-46)
 *
 * Orchestrates per-project section regeneration:
 *   1. Build project + unit dossiers.
 *   2. For each section kind, compute source_hash from deterministic inputs.
 *   3. Skip sections whose hash hasn't changed (unless forceAll/forceUnits).
 *   4. Write deterministic skeleton markdown + diagram_blocks immediately.
 *      This means Phase 5 UI can render something even before narration.
 *   5. Enqueue almanac.section.narrate agent_job per changed section.
 *      The agent picks up the job, runs LLM CLI, and POSTs to
 *      /api/almanac/sections/ingest which replaces only the `markdown` column.
 *
 * Idempotency: idempotency_key = `${anchor}:${source_hash}` so re-running
 * the runner never double-queues the same work.
 *
 * If no agent is online, skeletons are stored and jobs are skipped (logged).
 * The Inngest function retrying later will pick up the agent once it comes online.
 */
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { buildDossier, buildProjectDossier } from './dossier-builder';
import { rechunkAlmanacSection } from './chunks';
import { buildCoverSection, sourcehash } from './sections/cover';
import { buildSummarySection } from './sections/summary';
import { buildUnitSection } from './sections/unit';
import { buildDriftUnticketedSection } from './sections/drift-unticketed';
import { buildDriftUnbuiltSection } from './sections/drift-unbuilt';
import { buildDecisionsSection } from './sections/decisions';
import { buildAppendixSection } from './sections/appendix';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RegenerateOptions {
  forceUnits?: string[];
  forceAll?: boolean;
  cli?: 'codex' | 'claude' | 'gemini';
  model?: string;
}

export interface RegenerateSummary {
  total_sections: number;
  rebuilt: number;
  skipped_unchanged: number;
  enqueued_jobs: string[];
}

interface ExistingSection {
  source_hash: string;
}

interface AgentRow {
  agent_id: string;
}

interface UnitRow {
  id: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeHash(inputs: unknown): string {
  return crypto.createHash('sha1').update(JSON.stringify(inputs)).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ─── regenerateSections ───────────────────────────────────────────────────────

export async function regenerateSections(
  workspaceId: string,
  projectKey: string,
  opts?: RegenerateOptions,
): Promise<RegenerateSummary> {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  // Resolve active agent (optional — skeletons write regardless)
  const agentRow = await db
    .prepare(
      `SELECT agent_id FROM workspace_agents
       WHERE workspace_id = ? AND status = 'online'
       ORDER BY last_seen_at DESC
       LIMIT 1`,
    )
    .get<AgentRow>(workspaceId);
  const agentId = agentRow?.agent_id ?? null;
  if (!agentId) {
    console.warn(
      `[section-runner] No online agent for workspace ${workspaceId}. ` +
        `Skeleton sections will be stored but narration jobs will be skipped.`,
    );
  }

  // Build project dossier
  const projectDossier = await buildProjectDossier(workspaceId, projectKey);

  // Enumerate unit IDs for this project
  const unitRows = await db
    .prepare(
      `SELECT id FROM functional_units
       WHERE workspace_id = ? AND project_key = ? AND status = 'active'`,
    )
    .all<UnitRow>(workspaceId, projectKey);

  // Enumerate all target sections
  interface SectionSpec {
    kind: string;
    anchor: string;
    position: number;
    unit_id: string | null;
    buildFn: () => Promise<{ title: string; markdown: string; diagram_blocks: unknown[]; source_hash_inputs: unknown }>;
  }

  const specs: SectionSpec[] = [
    {
      kind: 'cover',
      anchor: 'cover',
      position: 0,
      unit_id: null,
      buildFn: async () => buildCoverSection(projectDossier),
    },
    {
      kind: 'summary',
      anchor: 'summary',
      position: 1,
      unit_id: null,
      buildFn: async () => buildSummarySection(projectDossier),
    },
    // One section per functional unit
    ...unitRows.map((u, i): SectionSpec => ({
      kind: 'unit',
      anchor: `unit-${u.id}`,
      position: 2 + i,
      unit_id: u.id,
      buildFn: async () => {
        const dossier = await buildDossier(workspaceId, projectKey, u.id);
        return buildUnitSection(dossier);
      },
    })),
    {
      kind: 'drift_unticketed',
      anchor: 'drift-unticketed',
      position: 2 + unitRows.length,
      unit_id: null,
      buildFn: async () => buildDriftUnticketedSection(workspaceId, projectKey, projectDossier),
    },
    {
      kind: 'drift_unbuilt',
      anchor: 'drift-unbuilt',
      position: 3 + unitRows.length,
      unit_id: null,
      buildFn: async () => buildDriftUnbuiltSection(workspaceId, projectKey, projectDossier),
    },
    {
      kind: 'decisions',
      anchor: 'decisions',
      position: 4 + unitRows.length,
      unit_id: null,
      buildFn: async () => buildDecisionsSection(projectDossier),
    },
    {
      kind: 'appendix',
      anchor: 'appendix',
      position: 5 + unitRows.length,
      unit_id: null,
      buildFn: async () => buildAppendixSection(workspaceId, projectKey, projectDossier),
    },
  ];

  let rebuilt = 0;
  let skippedUnchanged = 0;
  const enqueuedJobs: string[] = [];

  for (const spec of specs) {
    // Build the deterministic section output
    const output = await spec.buildFn();
    const newHash = computeHash(output.source_hash_inputs);

    // Check if this section needs rebuilding
    const existing = await db
      .prepare(
        `SELECT source_hash FROM almanac_sections
         WHERE project_key = ? AND anchor = ?`,
      )
      .get<ExistingSection>(projectKey, spec.anchor);

    const forceThis =
      opts?.forceAll === true ||
      (spec.unit_id !== null && (opts?.forceUnits ?? []).includes(spec.unit_id));

    if (existing && existing.source_hash === newHash && !forceThis) {
      skippedUnchanged++;
      continue;
    }

    // Upsert the skeleton row immediately (generated_at = null = skeleton).
    // The agent narration job will UPDATE markdown + set generated_at when done.
    await db
      .prepare(
        `INSERT INTO almanac_sections
           (id, workspace_id, project_key, unit_id, kind, anchor, position,
            title, markdown, diagram_blocks, source_hash, generated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))
         ON CONFLICT(project_key, anchor) DO UPDATE SET
           unit_id        = excluded.unit_id,
           kind           = excluded.kind,
           position       = excluded.position,
           title          = excluded.title,
           markdown       = excluded.markdown,
           diagram_blocks = excluded.diagram_blocks,
           source_hash    = excluded.source_hash,
           generated_at   = NULL`,
      )
      .run(
        uuidv4(),
        workspaceId,
        projectKey,
        spec.unit_id,
        spec.kind,
        spec.anchor,
        spec.position,
        output.title,
        output.markdown,
        JSON.stringify(output.diagram_blocks),
        newHash,
      );

    rebuilt++;

    // Eagerly rechunk the new section so the embedding cron can pick it up.
    // Chunk errors must NOT abort regen — wrap and warn.
    {
      // The UPSERT may have reused an existing id; look it up by natural key.
      const sectionRow = await db
        .prepare(`SELECT id FROM almanac_sections WHERE project_key = ? AND anchor = ?`)
        .get<{ id: string }>(projectKey, spec.anchor);
      if (sectionRow) {
        rechunkAlmanacSection(sectionRow.id).catch((err: unknown) => {
          console.warn(
            `[section-runner] rechunk failed for ${spec.anchor}: ${(err as Error).message}`,
          );
        });
      }
    }

    // Enqueue narration job if an agent is available
    if (agentId) {
      const idempotencyKey = `${spec.anchor}:${newHash}`;
      const dossierForJob = spec.unit_id
        ? await buildDossier(workspaceId, projectKey, spec.unit_id).catch(() => null)
        : projectDossier;
      const jobParams = {
        workspaceId,
        projectKey,
        anchor: spec.anchor,
        kind: spec.kind,
        title: output.title,
        sourceHash: newHash,
        skeletonMarkdown: output.markdown,
        cli: opts?.cli ?? 'codex',
        model: opts?.model ?? undefined,
        dossier: dossierForJob,
      };

      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO agent_jobs
             (id, agent_id, kind, params, status, idempotency_key, created_at)
           VALUES (?, ?, 'almanac.section.narrate', ?, 'queued', ?, datetime('now'))`,
        )
        .run(uuidv4(), agentId, JSON.stringify(jobParams), idempotencyKey);

      if ((result.changes ?? 0) > 0) {
        enqueuedJobs.push(idempotencyKey);
      }
    }
  }

  // Remove this unused variable — sourcehash is imported for re-export consistency
  void sourcehash;

  return {
    total_sections: specs.length,
    rebuilt,
    skipped_unchanged: skippedUnchanged,
    enqueued_jobs: enqueuedJobs,
  };
}
