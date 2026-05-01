import { generateText } from 'ai';
import { getDb } from '../db';
import { initSchema } from '../schema';
import { getModel } from '../ai';
import { getWorkspaceConfig, seedWorkspaceConfig } from '../workspace-config';

export type TraceRole = string | null;

export type Substance =
  | 'bug'
  | 'feature'
  | 'refactor'
  | 'docs'
  | 'infra'
  | 'process'
  | 'research'
  | null;

const SUBSTANCES: ReadonlyArray<Exclude<Substance, null>> = [
  'bug', 'feature', 'refactor', 'docs', 'infra', 'process', 'research',
];

interface EnrichmentResult {
  summary: string;
  trace_role: TraceRole;
  substance: Substance;
  topics: string[];
  entities: string[];
  goals: string[];
}


function buildSystemPrompt(): string {
  const db = getDb();
  const config = getWorkspaceConfig();
  const goals = db
    .prepare("SELECT id, name, description FROM goals WHERE status = 'active' ORDER BY sort_order")
    .all() as { id: string; name: string; description: string }[];

  const goalList = goals.map(g => `- "${g.id}": ${g.name} — ${g.description}`).join('\n');
  const stages = config.lifecycle.stages.map((stage) => {
    const legacy = stage.legacyIds?.length ? ` Legacy equivalents: ${stage.legacyIds.join(', ')}.` : '';
    return `   - "${stage.id}": ${stage.label} — ${stage.description}${legacy}`;
  }).join('\n');
  const sourceKinds = Object.entries(config.sources)
    .map(([id, source]) => `- ${id}: ${source.label} (${source.kind})`)
    .join('\n');

  return `You are classifying a work item in a configurable organizational work-trace system. A work item may come from a tracker, communication tool, document system, meeting transcript, code host, approval system, case tool, CRM, or another configured source.

Configured source registry:
${sourceKinds}

Return a single JSON object (no markdown fences, no commentary) with these fields:

1. "summary": concise 1-2 sentence summary of what this item is about.

2. "trace_role": where does this item sit in the configured lifecycle? Pick exactly ONE of:
${stages}
   - "null": noise, small talk, pure status updates — doesn't fit any lifecycle stage

3. "substance": what is this item ABOUT? Pick exactly ONE of:
   - "bug": fixing broken behavior
   - "feature": adding new capability
   - "refactor": restructuring without behavior change
   - "docs": documentation
   - "infra": CI/CD, deploy, platform, tooling
   - "process": team process, ceremonies, planning
   - "research": investigation, prototyping, exploration
   - "null": doesn't fit any category

4. "topics": 2-5 topic tags (lowercase, hyphenated). Examples: auth, pipeline, vendor-pay, api-gateway, deployment, testing.

5. "entities": important mentioned entities in plain text. Array of strings. Use generic named concepts rather than source-specific assumptions.

6. "goals": zero or more strategic goal IDs this item genuinely fits. Use IDs from this list only:
${goalList}

Return ONLY valid JSON, no markdown fences, no explanation.`;
}

async function callHaiku(
  systemPrompt: string,
  title: string,
  source: string,
  itemType: string,
  body: string | null,
): Promise<EnrichmentResult | null> {
  const content = [
    `Source: ${source}`,
    `ContentType: ${itemType}`,
    `Title: ${title}`,
    body ? `Body: ${body.slice(0, 3000)}` : null,
  ].filter(Boolean).join('\n\n');

  try {
    const { text: rawText } = await generateText({
      model: getModel('enrich'),
      maxOutputTokens: 600,
      system: systemPrompt,
      prompt: content,
    });
    const text = rawText.trim();
    if (!text) return null;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const allowedTraceRoles = getWorkspaceConfig().lifecycle.stages.map((s) => s.id);

    const traceRole = normalizeEnum<string>(parsed.trace_role, allowedTraceRoles);
    const substance = normalizeEnum<Exclude<Substance, null>>(parsed.substance, SUBSTANCES);

    return {
      summary: String(parsed.summary || '').trim(),
      trace_role: traceRole,
      substance: substance,
      topics: Array.isArray(parsed.topics)
        ? parsed.topics.map((t: unknown) => String(t).toLowerCase().trim()).filter(Boolean)
        : [],
      entities: Array.isArray(parsed.entities)
        ? parsed.entities.map((e: unknown) => String(e).trim()).filter(Boolean)
        : [],
      goals: Array.isArray(parsed.goals) ? parsed.goals.map((g: unknown) => String(g)) : [],
    };
  } catch (err: any) {
    console.error(`  Haiku error: ${err.message}`);
    return null;
  }
}

function normalizeEnum<T extends string>(value: unknown, allowed: ReadonlyArray<T>): T | null {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase().trim();
  if (v === '' || v === 'null' || v === 'none') return null;
  const hit = allowed.find(a => a === v);
  return hit ?? null;
}

function storeTags(itemId: string, category: string, names: string[], confidence: number = 1.0) {
  const db = getDb();
  for (const name of names) {
    if (!name || name.length < 2) continue;
    const normalized = name.toLowerCase().trim();
    const tagId = `${category}:${normalized}`;
    const existing = db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId);
    if (!existing) {
      db.prepare('INSERT INTO tags (id, name, category) VALUES (?, ?, ?)').run(tagId, normalized, category);
    }
    db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, ?)').run(itemId, tagId, confidence);
  }
}

function storeGoalTags(itemId: string, goalIds: string[]) {
  const db = getDb();
  // Wipe any existing goal tags (from old keyword-based classification or prior LLM run)
  db.prepare(`DELETE FROM item_tags WHERE item_id = ? AND tag_id IN (SELECT id FROM tags WHERE category = 'goal')`).run(itemId);
  // Also wipe bare-goal-id rows from the legacy classify.ts shape
  const activeGoals = db.prepare("SELECT id FROM goals WHERE status = 'active'").all() as { id: string }[];
  for (const g of activeGoals) {
    db.prepare('DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?').run(itemId, g.id);
  }
  for (const goalId of goalIds) {
    const goal = db.prepare('SELECT name FROM goals WHERE id = ?').get(goalId) as { name: string } | undefined;
    if (!goal) continue;
    const existing = db.prepare('SELECT id FROM tags WHERE id = ?').get(goalId);
    if (!existing) {
      db.prepare(`INSERT INTO tags (id, name, category) VALUES (?, ?, 'goal')`).run(goalId, goal.name);
    }
    db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, 1.0)').run(itemId, goalId);
  }
}

/**
 * Compute trace_event_at for a work_item — usually created_at, but for merged PRs
 * the integration moment matters more. Lightweight: derive from metadata if present.
 */
function computeTraceEventAt(item: {
  source: string;
  status: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string | null;
}): string {
  if (item.source === 'github' && item.status === 'merged') {
    if (item.metadata) {
      try {
        const m = JSON.parse(item.metadata);
        if (m.merged_at) return String(m.merged_at);
      } catch {}
    }
    if (item.updated_at) return item.updated_at;
  }
  return item.created_at;
}

export async function enrichItem(itemId: string, systemPrompt: string): Promise<boolean> {
  const db = getDb();
  const item = db.prepare(`
    SELECT id, title, body, source, item_type, status, metadata, created_at, updated_at
    FROM work_items WHERE id = ?
  `).get(itemId) as any;
  if (!item) return false;

  const result = await callHaiku(systemPrompt, item.title, item.source, item.item_type, item.body);
  if (!result) return false;

  const traceEventAt = computeTraceEventAt(item);

  db.prepare(`
    UPDATE work_items
    SET summary = ?, trace_role = ?, substance = ?, trace_event_at = ?, enriched_at = datetime('now')
    WHERE id = ?
  `).run(result.summary, result.trace_role, result.substance, traceEventAt, itemId);

  storeTags(itemId, 'topic', result.topics);
  storeTags(itemId, 'entity', result.entities);
  storeGoalTags(itemId, result.goals);

  return true;
}

export async function enrichAll(options: {
  limit?: number;
  force?: boolean;
  concurrency?: number;
} = {}): Promise<{ enriched: number; failed: number; total: number }> {
  const db = getDb();
  initSchema();
  seedWorkspaceConfig();

  const limit = options.limit ?? 1000;
  const concurrency = options.concurrency ?? 5;
  const whereClause = options.force ? '' : 'WHERE enriched_at IS NULL';

  const items = db
    .prepare(`SELECT id, title FROM work_items ${whereClause} ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as { id: string; title: string }[];

  console.log(`  ${items.length} items to enrich (concurrency: ${concurrency})`);
  if (items.length === 0) {
    console.log('  All items already enriched. Use --force to re-enrich.');
    return { enriched: 0, failed: 0, total: 0 };
  }

  const systemPrompt = buildSystemPrompt();
  const result = { enriched: 0, failed: 0, total: items.length };

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const promises = batch.map(async (item, j) => {
      const idx = i + j + 1;
      process.stdout.write(`  [${idx}/${items.length}] ${item.title.slice(0, 55)}...`);
      const success = await enrichItem(item.id, systemPrompt);
      console.log(success ? ' OK' : ' FAIL');
      return success;
    });
    const results = await Promise.all(promises);
    for (const success of results) success ? result.enriched++ : result.failed++;
  }

  return result;
}
