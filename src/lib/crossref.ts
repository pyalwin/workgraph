/**
 * Cross-reference: multi-signal pairwise link detection.
 *
 * Signals (0..1 each, aggregated with weights):
 *   - Explicit refs (Jira key regex / URL mention)  — caps at 1.0, short-circuit
 *   - Structural (PR↔commit same branch+sha prefix)   — caps at 1.0, short-circuit
 *   - Chunk-level embedding cosine (max across pairs)
 *   - Shared entities (rarity-weighted)
 *   - Shared author
 *   - Shared context (repo / project / channel)
 *   - Temporal proximity (used as a multiplier, not a base signal)
 *
 * Blocking (candidate reduction):
 *   - Items within ±90 days
 *   - Items sharing any entity tag
 *   - Items sharing the same author
 *   - Items whose chunks are vec0-near any chunk of the source item
 */
import { getDb } from './db';
import { v4 as uuid } from 'uuid';
import { getWorkspaceConfig } from './workspace-config';

const JIRA_KEY_REGEX = /[A-Z][A-Z0-9]+-\d+/g;
const MENTION_REGEX  = /@[\w.-]+/g;
const CHANNEL_REGEX  = /#[\w-]+/g;

export const LINK_THRESHOLD = 0.6;
export const WINDOW_DAYS = 90;
const CHUNK_TOP_K = 8;

const WEIGHTS = {
  embedding: 0.40,
  entities:  0.25,
  author:    0.15,
  context:   0.10,
  topics:    0.10,
};

function isSupporting(source: string): boolean {
  const config = getWorkspaceConfig();
  const sourceKind = config.sources[source]?.kind ?? source;
  return config.linking.supportingSourceKinds.includes(sourceKind);
}

function sourceKind(source: string): string {
  return getWorkspaceConfig().sources[source]?.kind ?? source;
}

export function extractEntities(text: string) {
  return {
    jiraKeys: [...new Set(text.match(JIRA_KEY_REGEX) || [])],
    mentions: [...new Set(text.match(MENTION_REGEX) || [])],
    channels: [...new Set(text.match(CHANNEL_REGEX) || [])],
  };
}

interface WorkItemRow {
  id: string;
  source: string;
  source_id: string;
  item_type: string;
  title: string;
  body: string | null;
  author: string | null;
  created_at: string;
  metadata: string | null;
}

// ──────────── link type + persistence (unchanged public behavior) ────────────

function determineLinkType(
  sourceItem: { source: string; item_type: string },
  targetSource: string,
): string {
  const sourceK = sourceKind(sourceItem.source);
  const targetK = sourceKind(targetSource);

  if (sourceK === 'code' && targetK === 'tracker') return 'executes';
  if (sourceK === 'tracker' && targetK === 'code') return 'executed_by';
  if (sourceK === 'document' || targetK === 'document') return 'references';
  if (
    sourceK === 'communication' ||
    targetK === 'communication' ||
    sourceK === 'meeting' ||
    targetK === 'meeting' ||
    sourceItem.item_type === 'message' ||
    sourceItem.item_type === 'meeting'
  ) return 'discusses';
  if (sourceK === targetK) return `related_${sourceK}`;
  return 'related';
}

function upsertLink(
  sourceItemId: string,
  targetItemId: string,
  linkType: string,
  confidence: number,
): string | null {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id, link_type, confidence FROM links WHERE source_item_id = ? AND target_item_id = ?',
  ).get(sourceItemId, targetItemId) as { id: string; link_type: string; confidence: number } | undefined;

  if (!existing) {
    const id = uuid();
    db.prepare(
      'INSERT INTO links (id, source_item_id, target_item_id, link_type, confidence) VALUES (?, ?, ?, ?, ?)',
    ).run(id, sourceItemId, targetItemId, linkType, confidence);
    return id;
  }

  let newType = existing.link_type;
  let newConfidence = existing.confidence;
  if (existing.link_type === 'mentions' && linkType !== 'mentions') newType = linkType;
  if (confidence > existing.confidence) newConfidence = confidence;
  if (newType !== existing.link_type || newConfidence !== existing.confidence) {
    db.prepare('UPDATE links SET link_type = ?, confidence = ? WHERE id = ?').run(newType, newConfidence, existing.id);
  }
  return existing.id;
}

function recordChunkEvidence(linkId: string, signals: ChunkEvidence[]) {
  if (!linkId || signals.length === 0) return;
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO item_links_chunks (link_id, source_chunk_id, target_chunk_id, signal, score)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const s of signals) {
      insert.run(
        linkId,
        s.sourceChunkId === null ? null : BigInt(s.sourceChunkId),
        s.targetChunkId === null ? null : BigInt(s.targetChunkId),
        s.signal,
        s.score,
      );
    }
  });
  tx();
}

interface ChunkEvidence {
  sourceChunkId: number | null;
  targetChunkId: number | null;
  signal: string;
  score: number;
}

// ──────────── candidate finding ────────────

function getItem(itemId: string): WorkItemRow | null {
  return getDb().prepare(`
    SELECT id, source, source_id, item_type, title, body, author, created_at, metadata
    FROM work_items WHERE id = ?
  `).get(itemId) as WorkItemRow | null;
}

function findCandidates(item: WorkItemRow): string[] {
  const db = getDb();
  const ids = new Set<string>();
  const itemText = `${item.title || ''}\n${item.body || ''}`;

  // Forward — per-connector reference detection. Each adapter declares how to
  // parse references to its own items out of free text (Jira keys, GitHub
  // owner/repo#N URLs, Notion page URLs, etc.). The DB lookup filters out
  // false positives by requiring the candidate to match an actual source_id.
  // This makes cross-ref org/system-agnostic — adding a new source plus its
  // idDetection handler means PRs can reference its items without changing
  // crossref itself.
  const { listConnectors } = require('./connectors/registry') as typeof import('./connectors/registry');
  for (const connector of listConnectors()) {
    if (!connector.idDetection) continue;
    const refs = connector.idDetection.findReferences(itemText);
    if (refs.length === 0) continue;
    const placeholders = refs.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id FROM work_items WHERE id != ? AND source = ? AND source_id IN (${placeholders})`,
    ).all(item.id, connector.source, ...refs) as { id: string }[];
    for (const r of rows) ids.add(r.id);
  }

  // Reverse — if this item's own source has idDetection AND its source_id
  // looks like an ID (not a derived bucket key), find items whose text
  // contains it. LIKE scan capped at 2× the time window.
  const selfConnector = listConnectors().find((c) => c.source === item.source);
  if (selfConnector?.idDetection && !item.source_id.startsWith('project:') && !item.source_id.startsWith('repo:') && !item.source_id.startsWith('release:')) {
    const reverseRows = db.prepare(`
      SELECT id FROM work_items
      WHERE id != ?
        AND (title LIKE '%' || ? || '%' OR body LIKE '%' || ? || '%')
        AND datetime(created_at) BETWEEN datetime(?, '-${WINDOW_DAYS * 2} days') AND datetime(?, '+${WINDOW_DAYS} days')
    `).all(item.id, item.source_id, item.source_id, item.created_at, item.created_at) as { id: string }[];
    for (const r of reverseRows) ids.add(r.id);
  }

  // Time window
  const created = item.created_at;
  const timeRows = db.prepare(`
    SELECT id FROM work_items
    WHERE id != ?
      AND datetime(created_at) BETWEEN datetime(?, '-${WINDOW_DAYS} days') AND datetime(?, '+${WINDOW_DAYS} days')
  `).all(item.id, created, created) as { id: string }[];
  for (const r of timeRows) ids.add(r.id);

  // Shared typed entities from the configurable ontology.
  const entityRows = db.prepare(`
    SELECT DISTINCT emb.item_id AS id
    FROM entity_mentions ema
    JOIN entity_mentions emb ON emb.entity_id = ema.entity_id AND emb.item_id != ema.item_id
    WHERE ema.item_id = ?
  `).all(item.id) as { id: string }[];
  for (const r of entityRows) ids.add(r.id);

  // Legacy fallback while old rows and enrichment tags still exist.
  const legacyEntityRows = db.prepare(`
    SELECT DISTINCT wb.id
    FROM item_tags ita
    JOIN item_tags itb ON itb.tag_id = ita.tag_id AND itb.item_id != ita.item_id
    JOIN tags t ON t.id = ita.tag_id AND t.category = 'entity'
    JOIN work_items wb ON wb.id = itb.item_id
    WHERE ita.item_id = ?
  `).all(item.id) as { id: string }[];
  for (const r of legacyEntityRows) ids.add(r.id);

  // Shared author (normalized)
  if (item.author && item.author.trim()) {
    const authRows = db.prepare(`
      SELECT id FROM work_items WHERE id != ? AND LOWER(author) = LOWER(?)
    `).all(item.id, item.author) as { id: string }[];
    for (const r of authRows) ids.add(r.id);
  }

  // Embedding neighbors: for each chunk of this item, fetch its vector and find top-K nearest
  const chunkRows = db.prepare('SELECT id FROM item_chunks WHERE item_id = ?').all(item.id) as { id: number }[];
  const matchStmt = db.prepare(`
    SELECT ic.item_id
    FROM vec_chunks_text v
    JOIN item_chunks ic ON ic.id = v.chunk_id
    WHERE v.embedding MATCH ?
      AND v.k = ?
      AND ic.item_id != ?
  `);
  for (const chunk of chunkRows) {
    const vec = loadEmbeddingVector(chunk.id);
    if (!vec) continue;
    try {
      const rows = matchStmt.all(JSON.stringify(Array.from(vec)), CHUNK_TOP_K + 1, item.id) as Array<{ item_id: string }>;
      for (const r of rows) ids.add(r.item_id);
    } catch {
      // fall back silently — other candidate paths will still contribute
    }
  }

  return [...ids];
}

// ──────────── pairwise signals ────────────

function loadItemChunks(itemId: string): Array<{ id: number; chunk_type: string; chunk_text: string }> {
  return getDb().prepare(`
    SELECT id, chunk_type, chunk_text FROM item_chunks WHERE item_id = ? ORDER BY position ASC
  `).all(itemId) as any[];
}

function loadEmbeddingVector(chunkId: number): Float32Array | null {
  const row = getDb().prepare(`SELECT embedding FROM vec_chunks_text WHERE chunk_id = ?`).get(BigInt(chunkId)) as { embedding?: Buffer } | undefined;
  if (!row?.embedding) return null;
  return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
}

function cosineBuf(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Build a regex that matches a literal source_id as a whole token, not as a
 *  prefix of a longer one. Without this, PEX-94 falsely matches inside PEX-948. */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function mentionsId(haystack: string, id: string): boolean {
  // \b before, then the literal id, then a non-{letter,digit,-} (or end-of-string)
  // boundary so PEX-948 doesn't match "PEX-94".
  const re = new RegExp(`(^|[^A-Za-z0-9-])${escapeForRegex(id)}(?![A-Za-z0-9-])`);
  return re.test(haystack);
}

function scoreExplicit(a: WorkItemRow, b: WorkItemRow): { score: number; note?: string } {
  const aText = `${a.title}\n${a.body || ''}`;
  const bText = `${b.title}\n${b.body || ''}`;

  // Does A mention B's tracker/source ID? Use whole-token match so PEX-94
  // doesn't false-positive against PEX-948.
  if (sourceKind(b.source) === 'tracker' && mentionsId(aText, b.source_id)) return { score: 1.0, note: `mentions ${b.source_id}` };
  if (sourceKind(a.source) === 'tracker' && mentionsId(bText, a.source_id)) return { score: 1.0, note: `mentions ${a.source_id}` };

  // Jira keys in both texts that match
  const keysA = new Set(aText.match(JIRA_KEY_REGEX) || []);
  const keysB = new Set(bText.match(JIRA_KEY_REGEX) || []);
  for (const k of keysA) if (keysB.has(k)) return { score: 0.8, note: `shared key ${k}` };

  // URL references
  if (['document', 'communication'].includes(sourceKind(a.source))) {
    if (sourceKind(b.source) === 'code' && b.metadata) {
      try {
        const m = JSON.parse(b.metadata);
        const urlHits = [m.url, `#${m.pr_number}`, m.sha?.slice?.(0, 7)].filter(Boolean);
        for (const u of urlHits) if (u && aText.includes(u)) return { score: 0.9, note: `url ref ${u}` };
      } catch {}
    }
  }

  return { score: 0 };
}

function scoreStructural(a: WorkItemRow, b: WorkItemRow): { score: number; note?: string } {
  const mA = a.metadata ? safeParse(a.metadata) : {};
  const mB = b.metadata ? safeParse(b.metadata) : {};

  // Code review artifact ↔ commit in same system + branch.
  if (sourceKind(a.source) === 'code' && sourceKind(b.source) === 'code') {
    if (a.item_type === 'pull_request' && b.item_type === 'commit' && mA.repo && mA.repo === mB.repo && mA.branch && mB.sha) {
      return { score: 1.0, note: 'PR↔commit same repo+branch' };
    }
    if (b.item_type === 'pull_request' && a.item_type === 'commit' && mB.repo === mA.repo && mB.branch && mA.sha) {
      return { score: 1.0, note: 'commit↔PR same repo+branch' };
    }
  }

  // Code branch metadata → tracker item key.
  if (sourceKind(a.source) === 'code' && sourceKind(b.source) === 'tracker' && mA.jira_key && mA.jira_key === b.source_id) {
    return { score: 1.0, note: `PR branch → ${b.source_id}` };
  }
  if (sourceKind(b.source) === 'code' && sourceKind(a.source) === 'tracker' && mB.jira_key && mB.jira_key === a.source_id) {
    return { score: 1.0, note: `PR branch → ${a.source_id}` };
  }

  // Slack thread parent ↔ reply (requires thread_ts stored in metadata)
  if (a.source === 'slack' && b.source === 'slack') {
    if (mA.thread_ts && mA.channel_id && mA.channel_id === mB.channel_id) {
      // a is a reply if thread_ts != its own ts; parent has thread_ts matching its own source_id
      const aTs = a.source_id.split(':')[1];
      const bTs = b.source_id.split(':')[1];
      if (mA.thread_ts === bTs || mB.thread_ts === aTs) {
        return { score: 1.0, note: 'slack thread parent↔reply' };
      }
    }
  }

  return { score: 0 };
}

function scoreEntities(aId: string, bId: string): { score: number; shared: string[] } {
  const config = getWorkspaceConfig();
  const rows = getDb().prepare(`
    SELECT e.canonical_form, e.entity_type, COUNT(DISTINCT emg.item_id) AS global_count
    FROM entity_mentions ema
    JOIN entity_mentions emb ON emb.entity_id = ema.entity_id AND emb.item_id = ?
    JOIN entities e ON e.id = ema.entity_id
    LEFT JOIN entity_mentions emg ON emg.entity_id = e.id
    WHERE ema.item_id = ?
    GROUP BY e.id
  `).all(bId, aId) as Array<{ canonical_form: string; entity_type: string; global_count: number }>;
  if (rows.length === 0) return { score: 0, shared: [] };

  // Type + rarity weighted: configured high-signal entity classes (for example
  // capability/system/artifact) score higher than weak context (actor/channel).
  let score = 0;
  for (const r of rows) {
    const rarity = Math.min(1, 5 / Math.max(1, r.global_count));
    const typeWeight = config.linking.entityWeights[r.entity_type] ?? config.linking.defaultEntityWeight;
    score += typeWeight * (0.5 + 0.5 * rarity);
  }
  return { score: Math.min(1, score), shared: rows.map(r => `${r.entity_type}:${r.canonical_form}`) };
}

function scoreTopics(aId: string, bId: string): { score: number; count: number } {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS c
    FROM item_tags ia
    JOIN item_tags ib ON ib.tag_id = ia.tag_id AND ib.item_id = ?
    JOIN tags t ON t.id = ia.tag_id
    WHERE ia.item_id = ? AND t.category = 'topic'
  `).get(bId, aId) as { c: number };
  if (!row.c) return { score: 0, count: 0 };
  return { score: Math.min(1, row.c * 0.3), count: row.c };
}

function scoreEmbedding(aId: string, bId: string): { score: number; bestChunks?: [number, number] } {
  const aChunks = getDb().prepare('SELECT id FROM item_chunks WHERE item_id = ?').all(aId) as { id: number }[];
  const bChunks = getDb().prepare('SELECT id FROM item_chunks WHERE item_id = ?').all(bId) as { id: number }[];
  if (aChunks.length === 0 || bChunks.length === 0) return { score: 0 };

  let best = 0;
  let bestPair: [number, number] | undefined;
  for (const ac of aChunks) {
    const va = loadEmbeddingVector(ac.id);
    if (!va) continue;
    for (const bc of bChunks) {
      const vb = loadEmbeddingVector(bc.id);
      if (!vb) continue;
      const s = cosineBuf(va, vb);
      if (s > best) { best = s; bestPair = [ac.id, bc.id]; }
    }
  }
  return { score: best, bestChunks: bestPair };
}

function scoreAuthor(a: WorkItemRow, b: WorkItemRow): number {
  if (!a.author || !b.author) return 0;
  return a.author.toLowerCase().trim() === b.author.toLowerCase().trim() ? 1 : 0;
}

function scoreContext(a: WorkItemRow, b: WorkItemRow): { score: number; note?: string } {
  const mA = a.metadata ? safeParse(a.metadata) : {};
  const mB = b.metadata ? safeParse(b.metadata) : {};
  if (mA.repo && mA.repo === mB.repo) return { score: 1, note: 'same repo' };
  if (mA.channel_id && mA.channel_id === mB.channel_id) return { score: 1, note: 'same channel' };
  if (mA.project && mA.project === mB.project) return { score: 1, note: 'same project' };
  if (a.source === 'jira' && b.source === 'jira') {
    const pA = a.source_id.split('-')[0];
    const pB = b.source_id.split('-')[0];
    if (pA === pB) return { score: 1, note: `same jira project ${pA}` };
  }
  return { score: 0 };
}

function temporalMultiplier(a: WorkItemRow, b: WorkItemRow): number {
  const aT = new Date(a.created_at).getTime();
  const bT = new Date(b.created_at).getTime();
  if (isNaN(aT) || isNaN(bT)) return 1;
  const daysApart = Math.abs(aT - bT) / (1000 * 60 * 60 * 24);
  if (daysApart <= 7) return 1.0;
  if (daysApart <= 30) return 0.9;
  if (daysApart <= 90) return 0.75;
  return 0.5;
}

function safeParse(s: string | null): any {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

// ──────────── driver ────────────

export function createLinksForItem(itemId: string): number {
  const item = getItem(itemId);
  if (!item) return 0;

  const candidateIds = findCandidates(item);
  const getCandidate = getDb().prepare(`
    SELECT id, source, source_id, item_type, title, body, author, created_at, metadata
    FROM work_items WHERE id = ?
  `);

  let created = 0;
  for (const cid of candidateIds) {
    const other = getCandidate.get(cid) as WorkItemRow | undefined;
    if (!other) continue;

    // Explicit or structural → short-circuit
    const exp = scoreExplicit(item, other);
    const str = scoreStructural(item, other);
    const hardScore = Math.max(exp.score, str.score);

    let finalScore: number;
    const signals: Record<string, number> = {};
    let bestChunks: [number, number] | undefined;

    if (hardScore >= 1.0) {
      finalScore = 1.0;
      if (exp.score > 0) signals.explicit = exp.score;
      if (str.score > 0) signals.structural = str.score;
    } else {
      const emb = scoreEmbedding(item.id, other.id);
      const ent = scoreEntities(item.id, other.id);
      const top = scoreTopics(item.id, other.id);
      const auth = scoreAuthor(item, other);
      const ctx = scoreContext(item, other);
      const tmul = temporalMultiplier(item, other);

      const weighted =
        WEIGHTS.embedding * emb.score +
        WEIGHTS.entities  * ent.score +
        WEIGHTS.topics    * top.score +
        WEIGHTS.author    * auth +
        WEIGHTS.context   * ctx.score;

      // Corroboration penalty — single weak signal shouldn't create a link.
      // Count how many signals cross a 0.2 noise threshold.
      const strongSignalCount = [emb.score, ent.score, top.score, auth, ctx.score].filter(s => s > 0.2).length;
      const corroboration = strongSignalCount >= 2 ? 1 : 0.75;

      // Supportive-source downweight — Notion/Meeting/Gmail connections without
      // an explicit reference are treated as supporting context, not primary
      // structural links.
      const supportMul = (isSupporting(item.source) || isSupporting(other.source)) ? 0.8 : 1;

      finalScore = Math.min(1, Math.max(hardScore, weighted * tmul * corroboration * supportMul));
      signals.embedding = emb.score;
      signals.entities = ent.score;
      signals.topics = top.score;
      signals.author = auth;
      signals.context = ctx.score;
      signals.temporal_mul = tmul;
      signals.corroboration = corroboration;
      signals.support_mul = supportMul;
      bestChunks = emb.bestChunks;
    }

    if (finalScore < LINK_THRESHOLD) continue;

    const linkType = determineLinkType(item, other.source);
    const linkId = upsertLink(item.id, other.id, linkType, finalScore);

    if (linkId) {
      const evidence: ChunkEvidence[] = [];
      for (const [k, v] of Object.entries(signals)) {
        if (v > 0 && k !== 'temporal_mul') {
          evidence.push({
            sourceChunkId: k === 'embedding' ? (bestChunks?.[0] ?? null) : null,
            targetChunkId: k === 'embedding' ? (bestChunks?.[1] ?? null) : null,
            signal: k,
            score: v,
          });
        }
      }
      recordChunkEvidence(linkId, evidence);
      created++;
    }
  }
  return created;
}

export function createLinksForAll(opts: { limit?: number } = {}): { items: number; links: number } {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id FROM work_items ORDER BY created_at DESC ${opts.limit ? 'LIMIT ?' : ''}
  `).all(...(opts.limit ? [opts.limit] : [])) as { id: string }[];

  let totalLinks = 0;
  let i = 0;
  for (const row of rows) {
    i++;
    if (i % 25 === 0) process.stdout.write(`  [${i}/${rows.length}] links=${totalLinks}\r`);
    totalLinks += createLinksForItem(row.id);
  }
  process.stdout.write('\n');
  return { items: rows.length, links: totalLinks };
}
