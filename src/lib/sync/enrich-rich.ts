/**
 * Phase 1.4 — full per-item enrichment in one Sonnet pass.
 *
 * Produces, in a single structured-output call:
 *   - summary (1–2 sentences)
 *   - trace_role + substance (existing classifications)
 *   - characteristic entities — theme / capability / system / decision / risk / effort_signal
 *   - action items with AI-suggested priority
 *   - anomaly signals (per-item flags; the workspace-wide scan is separate)
 *
 * Persists into the existing tables (work_items, entities, entity_mentions,
 * tags, action_items, anomalies). Idempotent — re-running on the same item
 * replaces the AI-derived rows for that item.
 */
import { generateObject } from 'ai';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { getModel } from '../ai';
import { getWorkspaceConfigCached } from '../workspace-config';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

// ─── Schema returned by the AI ────────────────────────────────────────────

const EnrichmentSchema = z.object({
  summary: z.string().describe('1–2 sentence neutral summary of what this item is about'),
  trace_role: z
    .string()
    .nullable()
    .describe('Lifecycle stage id from the workspace config, or null'),
  substance: z
    .enum(['bug', 'feature', 'refactor', 'docs', 'infra', 'process', 'research'])
    .nullable(),
  topics: z.array(z.string()).describe('2–5 lowercase hyphenated topic tags'),
  entities: z
    .array(
      z.object({
        type: z.enum([
          'theme',
          'capability',
          'system',
          'decision',
          'risk',
          'effort_signal',
        ]),
        canonical_form: z.string().describe('Stable normalized name'),
        surface_form: z.string().describe('How it appears in the source text'),
      }),
    )
    .describe('Characteristic entities that turn this into a graph-quality node'),
  anomaly_signals: z
    .array(
      z.object({
        kind: z.enum([
          'stale',
          'churning',
          'scope_creep',
          'priority_inversion',
          'deadline_risk',
          'owner_gap',
        ]),
        severity: z.number().min(0).max(1),
        evidence: z.string().describe('1-line explanation of why this fired'),
      }),
    )
    .describe('Per-item anomaly flags. Empty if nothing is wrong.'),
  goals: z.array(z.string()).describe('Strategic goal IDs from the configured list'),
});

type Enrichment = z.infer<typeof EnrichmentSchema>;

// ─── Prompt ───────────────────────────────────────────────────────────────

async function buildSystemPrompt(workspaceId: string): Promise<string> {
  const db = getLibsqlDb();
  const config = getWorkspaceConfigCached();
  const goals = await db
    .prepare(
      "SELECT id, name, description FROM goals WHERE workspace_id = ? AND status = 'active' ORDER BY sort_order",
    )
    .all<{ id: string; name: string; description: string }>(workspaceId);

  const goalList = goals.map((g) => `- "${g.id}": ${g.name} — ${g.description}`).join('\n') || '(none)';
  const stages = config.lifecycle.stages
    .map((s) => `   - "${s.id}": ${s.label} — ${s.description}`)
    .join('\n');
  const sourceKinds = Object.entries(config.sources)
    .map(([id, s]) => `- ${id}: ${s.label} (${s.kind})`)
    .join('\n');

  return `You enrich a single work item — a Jira ticket, Slack thread, Notion page, GitHub PR, meeting note, etc. — into a graph-quality node.

Configured sources:
${sourceKinds}

Configured strategic goals (use IDs only):
${goalList}

Lifecycle stages for trace_role:
${stages}
   - null: noise / status updates / doesn't fit any stage

Substance options: bug | feature | refactor | docs | infra | process | research | null

Entity types to extract (only when genuinely present — skip if uncertain):
   - theme:          high-level topic ("billing rewrite", "v2 schema")
   - capability:     product capability touched ("invoice approval", "sso")
   - system:         technical surface ("api-gateway", "ingest-worker")
   - decision:       a decision made or asked about
   - risk:           blocker / dependency / regulatory concern
   - effort_signal:  explicit estimate or implicit "this will take a while" cue

Anomaly signals (only flag what's evident from THIS item alone — workspace-wide
scans run separately):
   - stale: status active but no progress signal in body for 14+ days
   - churning: many comments, no resolution
   - scope_creep: body has grown materially while still active
   - priority_inversion: low-priority blocking high-priority
   - deadline_risk: explicit deadline at risk per the text
   - owner_gap: no owner / contradictory ownership

Be conservative — empty arrays when nothing genuine. Don't fabricate entities,
action items, or anomalies to fill quota.`;
}

// ─── Persistence helpers ──────────────────────────────────────────────────

async function upsertEntity(workspaceId: string, canonical: string, type: string): Promise<string> {
  const db = getLibsqlDb();
  // Look up within this workspace first. The legacy UNIQUE(canonical_form,
  // entity_type) constraint applies cross-workspace, so a different
  // workspace can't reuse the same (canonical, type) pair without colliding;
  // we paper over by giving each workspace a uuid-suffixed id and tolerating
  // the ON CONFLICT failure as a no-op via INSERT OR IGNORE-style retry.
  const existing = await db
    .prepare(
      'SELECT id FROM entities WHERE canonical_form = ? AND entity_type = ? AND workspace_id = ?',
    )
    .get<{ id: string }>(canonical, type, workspaceId);
  if (existing) return existing.id;
  const id = uuid();
  try {
    await db
      .prepare(
        'INSERT INTO entities (id, canonical_form, entity_type, aliases, workspace_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, canonical, type, '[]', workspaceId);
    return id;
  } catch (err) {
    // UNIQUE(canonical_form, entity_type) collision with another workspace's
    // row. Re-look up scoped to this workspace; if still missing, fall back
    // to the cross-workspace row id (best-effort — the entity is logically
    // shared but readers will filter on workspace_id of the entity row).
    const re = await db
      .prepare(
        'SELECT id FROM entities WHERE canonical_form = ? AND entity_type = ? AND workspace_id = ?',
      )
      .get<{ id: string }>(canonical, type, workspaceId);
    if (re) return re.id;
    const any = await db
      .prepare('SELECT id FROM entities WHERE canonical_form = ? AND entity_type = ?')
      .get<{ id: string }>(canonical, type);
    if (any) return any.id;
    throw err;
  }
}

async function persistEntities(workspaceId: string, itemId: string, list: Enrichment['entities']): Promise<void> {
  const db = getLibsqlDb();
  // Replace all AI-generated mentions for this item — keep the door open for
  // a second pass to refine. We identify "AI mentions" as those without
  // start_offset (the entity-extraction script does set offsets).
  await db
    .prepare('DELETE FROM entity_mentions WHERE item_id = ? AND start_offset IS NULL')
    .run(itemId);
  const insertSql = `INSERT OR IGNORE INTO entity_mentions
      (item_id, entity_id, surface_form, start_offset, end_offset, confidence)
    VALUES (?, ?, ?, NULL, NULL, ?)`;
  for (const e of list) {
    const canonical = e.canonical_form.trim();
    const surface = (e.surface_form || canonical).trim();
    if (!canonical || !surface) continue;
    const entityId = await upsertEntity(workspaceId, canonical, e.type);
    await db.prepare(insertSql).run(itemId, entityId, surface, 0.85);
  }
}

async function persistAnomalies(itemId: string, workspaceId: string, list: Enrichment['anomaly_signals']): Promise<void> {
  const db = getLibsqlDb();
  const scope = `item:${itemId}`;
  // Resolve any existing item-scoped anomalies for kinds we no longer flag.
  const flagged = new Set(list.map((a) => a.kind));
  const existing = await db
    .prepare(
      `SELECT kind FROM anomalies WHERE workspace_id = ? AND scope = ? AND resolved_at IS NULL`,
    )
    .all<{ kind: string }>(workspaceId, scope);
  const resolveSql = `UPDATE anomalies SET resolved_at = datetime('now') WHERE workspace_id = ? AND scope = ? AND kind = ? AND resolved_at IS NULL`;
  for (const e of existing) {
    if (!flagged.has(e.kind as Enrichment['anomaly_signals'][number]['kind'])) {
      await db.prepare(resolveSql).run(workspaceId, scope, e.kind);
    }
  }
  // Upsert the live ones.
  const upsertSql = `INSERT INTO anomalies (id, workspace_id, scope, kind, severity, evidence_item_ids, explanation, detected_at, resolved_at, dismissed_by_user)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL, 0)
    ON CONFLICT(workspace_id, scope, kind) DO UPDATE SET
      severity = excluded.severity,
      explanation = excluded.explanation,
      detected_at = excluded.detected_at,
      resolved_at = NULL`;
  const evidence = JSON.stringify([itemId]);
  for (const a of list) {
    await db.prepare(upsertSql).run(uuid(), workspaceId, scope, a.kind, a.severity, evidence, a.evidence);
  }
}

async function storeTopicTags(workspaceId: string, itemId: string, topics: string[]): Promise<void> {
  const db = getLibsqlDb();
  for (const raw of topics) {
    const name = raw.toLowerCase().trim();
    if (name.length < 2) continue;
    // Workspace-prefix the tag id so two workspaces with the same topic
    // name don't collide on the legacy UNIQUE(name, category) constraint.
    const tagId = `${workspaceId}:topic:${name}`;
    const existing = await db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId);
    if (!existing) {
      try {
        await db
          .prepare('INSERT INTO tags (id, name, category, workspace_id) VALUES (?, ?, ?, ?)')
          .run(tagId, name, 'topic', workspaceId);
      } catch {
        // UNIQUE(name, category) collision with another workspace's tag row;
        // the post-migration plan is workspace-prefixed names. Until that
        // migration runs, fall back to the existing shared id so item_tags
        // FK still resolves.
        const fallback = `topic:${name}`;
        await db
          .prepare(
            `INSERT OR IGNORE INTO tags (id, name, category, workspace_id) VALUES (?, ?, ?, ?)`,
          )
          .run(fallback, name, 'topic', workspaceId);
        await db
          .prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, 1.0)')
          .run(itemId, fallback);
        continue;
      }
    }
    await db
      .prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, 1.0)')
      .run(itemId, tagId);
  }
}

async function storeGoalTags(workspaceId: string, itemId: string, goalIds: string[]): Promise<void> {
  const db = getLibsqlDb();
  await db
    .prepare(
      `DELETE FROM item_tags WHERE item_id = ? AND tag_id IN (SELECT id FROM tags WHERE category = 'goal')`,
    )
    .run(itemId);
  for (const goalId of goalIds) {
    const goal = await db
      .prepare('SELECT name FROM goals WHERE id = ? AND workspace_id = ?')
      .get<{ name: string }>(goalId, workspaceId);
    if (!goal) continue;
    // Goal-tag id stays equal to the goal id (legacy contract — item_tags.tag_id
    // joins both tags and goals). Stamp workspace_id on insert.
    const existing = await db.prepare('SELECT id FROM tags WHERE id = ?').get(goalId);
    if (!existing) {
      await db
        .prepare(`INSERT INTO tags (id, name, category, workspace_id) VALUES (?, ?, 'goal', ?)`)
        .run(goalId, goal.name, workspaceId);
    }
    await db
      .prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, 1.0)')
      .run(itemId, goalId);
  }
}

function computeTraceEventAt(item: {
  source: string;
  status: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string | null;
}): string {
  if (item.source === 'github' && item.status === 'merged' && item.metadata) {
    try {
      const m = JSON.parse(item.metadata);
      if (m.merged_at) return String(m.merged_at);
    } catch {
      /* fall through */
    }
  }
  return item.updated_at ?? item.created_at;
}

// ─── Public API ───────────────────────────────────────────────────────────

export async function enrichItemFully(
  itemId: string,
  workspaceId: string,
): Promise<{ ok: true; enrichment: Enrichment } | { ok: false; error: string }> {
  await ensureInit();
  const db = getLibsqlDb();
  const item = await db
    .prepare(
      `SELECT id, title, body, source, item_type, status, metadata, created_at, updated_at
       FROM work_items WHERE id = ?`,
    )
    .get<{
      id: string;
      title: string;
      body: string | null;
      source: string;
      item_type: string;
      status: string | null;
      metadata: string | null;
      created_at: string;
      updated_at: string | null;
    }>(itemId);
  if (!item) return { ok: false, error: 'item not found' };

  const content = [
    `Source: ${item.source}`,
    `ContentType: ${item.item_type}`,
    `Title: ${item.title}`,
    item.body ? `Body: ${item.body.slice(0, 8000)}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  let result: Enrichment;
  try {
    const { object } = await generateObject({
      model: getModel('enrich'),
      maxOutputTokens: 2000,
      system: await buildSystemPrompt(workspaceId),
      schema: EnrichmentSchema,
      prompt: content,
    });
    result = object;
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'AI call failed' };
  }

  // 1. Update work_items
  const traceEventAt = computeTraceEventAt(item);
  await db
    .prepare(
      `UPDATE work_items
       SET summary = ?,
           trace_role = ?,
           substance = ?,
           trace_event_at = ?,
           enriched_at = datetime('now')
       WHERE id = ?`,
    )
    .run(result.summary, result.trace_role, result.substance, traceEventAt, itemId);

  // 2. Persist derived rows
  await storeTopicTags(workspaceId, itemId, result.topics);
  await storeGoalTags(workspaceId, itemId, result.goals);
  await persistEntities(workspaceId, itemId, result.entities);
  await persistAnomalies(itemId, workspaceId, result.anomaly_signals);

  return { ok: true, enrichment: result };
}
