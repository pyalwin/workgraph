/**
 * Workstream assembly: from each seed, BFS the link graph to build a coherent
 * trace. Merge overlapping seed-frontiers. Handle orphan implementations.
 *
 * A workstream = set of work_items + link edges + a summary (generated separately).
 * Items can belong to multiple workstreams (multi-membership).
 */
import { getDb } from '../db';
import { v4 as uuid } from 'uuid';

const CONFIDENCE_THRESHOLD = 0.6;
const MAX_DEPTH = 4;

interface ItemRow {
  id: string;
  source: string;
  source_id: string;
  item_type: string;
  title: string;
  trace_role: string | null;
  trace_event_at: string | null;
  created_at: string;
}

interface Edge {
  source_item_id: string;
  target_item_id: string;
  confidence: number;
}

function loadItem(id: string): ItemRow | null {
  return getDb().prepare(`
    SELECT id, source, source_id, item_type, title, trace_role, trace_event_at, created_at
    FROM work_items WHERE id = ?
  `).get(id) as ItemRow | null;
}

function neighbors(itemId: string): Array<{ id: string; confidence: number }> {
  const db = getDb();
  return db.prepare(`
    SELECT target_item_id AS id, confidence FROM links
    WHERE source_item_id = ? AND confidence >= ?
    UNION
    SELECT source_item_id AS id, confidence FROM links
    WHERE target_item_id = ? AND confidence >= ?
  `).all(itemId, CONFIDENCE_THRESHOLD, itemId, CONFIDENCE_THRESHOLD) as Array<{ id: string; confidence: number }>;
}

/**
 * BFS from a seed up to MAX_DEPTH hops along confident edges. Returns the set
 * of item IDs reachable.
 */
function bfsFromSeed(seedId: string): Set<string> {
  const visited = new Set<string>([seedId]);
  const frontier: Array<{ id: string; depth: number }> = [{ id: seedId, depth: 0 }];

  while (frontier.length > 0) {
    const { id, depth } = frontier.shift()!;
    if (depth >= MAX_DEPTH) continue;
    for (const n of neighbors(id)) {
      if (visited.has(n.id)) continue;
      visited.add(n.id);
      frontier.push({ id: n.id, depth: depth + 1 });
    }
  }
  return visited;
}

/**
 * Merge sets that share any members into larger sets. Returns the merged groups.
 */
function mergeOverlapping(sets: Map<string, Set<string>>): Array<{ seedIds: string[]; members: Set<string> }> {
  const seedIds = [...sets.keys()];
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) && parent.get(cur) !== cur) cur = parent.get(cur)!;
    return cur;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const s of seedIds) parent.set(s, s);

  // Build inverted index: item → seeds that reach it
  const itemToSeeds = new Map<string, string[]>();
  for (const [seed, members] of sets) {
    for (const m of members) {
      if (!itemToSeeds.has(m)) itemToSeeds.set(m, []);
      itemToSeeds.get(m)!.push(seed);
    }
  }

  // Union seeds that share any member
  for (const seeds of itemToSeeds.values()) {
    for (let i = 1; i < seeds.length; i++) union(seeds[0], seeds[i]);
  }

  // Group seeds by root
  const groups = new Map<string, Set<string>>();
  for (const seed of seedIds) {
    const root = find(seed);
    if (!groups.has(root)) groups.set(root, new Set());
    const merged = groups.get(root)!;
    for (const m of sets.get(seed)!) merged.add(m);
    merged.add(seed);
  }

  return [...groups.entries()].map(([root, members]) => {
    const seeds = seedIds.filter(s => find(s) === root);
    return { seedIds: seeds, members };
  });
}

/**
 * Orphan handling: implementation items with no seed in any workstream get a
 * minimal workstream rooted at themselves, plus any upstream specification/decision
 * items reachable via BFS.
 */
function orphanWorkstreams(claimed: Set<string>): Array<{ seedIds: string[]; members: Set<string> }> {
  const db = getDb();
  const orphanImpls = db.prepare(`
    SELECT id FROM work_items
    WHERE trace_role = 'implementation' OR trace_role = 'integration'
  `).all() as { id: string }[];

  const out: Array<{ seedIds: string[]; members: Set<string> }> = [];
  for (const { id } of orphanImpls) {
    if (claimed.has(id)) continue;
    const members = bfsFromSeed(id);
    // Elect a pseudo-seed: prefer the earliest-dated specification item, else the orphan itself
    const memberItems = [...members].map(loadItem).filter((x): x is ItemRow => !!x);
    const spec = memberItems
      .filter(m => m.trace_role === 'specification')
      .sort((a, b) => (a.trace_event_at ?? a.created_at).localeCompare(b.trace_event_at ?? b.created_at))[0];
    const seed = spec?.id ?? id;
    out.push({ seedIds: [seed], members });
    for (const m of members) claimed.add(m);
  }
  return out;
}

function roleInWorkstream(item: ItemRow, isSeed: boolean, isTerminal: boolean): string | null {
  if (isSeed && item.trace_role !== 'seed') return 'seed'; // orphan-promoted seed
  return item.trace_role;
}

export interface AssembleResult {
  workstreams: number;
  items: number;
  seeds: number;
  orphans: number;
}

/**
 * Full recompute: wipe workstream tables and rebuild from scratch.
 * For incremental runs use reassembleForItem(itemId) (future).
 */
export function assembleAll(): AssembleResult {
  const db = getDb();

  const seeds = db.prepare(`
    SELECT id FROM work_items WHERE trace_role = 'seed'
  `).all() as { id: string }[];

  const bfsBySeed = new Map<string, Set<string>>();
  for (const s of seeds) bfsBySeed.set(s.id, bfsFromSeed(s.id));

  const merged = mergeOverlapping(bfsBySeed);
  const claimed = new Set<string>();
  for (const g of merged) for (const m of g.members) claimed.add(m);

  const orphans = orphanWorkstreams(claimed);

  // Persist: full recompute
  const wipeWS = db.prepare('DELETE FROM workstream_items');
  const wipeWSRoot = db.prepare('DELETE FROM workstreams');
  const insertWS = db.prepare(`
    INSERT INTO workstreams (id, earliest_at, latest_at, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `);
  const insertWSI = db.prepare(`
    INSERT INTO workstream_items (workstream_id, item_id, is_seed, is_terminal, role_in_workstream, event_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let totalItems = 0;
  const allGroups = [...merged, ...orphans];

  const tx = db.transaction(() => {
    wipeWS.run();
    wipeWSRoot.run();

    for (const group of allGroups) {
      const wsId = uuid();
      const items = [...group.members].map(loadItem).filter((x): x is ItemRow => !!x);
      if (items.length === 0) continue;

      const sorted = items.slice().sort((a, b) =>
        (a.trace_event_at ?? a.created_at).localeCompare(b.trace_event_at ?? b.created_at),
      );
      const earliest = sorted[0].trace_event_at ?? sorted[0].created_at;
      const latest = sorted[sorted.length - 1].trace_event_at ?? sorted[sorted.length - 1].created_at;

      insertWS.run(wsId, earliest, latest);

      const seedSet = new Set(group.seedIds);
      for (const item of items) {
        const isSeed = seedSet.has(item.id);
        const isTerminal = item.trace_role === 'integration';
        insertWSI.run(
          wsId,
          item.id,
          isSeed ? 1 : 0,
          isTerminal ? 1 : 0,
          roleInWorkstream(item, isSeed, isTerminal),
          item.trace_event_at ?? item.created_at,
        );
        totalItems++;
      }
    }
  });
  tx();

  return {
    workstreams: allGroups.length,
    items: totalItems,
    seeds: seeds.length,
    orphans: orphans.length,
  };
}

export function getWorkstreamItems(wsId: string): Array<ItemRow & { is_seed: number; is_terminal: number; role_in_workstream: string | null; event_at: string | null }> {
  return getDb().prepare(`
    SELECT wi.id, wi.source, wi.source_id, wi.item_type, wi.title,
           wi.trace_role, wi.trace_event_at, wi.created_at,
           wsi.is_seed, wsi.is_terminal, wsi.role_in_workstream, wsi.event_at
    FROM workstream_items wsi
    JOIN work_items wi ON wi.id = wsi.item_id
    WHERE wsi.workstream_id = ?
    ORDER BY COALESCE(wsi.event_at, wi.created_at) ASC
  `).all(wsId) as any[];
}

export function listWorkstreams(): Array<{ id: string; item_count: number; earliest_at: string; latest_at: string; generated_at: string | null; narrative: string | null }> {
  return getDb().prepare(`
    SELECT ws.id, ws.earliest_at, ws.latest_at, ws.generated_at, ws.narrative,
           COUNT(wsi.item_id) AS item_count
    FROM workstreams ws
    LEFT JOIN workstream_items wsi ON wsi.workstream_id = ws.id
    GROUP BY ws.id
    ORDER BY ws.latest_at DESC
  `).all() as any[];
}
