/**
 * Gmail content enrichment: classify, tag, extract entities, normalize.
 *
 * Each Gmail thread is enriched along four axes after ingest. All four are
 * idempotent and re-running on the same item replaces the previous state for
 * that item only (so updated threads get re-classified naturally on next sync).
 *
 *   1. Author normalization  — collapse "Alex Morgan <alex@x.com>" → "alex@x.com"
 *      so the same person matches across Gmail / Calendar / Drive in
 *      crossref.scoreAuthor.
 *
 *   2. Participant entities  — every unique email address in the thread
 *      (From + To + Cc) becomes an `actor` entity_mention. Domains for emails
 *      not on consumer providers (gmail.com, outlook.com, etc.) become
 *      `organization` entity_mentions. This is the deterministic backbone of
 *      crossref's shared-entity signal (25% weight).
 *
 *   3. Topic + category tags — one LLM call per thread returns:
 *        { category: <fixed taxonomy>, topics: [kebab-case tag, ...] }
 *      Tags are inserted into `tags` (category='gmail_category' for the
 *      category, category='topic' for free-text topics) and linked to the
 *      item via item_tags. Topics drive crossref.scoreTopics (10% weight) and
 *      are what makes "credit-card emails from different banks" cluster.
 *
 *   4. Summary               — one-sentence content summary stored on
 *      work_items.summary. Used by the graph UI and by readers.
 *
 * Errors at any step are caught and logged: enrichment is best-effort and
 * must never fail the upstream ingest.
 */
import { randomUUID } from 'crypto';
import { getLibsqlDb } from '../db/libsql';
import { runPrompt } from '../ai/runner';

const CONSUMER_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com',
  'aol.com', 'pm.me', 'fastmail.com', 'mail.com', 'zoho.com', 'gmx.com',
]);

const GMAIL_CATEGORIES = [
  'finance',         // banking, credit-card, payments, billing, taxes, expenses, payroll
  'fundraising',     // investor outreach, term sheets, diligence, board updates
  'hiring',          // candidates, interviews, offers, recruiting
  'sales',           // prospects, deals, customer onboarding
  'vendor',          // vendor/SaaS communications, contracts
  'product',         // product discussions, design, engineering
  'support',         // customer support, bug reports, complaints
  'internal',        // team communications, ops, internal updates
  'legal',           // contracts, compliance, NDAs
  'personal',        // non-work
  'newsletter',      // mass marketing, subscriptions, digests
  'other',
] as const;

type GmailCategory = (typeof GMAIL_CATEGORIES)[number];

interface ParsedAddress {
  email: string;
  name: string | null;
}

/**
 * Parse "Name <email@x.com>" / "<email@x.com>" / "email@x.com" → ParsedAddress.
 * Lowercases the email and trims angle-bracket quoting. Returns null for
 * unparseable input.
 */
export function parseEmailAddress(raw: string | null | undefined): ParsedAddress | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const angle = s.match(/^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  if (angle) {
    const name = angle[1].replace(/^["']|["']$/g, '').trim() || null;
    return { email: angle[2].toLowerCase(), name };
  }
  if (/^[^\s<>]+@[^\s<>]+$/.test(s)) return { email: s.toLowerCase(), name: null };
  return null;
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase();
}

export function isCorporateDomain(domain: string): boolean {
  return !CONSUMER_EMAIL_DOMAINS.has(domain);
}

// ───────────────────── entity / tag persistence ─────────────────────

async function upsertEntity(
  workspaceId: string,
  entityType: 'actor' | 'organization' | 'system',
  canonical: string,
): Promise<string> {
  const db = getLibsqlDb();
  const existing = await db
    .prepare(
      `SELECT id FROM entities
       WHERE entity_type = ? AND LOWER(canonical_form) = LOWER(?)
       AND (workspace_id = ? OR workspace_id IS NULL)
       LIMIT 1`,
    )
    .get<{ id: string }>(entityType, canonical, workspaceId);
  if (existing) return existing.id;
  const id = randomUUID();
  await db
    .prepare(
      `INSERT INTO entities (id, canonical_form, entity_type, aliases, workspace_id, created_at)
       VALUES (?, ?, ?, '[]', ?, datetime('now'))`,
    )
    .run(id, canonical, entityType, workspaceId);
  return id;
}

async function attachEntityMention(
  itemId: string,
  entityId: string,
  surfaceForm: string,
  confidence = 1.0,
): Promise<void> {
  const db = getLibsqlDb();
  await db
    .prepare(
      `INSERT OR IGNORE INTO entity_mentions
       (item_id, entity_id, surface_form, start_offset, end_offset, confidence)
       VALUES (?, ?, ?, NULL, NULL, ?)`,
    )
    .run(itemId, entityId, surfaceForm, confidence);
}

async function upsertTag(
  workspaceId: string,
  name: string,
  category: string,
): Promise<string> {
  const db = getLibsqlDb();
  const existing = await db
    .prepare(`SELECT id FROM tags WHERE name = ? AND category = ?`)
    .get<{ id: string }>(name, category);
  if (existing) return existing.id;
  const id = randomUUID();
  await db
    .prepare(`INSERT INTO tags (id, name, category, workspace_id) VALUES (?, ?, ?, ?)`)
    .run(id, name, category, workspaceId);
  return id;
}

async function attachTag(itemId: string, tagId: string, confidence = 1.0): Promise<void> {
  const db = getLibsqlDb();
  await db
    .prepare(`INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, ?)`)
    .run(itemId, tagId, confidence);
}

// ───────────────────── LLM classification ─────────────────────

interface ExtractedEntity {
  kind: 'organization' | 'person' | 'product';
  name: string;
}

interface GmailClassification {
  category: GmailCategory;
  topics: string[];
  summary: string;
  entities: ExtractedEntity[];
}

const CLASSIFICATION_SYSTEM_PROMPT = `You analyze Gmail threads for a knowledge graph. Return ONLY a single JSON object — no prose, no code fences.

Schema:
{
  "category": one of: ${GMAIL_CATEGORIES.join(' | ')},
  "topics": array of 1-3 short kebab-case tags derived from content,
  "summary": one sentence, <= 160 chars, describing what the thread is about,
  "entities": array of named entities mentioned IN THE BODY (not just the From/To headers)
              — each: { "kind": "organization" | "person" | "product", "name": "..." }
}

Topic-tag rules:
- Kebab-case, 1-3 words. Examples: "credit-card", "invoice", "investor-update", "candidate-interview", "design-review", "expense-report", "banking", "tax-filing", "legal-review", "wire-transfer".
- GENERIC enough that two semantically similar threads (e.g. credit card statements from different banks) receive the same tag.
- Topical, not entity-named. Use "credit-card" not "chase-credit-card"; "investor-update" not "sequoia-update".
- Do NOT include the sender's name or company as a topic tag.
- 1-3 tags max. Pick the most specific tags that still generalize across senders.

Entity rules:
- Extract NAMED entities mentioned in the body text — companies referred to, people referred to (by name), products/services discussed.
- DO NOT extract the email participants themselves (those are already captured from headers).
- DO NOT extract generic nouns ("credit card", "the team", "our company"). Only proper-noun entities.
- Use canonical names: "Acme Corp" not "Acme", "Sequoia Capital" not "sequoia".
- Up to 6 entities. Empty array if none.

Output ONLY the JSON object.`;

function extractFirstJsonObject(text: string): string | null {
  // Strip code fences if any.
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

function sanitizeTopic(s: string): string | null {
  const t = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!t || t.length > 40) return null;
  return t;
}

export async function classifyGmailThread(input: {
  title: string;
  body: string | null;
  participants: string[];
}): Promise<GmailClassification | null> {
  const participantBlock = input.participants.slice(0, 12).join(', ');
  // Truncate body to keep prompt cheap.
  const body = (input.body ?? '').slice(0, 4000);
  const prompt =
    `Subject: ${input.title}\n` +
    `Participants: ${participantBlock || '(none)'}\n\n` +
    `Body:\n${body}`;
  try {
    const { text } = await runPrompt({
      task: 'extract',
      system: CLASSIFICATION_SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: 200,
    });
    const json = extractFirstJsonObject(text);
    if (!json) return null;
    const parsed = JSON.parse(json) as Partial<GmailClassification>;
    const rawCategory = String(parsed.category ?? '').toLowerCase().trim();
    const category = (GMAIL_CATEGORIES as ReadonlyArray<string>).includes(rawCategory)
      ? (rawCategory as GmailCategory)
      : 'other';
    const topics = Array.isArray(parsed.topics)
      ? (parsed.topics
          .map((t) => sanitizeTopic(String(t)))
          .filter((t): t is string => !!t)
          .slice(0, 3))
      : [];
    const summary = String(parsed.summary ?? '').trim().slice(0, 240) || null;
    const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
    const entities: ExtractedEntity[] = [];
    for (const raw of rawEntities) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as { kind?: unknown; name?: unknown };
      const kind = String(r.kind ?? '').toLowerCase().trim();
      const name = String(r.name ?? '').trim();
      if (!name || name.length > 80) continue;
      if (kind !== 'organization' && kind !== 'person' && kind !== 'product') continue;
      entities.push({ kind: kind as ExtractedEntity['kind'], name });
      if (entities.length >= 6) break;
    }
    return { category, topics, summary: summary ?? '', entities };
  } catch {
    return null;
  }
}

function entityTypeForKind(kind: ExtractedEntity['kind']): 'actor' | 'organization' | 'system' {
  if (kind === 'person') return 'actor';
  if (kind === 'organization') return 'organization';
  return 'system'; // 'product' maps to system per the workspace ontology
}

// ───────────────────── orchestrator ─────────────────────

interface GmailItemRow {
  id: string;
  source_id: string;
  title: string;
  body: string | null;
  author: string | null;
  metadata: string | null;
}

function readParticipants(metadataJson: string | null): string[] {
  if (!metadataJson) return [];
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    const arr = meta.participants;
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const raw of arr) {
      const parsed = parseEmailAddress(String(raw));
      if (parsed) out.push(parsed.email);
    }
    return Array.from(new Set(out));
  } catch {
    return [];
  }
}

async function loadGmailItem(itemId: string): Promise<GmailItemRow | null> {
  const db = getLibsqlDb();
  return (
    (await db
      .prepare(
        `SELECT id, source_id, title, body, author, metadata
         FROM work_items WHERE id = ? AND source = 'gmail'`,
      )
      .get<GmailItemRow>(itemId)) ?? null
  );
}

/**
 * Enrich a single Gmail item. Idempotent — re-running replaces prior
 * enrichment for this item only.
 */
export async function enrichGmailItem(
  workspaceId: string,
  itemId: string,
  opts: { skipLlm?: boolean } = {},
): Promise<void> {
  const item = await loadGmailItem(itemId);
  if (!item) return;
  const db = getLibsqlDb();
  const participants = readParticipants(item.metadata);

  // 1. Author normalization
  const parsedAuthor = parseEmailAddress(item.author);
  if (parsedAuthor && parsedAuthor.email !== item.author) {
    try {
      await db
        .prepare(`UPDATE work_items SET author = ? WHERE id = ?`)
        .run(parsedAuthor.email, itemId);
    } catch {
      /* best-effort */
    }
  }
  const allEmails = new Set<string>(participants);
  if (parsedAuthor) allEmails.add(parsedAuthor.email);

  // 2. Participant + domain entities
  for (const email of allEmails) {
    try {
      const actorId = await upsertEntity(workspaceId, 'actor', email);
      await attachEntityMention(itemId, actorId, email, 1.0);
      const domain = emailDomain(email);
      if (domain && isCorporateDomain(domain)) {
        const orgId = await upsertEntity(workspaceId, 'organization', domain);
        await attachEntityMention(itemId, orgId, domain, 0.9);
      }
    } catch {
      /* best-effort */
    }
  }

  if (opts.skipLlm) return;

  // 3 + 4. LLM classification → category + topics + summary
  const classification = await classifyGmailThread({
    title: item.title,
    body: item.body,
    participants: Array.from(allEmails),
  });
  if (!classification) return;
  await persistGmailClassification(workspaceId, itemId, classification);
}

/**
 * Write a pre-computed classification (from the agent path, where the
 * agent runs the LLM call) to tags / entity_mentions / work_items.summary.
 * Idempotent — re-running replaces the prior state for this item only.
 *
 * Used by both:
 *   - enrichGmailItem (web-server inline path) after its own classifyGmailThread call
 *   - the agent job result handler when an agent posts back a classification
 */
export async function persistGmailClassification(
  workspaceId: string,
  itemId: string,
  classification: GmailClassification,
): Promise<void> {
  const db = getLibsqlDb();
  try {
    if (classification.category) {
      const tagId = await upsertTag(workspaceId, classification.category, 'gmail_category');
      await attachTag(itemId, tagId, 0.95);
    }
    for (const topic of classification.topics) {
      const tagId = await upsertTag(workspaceId, topic, 'topic');
      await attachTag(itemId, tagId, 0.9);
    }
    if (classification.summary) {
      await db
        .prepare(
          `UPDATE work_items SET summary = ?, enriched_at = datetime('now') WHERE id = ?`,
        )
        .run(classification.summary, itemId);
    } else {
      // Mark enriched even without summary so we don't re-enqueue.
      await db
        .prepare(`UPDATE work_items SET enriched_at = datetime('now') WHERE id = ? AND enriched_at IS NULL`)
        .run(itemId);
    }
    for (const ent of classification.entities) {
      try {
        const entityType = entityTypeForKind(ent.kind);
        const entityId = await upsertEntity(workspaceId, entityType, ent.name);
        await attachEntityMention(itemId, entityId, ent.name, 0.7);
      } catch {
        /* best-effort per entity */
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Public type for the agent path — the agent posts JSON of this shape.
 */
export type { GmailClassification };

/**
 * Enrich a batch of (source, source_id) tuples that were just ingested.
 * Filters to gmail items only. Used by the post-ingest hook so freshly-arrived
 * threads get classified without a separate backfill pass.
 *
 * Looks up work_items.id from (source, source_id) which is unique. Calls
 * enrichGmailItem in parallel with bounded concurrency.
 */
export async function enrichNewlyIngestedGmail(
  workspaceId: string,
  items: ReadonlyArray<{ source: string; source_id: string }>,
): Promise<void> {
  const gmailRefs = items.filter((i) => i.source === 'gmail');
  if (gmailRefs.length === 0) return;
  const db = getLibsqlDb();
  const placeholders = gmailRefs.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT id FROM work_items
       WHERE source = 'gmail' AND source_id IN (${placeholders})`,
    )
    .all<{ id: string }>(...gmailRefs.map((r) => r.source_id));

  const concurrency = 3;
  const queue = rows.map((r) => r.id);
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const itemId = queue.shift();
      if (!itemId) return;
      try {
        await enrichGmailItem(workspaceId, itemId);
      } catch {
        /* best-effort */
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

/**
 * Backfill: enrich every Gmail item that lacks enrichment (no enriched_at
 * timestamp), or all of them when force=true. Concurrency-limited so the
 * LLM call doesn't burst into rate limits.
 */
export async function enrichAllGmailItems(
  workspaceId: string,
  opts: { force?: boolean; limit?: number; concurrency?: number; skipLlm?: boolean } = {},
): Promise<{ scanned: number; enriched: number; skipped: number }> {
  const db = getLibsqlDb();
  const limit = opts.limit ?? 5000;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 8));
  const where = opts.force ? '' : 'AND (enriched_at IS NULL)';
  const rows = await db
    .prepare(
      `SELECT id FROM work_items
       WHERE source = 'gmail' ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all<{ id: string }>(limit);

  let enriched = 0;
  let skipped = 0;

  // Worker-pool style: process `concurrency` items at a time.
  const queue = rows.map((r) => r.id);
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const itemId = queue.shift();
      if (!itemId) return;
      try {
        await enrichGmailItem(workspaceId, itemId, { skipLlm: opts.skipLlm });
        enriched += 1;
      } catch {
        skipped += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return { scanned: rows.length, enriched, skipped };
}
