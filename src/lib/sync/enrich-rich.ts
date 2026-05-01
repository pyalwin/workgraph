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
import { getDb } from '../db';
import { initSchema } from '../schema';
import { getModel } from '../ai';
import { getWorkspaceConfig } from '../workspace-config';

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
  action_items: z
    .array(
      z.object({
        text: z.string().describe('Concrete actionable statement'),
        assignee: z.string().nullable().describe('Best-effort assignee from text'),
        due_at: z.string().nullable().describe('ISO date if explicitly mentioned'),
        ai_priority: z.enum(['p0', 'p1', 'p2', 'p3']),
      }),
    )
    .describe('Action items extracted from body / comments'),
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

function buildSystemPrompt(): string {
  const db = getDb();
  const config = getWorkspaceConfig();
  const goals = db
    .prepare("SELECT id, name, description FROM goals WHERE status = 'active' ORDER BY sort_order")
    .all() as { id: string; name: string; description: string }[];

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

Action items: concrete next steps mentioned in body or comments. ai_priority:
   - p0: outage / blocking / customer escalation
   - p1: deadline within a sprint, dependency for goal
   - p2: should-do this quarter
   - p3: nice-to-have / backlog

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

function upsertEntity(canonical: string, type: string): string {
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM entities WHERE canonical_form = ? AND entity_type = ?')
    .get(canonical, type) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = uuid();
  db.prepare(
    'INSERT INTO entities (id, canonical_form, entity_type, aliases) VALUES (?, ?, ?, ?)',
  ).run(id, canonical, type, '[]');
  return id;
}

function persistEntities(itemId: string, list: Enrichment['entities']) {
  const db = getDb();
  // Replace all AI-generated mentions for this item — keep the door open for
  // a second pass to refine. We identify "AI mentions" as those without
  // start_offset (the entity-extraction script does set offsets).
  db.prepare('DELETE FROM entity_mentions WHERE item_id = ? AND start_offset IS NULL').run(itemId);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO entity_mentions
      (item_id, entity_id, surface_form, start_offset, end_offset, confidence)
    VALUES (?, ?, ?, NULL, NULL, ?)
  `);
  for (const e of list) {
    const canonical = e.canonical_form.trim();
    const surface = (e.surface_form || canonical).trim();
    if (!canonical || !surface) continue;
    const entityId = upsertEntity(canonical, e.type);
    insert.run(itemId, entityId, surface, 0.85);
  }
}

function persistActionItems(itemId: string, list: Enrichment['action_items']) {
  const db = getDb();
  // Replace the AI-generated set on each enrichment pass. User-edited rows
  // are preserved because we only delete state='open' AI rows that haven't
  // been touched (no user_priority set).
  db.prepare(
    `DELETE FROM action_items WHERE source_item_id = ? AND state = 'open' AND user_priority IS NULL`,
  ).run(itemId);

  const insert = db.prepare(`
    INSERT INTO action_items (id, source_item_id, text, assignee, due_at, ai_priority, state)
    VALUES (?, ?, ?, ?, ?, ?, 'open')
  `);
  for (const a of list) {
    const text = a.text.trim();
    if (!text) continue;
    insert.run(uuid(), itemId, text, a.assignee, a.due_at, a.ai_priority);
  }
}

function persistAnomalies(itemId: string, workspaceId: string, list: Enrichment['anomaly_signals']) {
  const db = getDb();
  const scope = `item:${itemId}`;
  // Resolve any existing item-scoped anomalies for kinds we no longer flag.
  const flagged = new Set(list.map((a) => a.kind));
  const existing = db
    .prepare(
      `SELECT kind FROM anomalies WHERE workspace_id = ? AND scope = ? AND resolved_at IS NULL`,
    )
    .all(workspaceId, scope) as { kind: string }[];
  const resolveStmt = db.prepare(
    `UPDATE anomalies SET resolved_at = datetime('now') WHERE workspace_id = ? AND scope = ? AND kind = ? AND resolved_at IS NULL`,
  );
  for (const e of existing) {
    if (!flagged.has(e.kind as Enrichment['anomaly_signals'][number]['kind'])) {
      resolveStmt.run(workspaceId, scope, e.kind);
    }
  }
  // Upsert the live ones.
  const upsert = db.prepare(`
    INSERT INTO anomalies (id, workspace_id, scope, kind, severity, evidence_item_ids, explanation, detected_at, resolved_at, dismissed_by_user)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL, 0)
    ON CONFLICT(workspace_id, scope, kind) DO UPDATE SET
      severity = excluded.severity,
      explanation = excluded.explanation,
      detected_at = excluded.detected_at,
      resolved_at = NULL
  `);
  const evidence = JSON.stringify([itemId]);
  for (const a of list) {
    upsert.run(uuid(), workspaceId, scope, a.kind, a.severity, evidence, a.evidence);
  }
}

function storeTopicTags(itemId: string, topics: string[]) {
  const db = getDb();
  for (const raw of topics) {
    const name = raw.toLowerCase().trim();
    if (name.length < 2) continue;
    const tagId = `topic:${name}`;
    const existing = db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId);
    if (!existing) {
      db.prepare('INSERT INTO tags (id, name, category) VALUES (?, ?, ?)').run(tagId, name, 'topic');
    }
    db.prepare(
      'INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, 1.0)',
    ).run(itemId, tagId);
  }
}

function storeGoalTags(itemId: string, goalIds: string[]) {
  const db = getDb();
  db.prepare(
    `DELETE FROM item_tags WHERE item_id = ? AND tag_id IN (SELECT id FROM tags WHERE category = 'goal')`,
  ).run(itemId);
  for (const goalId of goalIds) {
    const goal = db.prepare('SELECT name FROM goals WHERE id = ?').get(goalId) as
      | { name: string }
      | undefined;
    if (!goal) continue;
    const existing = db.prepare('SELECT id FROM tags WHERE id = ?').get(goalId);
    if (!existing) {
      db.prepare(`INSERT INTO tags (id, name, category) VALUES (?, ?, 'goal')`).run(goalId, goal.name);
    }
    db.prepare(
      'INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, 1.0)',
    ).run(itemId, goalId);
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
  initSchema();
  const db = getDb();
  const item = db
    .prepare(
      `SELECT id, title, body, source, item_type, status, metadata, created_at, updated_at
       FROM work_items WHERE id = ?`,
    )
    .get(itemId) as
    | {
        id: string;
        title: string;
        body: string | null;
        source: string;
        item_type: string;
        status: string | null;
        metadata: string | null;
        created_at: string;
        updated_at: string | null;
      }
    | undefined;
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
      system: buildSystemPrompt(),
      schema: EnrichmentSchema,
      prompt: content,
    });
    result = object;
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'AI call failed' };
  }

  // 1. Update work_items
  const traceEventAt = computeTraceEventAt(item);
  db.prepare(`
    UPDATE work_items
    SET summary = ?,
        trace_role = ?,
        substance = ?,
        trace_event_at = ?,
        enriched_at = datetime('now')
    WHERE id = ?
  `).run(result.summary, result.trace_role, result.substance, traceEventAt, itemId);

  // 2. Persist derived rows
  storeTopicTags(itemId, result.topics);
  storeGoalTags(itemId, result.goals);
  persistEntities(itemId, result.entities);
  persistActionItems(itemId, result.action_items);
  persistAnomalies(itemId, workspaceId, result.anomaly_signals);

  return { ok: true, enrichment: result };
}
