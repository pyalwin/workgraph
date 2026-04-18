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
  if (sourceItem.source === 'github' && targetSource === 'jira') return 'implements';
  if ((sourceItem.source === 'notion' || sourceItem.source === 'gmail') && targetSource === 'jira') return 'references';
  if (
    sourceItem.source === 'slack' ||
    sourceItem.source === 'meeting' ||
    sourceItem.item_type === 'message' ||
    sourceItem.item_type === 'meeting'
  ) return 'discusses';
  return 'mentions';
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

  // Time window
  const created = item.created_at;
  const timeRows = db.prepare(`
    SELECT id FROM work_items
    WHERE id != ?
      AND datetime(created_at) BETWEEN datetime(?, '-${WINDOW_DAYS} days') AND datetime(?, '+${WINDOW_DAYS} days')
  `).all(item.id, created, created) as { id: string }[];
  for (const r of timeRows) ids.add(r.id);

  // Shared entity tags
  const entityRows = db.prepare(`
    SELECT DISTINCT wb.id
    FROM item_tags ita
    JOIN item_tags itb ON itb.tag_id = ita.tag_id AND itb.item_id != ita.item_id
    JOIN tags t ON t.id = ita.tag_id AND t.category = 'entity'
    JOIN work_items wb ON wb.id = itb.item_id
    WHERE ita.item_id = ?
  `).all(item.id) as { id: string }[];
  for (const r of entityRows) ids.add(r.id);

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

function scoreExplicit(a: WorkItemRow, b: WorkItemRow): { score: number; note?: string } {
  const aText = `${a.title}\n${a.body || ''}`;
  const bText = `${b.title}\n${b.body || ''}`;

  // Does A mention B's source_id (Jira key / PR number / etc)?
  if (b.source === 'jira' && aText.includes(b.source_id)) return { score: 1.0, note: `mentions ${b.source_id}` };
  if (a.source === 'jira' && bText.includes(a.source_id)) return { score: 1.0, note: `mentions ${a.source_id}` };

  // Jira keys in both texts that match
  const keysA = new Set(aText.match(JIRA_KEY_REGEX) || []);
  const keysB = new Set(bText.match(JIRA_KEY_REGEX) || []);
  for (const k of keysA) if (keysB.has(k)) return { score: 0.8, note: `shared key ${k}` };

  // URL references
  if (a.source === 'notion' || a.source === 'gmail' || a.source === 'slack') {
    if (b.source === 'github' && b.metadata) {
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

  // PR ↔ commit in same repo + branch
  if (a.source === 'github' && b.source === 'github') {
    if (a.item_type === 'pull_request' && b.item_type === 'commit' && mA.repo && mA.repo === mB.repo && mA.branch && mB.sha) {
      return { score: 1.0, note: 'PR↔commit same repo+branch' };
    }
    if (b.item_type === 'pull_request' && a.item_type === 'commit' && mB.repo === mA.repo && mB.branch && mA.sha) {
      return { score: 1.0, note: 'commit↔PR same repo+branch' };
    }
  }

  // PR branch → Jira ticket key
  if (a.source === 'github' && b.source === 'jira' && mA.jira_key && mA.jira_key === b.source_id) {
    return { score: 1.0, note: `PR branch → ${b.source_id}` };
  }
  if (b.source === 'github' && a.source === 'jira' && mB.jira_key && mB.jira_key === a.source_id) {
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
  const rows = getDb().prepare(`
    SELECT t.name, t.category, COUNT(*) OVER (PARTITION BY t.id) AS global_count
    FROM item_tags ia
    JOIN item_tags ib ON ib.tag_id = ia.tag_id AND ib.item_id = ?
    JOIN tags t ON t.id = ia.tag_id
    WHERE ia.item_id = ? AND t.category = 'entity'
  `).all(bId, aId) as Array<{ name: string; category: string; global_count: number }>;
  if (rows.length === 0) return { score: 0, shared: [] };
  // Rarity-weighted: rare tags score higher
  let score = 0;
  for (const r of rows) {
    const rarity = Math.min(1, 5 / Math.max(1, r.global_count));
    score += 0.3 + 0.3 * rarity;
  }
  return { score: Math.min(1, score), shared: rows.map(r => r.name) };
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

      finalScore = Math.min(1, Math.max(hardScore, weighted * tmul));
      signals.embedding = emb.score;
      signals.entities = ent.score;
      signals.topics = top.score;
      signals.author = auth;
      signals.context = ctx.score;
      signals.temporal_mul = tmul;
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
