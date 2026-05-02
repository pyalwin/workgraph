/**
 * Entity extraction — langextract-style approach, TS native.
 *
 * Uses Claude Haiku with tool_use to enforce a typed schema generated from
 * workspace_config. For each work item, we extract configured entity types
 * such as actor, group, communication_space, tracker_project, capability,
 * system, organization, or workspace-specific additions.
 *   - surface_form (exact substring from text)
 *   - canonical_form (normalized)
 *   - offsets (start/end character positions in the body)
 *
 * Canonicalization is done in two passes:
 *   1. LLM proposes a canonical_form per mention
 *   2. We dedupe across items: same (entity_type, normalized canonical) → one entity row
 *
 * Storage:
 *   - `entities` table: one row per canonical entity
 *   - `entity_mentions` table: one row per occurrence in a work_item
 *
 * Pipeline position: runs in process.ts between chunking and embeddings.
 */
import { generateObject } from 'ai';
import { z } from 'zod';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { getModel } from '../ai';
import { getWorkspaceConfigCached, seedWorkspaceConfig, type OntologyEntityType } from '../workspace-config';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

export type EntityType = string;

interface ExtractedEntity {
  surface_form: string;
  canonical_form: string;
  entity_type: string;
  start_offset?: number;
  end_offset?: number;
  confidence?: number;
}

const ExtractionSchema = z.object({
  entities: z.array(
    z.object({
      surface_form: z.string().describe('The exact substring as it appears in the text'),
      canonical_form: z.string().describe('Normalized canonical name for the entity, stable across aliases'),
      entity_type: z.string().describe('One of the configured workspace ontology entity-type IDs'),
      start_offset: z.number().int().optional().describe('Character offset where surface_form starts (0-indexed)'),
      end_offset: z.number().int().optional().describe('Character offset where surface_form ends (exclusive)'),
      confidence: z.number().min(0).max(1).optional().describe('0–1 — confidence in the entity_type classification'),
    }),
  ).describe('All named entities mentioned in the text'),
});

function buildSystemPrompt(entityTypes: OntologyEntityType[]): string {
  const ontology = entityTypes.map((t) => {
    const examples = t.examples?.length ? ` Examples: ${t.examples.join(', ')}.` : '';
    return `- ${t.id}: ${t.description}${examples}`;
  }).join('\n');

  return `You are an entity extraction tool for a configurable work-trace system. Read the provided text and return every named entity you find. Use offsets of surface_form so mentions can be grounded back to the text.

Workspace ontology:
${ontology}

Guidelines:
- Extract ALL entity mentions, not just unique entities — each mention counts with its own offsets.
- Prefer generic workspace ontology types over source-branded concepts. For example, a Slack channel or Teams channel is a communication_space; a Jira project or Linear team is a tracker_project; a repo or named platform is a system.
- Extract reusable functional areas, workflows, process areas, or product/service capabilities as capability when the configured ontology includes capability.
- Extract source-specific IDs as artifact unless they clearly represent a tracker_project or another configured type.
- Skip self-references (Me, I, we, us) and random capitalized words.
- Skip generic terms ("the API", "the database", "the file") unless context makes them a specific named entity.

Return all entities in a single object with shape { entities: [...] }. Allowed entity_type values: ${entityTypes.map((t) => t.id).join(', ')}.`;
}

async function extractFromText(text: string): Promise<ExtractedEntity[]> {
  if (!text || text.trim().length === 0) return [];
  const config = getWorkspaceConfigCached();
  const entityTypes = config.ontology.entityTypes;
  const allowed = new Set(entityTypes.map((t) => t.id));

  // Truncate very long bodies — offsets become unreliable and Haiku context cost grows
  const truncated = text.slice(0, 8000);

  try {
    const { object } = await generateObject({
      model: getModel('extract'),
      maxOutputTokens: 4000,
      system: buildSystemPrompt(entityTypes),
      schema: ExtractionSchema,
      prompt: truncated,
    });

    return object.entities
      .filter((e) => allowed.has(e.entity_type))
      .map((e) => ({
        surface_form: e.surface_form.trim(),
        canonical_form: e.canonical_form.trim(),
        entity_type: e.entity_type,
        start_offset: e.start_offset,
        end_offset: e.end_offset,
        confidence: e.confidence ?? 0.8,
      }));
  } catch (err: any) {
    console.error(`  extract-entities error: ${err.message?.slice(0, 120)}`);
    return [];
  }
}

function normalizeCanonical(canonical: string, type: EntityType): string {
  let s = canonical.trim();
  const typeConfig = getWorkspaceConfigCached().ontology.entityTypes.find((t) => t.id === type);
  if (typeConfig?.normalization === 'upper') return s.toUpperCase();
  if (typeConfig?.normalization === 'lower') return s.toLowerCase();
  if (typeConfig?.normalization === 'title') {
    return s.replace(/\S+/g, (word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase());
  }
  // Legacy normalization retained for existing deployments and old extracted rows.
  if (type === 'jira_project') return s.toUpperCase();
  if (type === 'slack_channel') return s.startsWith('#') ? s.toLowerCase() : `#${s.toLowerCase()}`;
  if (type === 'repo') return s.toLowerCase();
  return s;
}

function entityKey(canonical: string, type: EntityType): string {
  const normalized = normalizeCanonical(canonical, type);
  const slug = normalized.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${type}:${slug}`;
}

async function upsertEntity(canonical: string, type: EntityType, surface: string): Promise<string> {
  const db = getLibsqlDb();
  const id = entityKey(canonical, type);
  const normalized = normalizeCanonical(canonical, type);

  const existing = await db
    .prepare('SELECT id, aliases FROM entities WHERE id = ?')
    .get<{ id: string; aliases: string }>(id);

  if (!existing) {
    await db
      .prepare(
        `INSERT INTO entities (id, canonical_form, entity_type, aliases)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, normalized, type, JSON.stringify([surface]));
    return id;
  }

  // Merge surface_form into aliases if new
  try {
    const aliases: string[] = JSON.parse(existing.aliases || '[]');
    if (!aliases.includes(surface)) {
      aliases.push(surface);
      await db
        .prepare('UPDATE entities SET aliases = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(JSON.stringify(aliases), id);
    }
  } catch { /* ignore parse errors */ }

  return id;
}

async function recordMention(
  itemId: string,
  entityId: string,
  surface: string,
  startOffset?: number,
  endOffset?: number,
  confidence: number = 1.0,
): Promise<void> {
  const db = getLibsqlDb();
  await db
    .prepare(
      `INSERT OR IGNORE INTO entity_mentions
         (item_id, entity_id, surface_form, start_offset, end_offset, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(itemId, entityId, surface, startOffset ?? null, endOffset ?? null, confidence);
}

function safeParseMetadata(metadata: string | null): Record<string, any> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function valuesForMappedField(metadata: Record<string, any>, field: string): string[] {
  const candidates = [
    metadata[field],
    metadata[`${field}s`],
    field === 'component' ? metadata.components : undefined,
    field === 'label' ? metadata.labels : undefined,
  ];

  const out: string[] = [];
  for (const value of candidates) {
    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string' && v.trim()) out.push(v.trim());
        else if (v && typeof v === 'object' && typeof v.name === 'string') out.push(v.name.trim());
      }
    } else if (typeof value === 'string' && value.trim()) {
      out.push(value.trim());
    }
  }
  return [...new Set(out)];
}

function extractStructuredMetadataEntities(item: {
  source: string;
  author: string | null;
  metadata: string | null;
}): ExtractedEntity[] {
  const config = getWorkspaceConfigCached();
  const mapping = config.sourceMappings[item.source] ?? {};
  const metadata = safeParseMetadata(item.metadata);
  const entities: ExtractedEntity[] = [];

  for (const [field, entityType] of Object.entries(mapping)) {
    const values = field === 'author' || field === 'assignee'
      ? [...valuesForMappedField(metadata, field), ...(item.author ? [item.author] : [])]
      : valuesForMappedField(metadata, field);

    for (const value of values) {
      entities.push({
        surface_form: value,
        canonical_form: value,
        entity_type: entityType,
        confidence: 1.0,
      });
    }
  }

  const seen = new Set<string>();
  return entities.filter((e) => {
    const key = `${e.entity_type}:${e.canonical_form}:${e.surface_form}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Legacy-compatible dual-write: also populate item_tags with category='entity'
 * so the existing crossref.scoreEntities and link-detection paths keep working
 * without modification. Tag id and name are BOTH type-prefixed so the
 * UNIQUE(name, category) constraint on `tags` does not collide when the same
 * canonical string is used under different entity types (e.g. "Claude" as
 * person vs technology).
 *
 * Wrapped in try/catch: a broken dual-write must never poison the per-item
 * extraction — the new entity_mentions row is the source of truth.
 */
async function writeLegacyEntityTag(itemId: string, entityId: string, canonical: string, type: EntityType): Promise<void> {
  void entityId;
  try {
    const db = getLibsqlDb();
    const slug = canonical.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const tagName = `${type}:${canonical.toLowerCase().trim()}`;
    const tagId = `entity:${type}:${slug}`;

    const existingTag = await db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId);
    if (!existingTag) {
      try {
        await db
          .prepare(`INSERT INTO tags (id, name, category) VALUES (?, ?, 'entity')`)
          .run(tagId, tagName);
      } catch { /* unique constraint race / collision — fine, tag row exists */ }
    }
    // Verify the tag actually exists before FK-dependent insert
    const tagExists = await db.prepare('SELECT 1 FROM tags WHERE id = ?').get(tagId);
    if (tagExists) {
      await db
        .prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, 1.0)')
        .run(itemId, tagId);
    }
  } catch {
    // Legacy dual-write is best-effort — entity_mentions carries the real data
  }
}

export async function extractEntitiesForItem(itemId: string): Promise<number> {
  const db = getLibsqlDb();
  const item = await db
    .prepare('SELECT id, source, title, body, author, metadata FROM work_items WHERE id = ?')
    .get<{ id: string; source: string; title: string; body: string | null; author: string | null; metadata: string | null }>(itemId);
  if (!item) return 0;

  const text = [item.title, item.body].filter(Boolean).join('\n\n');
  const structuredEntities = extractStructuredMetadataEntities(item);
  if (!text.trim() && structuredEntities.length === 0) return 0;

  const textEntities = text.trim() ? await extractFromText(text) : [];
  const entities = [...structuredEntities, ...textEntities];
  if (entities.length === 0) return 0;

  let stored = 0;
  for (const e of entities) {
    const entityId = await upsertEntity(e.canonical_form, e.entity_type, e.surface_form);
    await recordMention(
      item.id,
      entityId,
      e.surface_form,
      e.start_offset,
      e.end_offset,
      e.confidence ?? 1.0,
    );
    await writeLegacyEntityTag(item.id, entityId, e.canonical_form, e.entity_type);
    stored++;
  }

  return stored;
}

export async function extractAllEntities(options: {
  limit?: number;
  force?: boolean;
  concurrency?: number;
} = {}): Promise<{ processed: number; mentions: number; failed: number }> {
  await ensureInit();
  await seedWorkspaceConfig();
  const db = getLibsqlDb();

  const limit = options.limit ?? 2000;
  const concurrency = options.concurrency ?? 4;

  // Items with a body and no entity mentions yet (unless force)
  const whereClause = options.force
    ? 'WHERE body IS NOT NULL AND length(body) > 0'
    : `WHERE body IS NOT NULL AND length(body) > 0
       AND id NOT IN (SELECT DISTINCT item_id FROM entity_mentions)`;

  const items = await db
    .prepare(`SELECT id FROM work_items ${whereClause} ORDER BY created_at DESC LIMIT ?`)
    .all<{ id: string }>(limit);

  console.log(`  ${items.length} items to extract entities from (concurrency: ${concurrency})`);
  if (items.length === 0) return { processed: 0, mentions: 0, failed: 0 };

  let processed = 0;
  let mentions = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const counts = await Promise.all(
      batch.map(async (item, j) => {
        const idx = i + j + 1;
        process.stdout.write(`  [${idx}/${items.length}] ${item.id.slice(0, 8)}...`);
        try {
          const n = await extractEntitiesForItem(item.id);
          console.log(` ${n} entities`);
          return n;
        } catch (err: any) {
          console.log(` FAIL (${err.message?.slice(0, 60)})`);
          return -1;
        }
      }),
    );
    for (const c of counts) {
      if (c < 0) failed++;
      else {
        processed++;
        mentions += c;
      }
    }
  }

  return { processed, mentions, failed };
}
