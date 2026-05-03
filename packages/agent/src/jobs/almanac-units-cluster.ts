import { createHash } from "node:crypto";
import { apiFetch } from "../client.js";
import type { JobHandler } from "./noop.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SourceEvent {
  sha: string;
  files_touched: string[];
  occurred_at: string;
}

interface ClusterParams {
  workspaceId: string;
  repo: string;
  sinceIso?: string;
  events?: SourceEvent[];
}

interface ClusterRecord {
  unit_id: string;
  file_set: string[];
  member_shas: string[];
  first_seen_at: string;
  last_active_at: string;
}

interface ClusterResult {
  repo: string;
  clusters: number;
  files: number;
  events_in: number;
}

// ---------------------------------------------------------------------------
// Param parsing
// ---------------------------------------------------------------------------

function assertString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`almanac.units.cluster: param '${name}' must be a non-empty string`);
  }
  return v;
}

function parseParams(params: unknown): ClusterParams {
  if (typeof params !== "object" || params === null) {
    throw new Error("almanac.units.cluster: params must be an object");
  }
  const p = params as Record<string, unknown>;
  const result: ClusterParams = {
    workspaceId: assertString(p["workspaceId"], "workspaceId"),
    repo: assertString(p["repo"], "repo"),
  };
  if (p["sinceIso"] !== undefined) {
    result.sinceIso = assertString(p["sinceIso"], "sinceIso");
  }
  if (p["events"] !== undefined) {
    if (!Array.isArray(p["events"])) {
      throw new Error("almanac.units.cluster: param 'events' must be an array");
    }
    result.events = (p["events"] as unknown[]).map((e, i) => {
      if (typeof e !== "object" || e === null) {
        throw new Error(`almanac.units.cluster: events[${i}] must be an object`);
      }
      const ev = e as Record<string, unknown>;
      return {
        sha: assertString(ev["sha"], `events[${i}].sha`),
        files_touched: Array.isArray(ev["files_touched"])
          ? (ev["files_touched"] as unknown[]).map((f) => String(f))
          : [],
        occurred_at: assertString(ev["occurred_at"], `events[${i}].occurred_at`),
      };
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fetch source events (GET fallback)
// ---------------------------------------------------------------------------

async function fetchSourceEvents(
  workspaceId: string,
  repo: string,
  sinceIso: string | undefined
): Promise<SourceEvent[]> {
  const qs = new URLSearchParams({ workspaceId, repo });
  if (sinceIso) qs.set("sinceIso", sinceIso);
  const path = `/api/almanac/clusters/source-events?${qs.toString()}`;
  try {
    const res = (await apiFetch(path)) as { events?: SourceEvent[] };
    return Array.isArray(res.events) ? res.events : [];
  } catch (err) {
    // Endpoint not yet built — log and return empty so we exit gracefully.
    console.warn(
      `[almanac.units.cluster] WARNING: GET ${path} failed — endpoint may not exist yet. ` +
        `No events fetched. Pass 'events' in params to avoid this. Error: ${String(err)}`
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Co-change matrix
// ---------------------------------------------------------------------------

// MAX_FILES_PER_EVENT: events touching more files than this are likely
// large-scale refactors or merges — they drown the signal, so skip them.
const MAX_FILES_PER_EVENT = 50;

/**
 * Graph type: adjacency map where graph[a][b] = co-change weight between a and b.
 * Only one direction is stored (a < b lexicographically) — the Louvain impl
 * mirrors weights when it needs both directions.
 */
type Graph = Map<string, Map<string, number>>;

/**
 * Build a weighted co-change graph from the event list.
 *
 * For each event with n = files_touched.length (2 ≤ n ≤ 50), every unordered
 * pair (f1, f2) gets weight += 1 / C(n, 2) = 2 / (n*(n-1)).
 * This normalises for commit size so a single mega-PR doesn't dominate.
 */
function buildCoChangeGraph(events: SourceEvent[]): Graph {
  const graph: Graph = new Map();

  function addEdge(a: string, b: string, weight: number): void {
    // Canonical order so we only store each undirected edge once.
    const [lo, hi] = a < b ? [a, b] : [b, a];
    if (!graph.has(lo)) graph.set(lo, new Map());
    const neighbors = graph.get(lo)!;
    neighbors.set(hi, (neighbors.get(hi) ?? 0) + weight);
  }

  for (const event of events) {
    const files = event.files_touched;
    const n = files.length;
    if (n < 2) continue;          // no edges possible
    if (n > MAX_FILES_PER_EVENT) continue; // likely noise event

    // C(n, 2) = n*(n-1)/2
    const pairs = (n * (n - 1)) / 2;
    const edgeWeight = 1 / pairs;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        addEdge(files[i]!, files[j]!, edgeWeight);
      }
    }
  }

  return graph;
}

// ---------------------------------------------------------------------------
// Vendored Louvain community detection
// ---------------------------------------------------------------------------
//
// Standard greedy Louvain (Blondel et al. 2008), 2-pass variant.
//
// Pass 1 (local): for each node (sorted alphabetically for determinism),
//   try moving it to each neighbouring community; keep the move if it yields
//   positive modularity gain ΔQ. Repeat until no node moves.
//
// Pass 2 (coarsening): build a "supergraph" where each community from pass 1
//   becomes a super-node; repeat pass 1 on the supergraph once.
//
// Returns a flat map: node → final community label.

/** Full symmetric adjacency needed by Louvain internals. */
type FullGraph = Map<string, Map<string, number>>;

/** Build full (symmetric) adjacency from the half-graph stored in buildCoChangeGraph. */
function toFullGraph(half: Graph): FullGraph {
  const full: FullGraph = new Map();

  function addSym(a: string, b: string, w: number): void {
    if (!full.has(a)) full.set(a, new Map());
    full.get(a)!.set(b, (full.get(a)!.get(b) ?? 0) + w);
    if (!full.has(b)) full.set(b, new Map());
    full.get(b)!.set(a, (full.get(b)!.get(a) ?? 0) + w);
  }

  for (const [a, neighbors] of half) {
    for (const [b, w] of neighbors) {
      addSym(a, b, w);
    }
  }

  return full;
}

/**
 * k_i: sum of all edge weights incident on node i (degree in weighted sense).
 */
function nodeDegree(full: FullGraph, node: string): number {
  let k = 0;
  for (const w of (full.get(node) ?? new Map()).values()) k += w;
  return k;
}

/**
 * One pass of greedy local modularity optimisation.
 *
 * community: mutable map node → communityId (string label).
 * Returns true if any node moved (used as the "keep iterating" signal).
 *
 * Modularity gain formula for moving node i into community C_j:
 *   ΔQ = [ (sumIn + 2·k_i_in) / 2m - ((sumTot + k_i) / 2m)² ]
 *        - [ sumIn / 2m - (sumTot / 2m)² - (k_i / 2m)² ]
 *
 * Where:
 *   m        = total edge weight (sum of all weights in graph, counted once)
 *   k_i      = weighted degree of node i
 *   k_i_in   = sum of weights from i to members of C_j
 *   sumIn    = sum of intra-community weights for C_j (each edge counted twice
 *              in the standard Louvain formulation: once per endpoint)
 *   sumTot   = sum of all edge weights incident on members of C_j
 */
function localMovePass(
  full: FullGraph,
  community: Map<string, string>,
  m: number
): boolean {
  let anyMoved = false;

  // Sort nodes alphabetically for deterministic output.
  const nodes = [...full.keys()].sort();

  // Precompute per-community sumIn and sumTot.
  // sumIn[c]  = Σ w(u,v) for all edges where both u,v ∈ c  (counted twice: once per endpoint)
  // sumTot[c] = Σ k_u for all u ∈ c
  const sumIn: Map<string, number> = new Map();
  const sumTot: Map<string, number> = new Map();

  for (const node of nodes) {
    const c = community.get(node)!;
    const ki = nodeDegree(full, node);
    sumTot.set(c, (sumTot.get(c) ?? 0) + ki);

    // Intra-community edges — look at all neighbors in same community.
    for (const [nb, w] of (full.get(node) ?? new Map())) {
      if (community.get(nb) === c) {
        // Each edge will be counted twice (from both endpoints) — that matches
        // the standard Louvain convention where sumIn uses doubled weights.
        sumIn.set(c, (sumIn.get(c) ?? 0) + w);
      }
    }
  }

  const inv2m = 1 / (2 * m); // 1/(2m) scalar used repeatedly below

  for (const node of nodes) {
    const currentCom = community.get(node)!;
    const ki = nodeDegree(full, node);
    const neighbors = full.get(node) ?? new Map();

    // k_i_in for current community (before removal)
    let kiInCurrent = 0;
    for (const [nb, w] of neighbors) {
      if (community.get(nb) === currentCom && nb !== node) kiInCurrent += w;
    }

    // --- Compute ΔQ for removing node from its current community ---
    // This uses the same formula in reverse (subtracting i from C_current).
    // We'll reference it when comparing candidate communities.
    const sumInC = sumIn.get(currentCom) ?? 0;
    const sumTotC = sumTot.get(currentCom) ?? 0;

    // ΔQ_remove = -[kiInCurrent/m - sumTotC*ki*(2m)^{-2}]
    //           = -kiInCurrent/m + sumTotC*ki / (2m²)
    // We fold this into the gain calculation below (total gain = gain_add + gain_remove).

    // Gather candidate communities from neighbours (plus current community).
    const candidateComs = new Set<string>();
    for (const nb of neighbors.keys()) candidateComs.add(community.get(nb)!);
    // Always consider moving to a fresh isolated community (ΔQ there = 0 by construction,
    // so we only move if a neighbour community is strictly better).

    let bestGain = 0;
    let bestCom = currentCom;

    for (const cj of candidateComs) {
      if (cj === currentCom) continue;

      const sumInJ = sumIn.get(cj) ?? 0;
      const sumTotJ = sumTot.get(cj) ?? 0;

      // k_i_in for candidate community C_j
      let kiInJ = 0;
      for (const [nb, w] of neighbors) {
        if (community.get(nb) === cj) kiInJ += w;
      }

      // ΔQ for *adding* i to C_j:
      //   term_add = (sumInJ + 2·kiInJ) / 2m  -  ((sumTotJ + ki) / 2m)²
      //            - [ sumInJ / 2m  -  (sumTotJ / 2m)²  -  (ki / 2m)² ]
      //
      // Expanding:
      //   = (sumInJ + 2·kiInJ)·inv2m
      //     - (sumTotJ + ki)²·inv2m²
      //     - sumInJ·inv2m
      //     + sumTotJ²·inv2m²
      //     + ki²·inv2m²
      //
      // = 2·kiInJ·inv2m  -  [ (sumTotJ + ki)² - sumTotJ² - ki² ]·inv2m²
      // = 2·kiInJ·inv2m  -  [ 2·sumTotJ·ki ]·inv2m²
      // = inv2m·[ 2·kiInJ  -  sumTotJ·ki·inv2m·2 ]
      // = inv2m·[ 2·kiInJ  -  sumTotJ·ki / m ]
      const deltaQAdd =
        inv2m * (2 * kiInJ - sumTotJ * ki * inv2m * 2);

      // ΔQ for *removing* i from C_current (negative of adding back):
      //   = -(inv2m · [2·kiInCurrent - (sumTotC - ki)·ki / m ])
      // Note: after removal, sumTot of C_current becomes sumTotC - ki.
      const deltaQRemove =
        -(inv2m * (2 * kiInCurrent - (sumTotC - ki) * ki * inv2m * 2));

      const totalGain = deltaQAdd + deltaQRemove;

      if (totalGain > bestGain) {
        bestGain = totalGain;
        bestCom = cj;
      }
    }

    if (bestCom !== currentCom) {
      // Update sumIn and sumTot bookkeeping for the move.
      // Remove i from currentCom
      sumIn.set(currentCom, (sumIn.get(currentCom) ?? 0) - 2 * kiInCurrent);
      sumTot.set(currentCom, (sumTot.get(currentCom) ?? 0) - ki);

      // k_i_in for bestCom (already computed in the loop above, recompute cheaply)
      let kiInBest = 0;
      for (const [nb, w] of neighbors) {
        if (community.get(nb) === bestCom) kiInBest += w;
      }

      // Add i to bestCom
      sumIn.set(bestCom, (sumIn.get(bestCom) ?? 0) + 2 * kiInBest);
      sumTot.set(bestCom, (sumTot.get(bestCom) ?? 0) + ki);

      community.set(node, bestCom);
      anyMoved = true;
    }
  }

  return anyMoved;
}

/**
 * Build a coarsened supergraph from the current community assignment.
 * Each unique community label becomes a super-node.
 * Edge weights between super-nodes = sum of weights between their member nodes.
 */
function buildSupergraph(
  full: FullGraph,
  community: Map<string, string>
): { supergraph: FullGraph; superCommunity: Map<string, string> } {
  const supergraph: FullGraph = new Map();

  for (const [node, neighbors] of full) {
    const sc = community.get(node)!;
    for (const [nb, w] of neighbors) {
      if (nb <= node) continue; // process each undirected edge once

      const snb = community.get(nb)!;
      if (sc === snb) continue; // intra-community edges become self-loops in supergraph (skip)

      // Add weight in both directions
      if (!supergraph.has(sc)) supergraph.set(sc, new Map());
      if (!supergraph.has(snb)) supergraph.set(snb, new Map());
      supergraph.get(sc)!.set(snb, (supergraph.get(sc)!.get(snb) ?? 0) + w);
      supergraph.get(snb)!.set(sc, (supergraph.get(snb)!.get(sc) ?? 0) + w);
    }
  }

  // Ensure all communities have a node in the supergraph (even isolated ones)
  for (const c of new Set(community.values())) {
    if (!supergraph.has(c)) supergraph.set(c, new Map());
  }

  // Initial super-community: each super-node in its own community.
  const superCommunity: Map<string, string> = new Map();
  for (const sc of supergraph.keys()) superCommunity.set(sc, sc);

  return { supergraph, superCommunity };
}

/**
 * Main Louvain entry point.
 *
 * @param halfGraph  — the half-adjacency produced by buildCoChangeGraph
 * @param passes     — number of hierarchical passes (default 2)
 * @returns Map<node, communityId> where communityId is an opaque string label
 */
function louvain(halfGraph: Graph, passes = 2): Map<string, string> {
  const nodes = [...new Set([...halfGraph.keys(), ...[...halfGraph.values()].flatMap((m) => [...m.keys()])])];

  if (nodes.length === 0) return new Map();

  const full = toFullGraph(halfGraph);

  // Total edge weight m — sum of all edge weights, each edge counted once.
  // toFullGraph doubles each weight (both directions), so sum(full)/2 = m.
  let m = 0;
  for (const neighbors of full.values()) for (const w of neighbors.values()) m += w;
  m /= 2; // correct for double-counting in symmetric graph

  if (m === 0) {
    // Disconnected graph with no edges — each node is its own community.
    const isolated = new Map<string, string>();
    for (const n of nodes) isolated.set(n, n);
    return isolated;
  }

  // Pass 1: local moves on the original graph.
  // Start with each node in its own community (label = node name — alphabetically stable).
  const community: Map<string, string> = new Map();
  for (const n of [...full.keys()].sort()) community.set(n, n);

  // Iterate local moves until convergence or max 50 iterations.
  const MAX_ITER = 50;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const moved = localMovePass(full, community, m);
    if (!moved) break;
  }

  if (passes <= 1) {
    return community;
  }

  // Pass 2: build supergraph from pass-1 communities, run one more local-move pass.
  const { supergraph, superCommunity } = buildSupergraph(full, community);

  // Compute m for supergraph
  let mSuper = 0;
  for (const neighbors of supergraph.values()) for (const w of neighbors.values()) mSuper += w;
  mSuper /= 2;

  if (mSuper > 0) {
    const MAX_ITER_SUPER = 50;
    for (let iter = 0; iter < MAX_ITER_SUPER; iter++) {
      const moved = localMovePass(supergraph, superCommunity, mSuper);
      if (!moved) break;
    }
  }

  // Map original nodes → super-community label (two-hop: node → pass1com → pass2com)
  const finalCommunity = new Map<string, string>();
  for (const [node, c1] of community) {
    // c1 is the pass-1 community label, which is also a super-node in the supergraph.
    const c2 = superCommunity.get(c1) ?? c1;
    finalCommunity.set(node, c2);
  }

  return finalCommunity;
}

// ---------------------------------------------------------------------------
// Cluster ID: deterministic sha1 of sorted file list
// ---------------------------------------------------------------------------

function clusterIdFromFiles(files: string[]): string {
  const sorted = [...files].sort();
  return createHash("sha1").update(JSON.stringify(sorted)).digest("hex").toLowerCase();
}

// ---------------------------------------------------------------------------
// Minimum thresholds
// ---------------------------------------------------------------------------

const MIN_FILES_PER_CLUSTER = 3;
const MIN_EVENTS_PER_CLUSTER = 3;
const MIN_OVERLAP_RATIO = 0.5; // for "member_shas": >= 50% of event files in cluster

// ---------------------------------------------------------------------------
// POST clusters
// ---------------------------------------------------------------------------

async function postClusters(
  workspaceId: string,
  repo: string,
  clusters: ClusterRecord[]
): Promise<void> {
  await apiFetch("/api/almanac/clusters/ingest", {
    method: "POST",
    body: { workspaceId, repo, clusters },
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const almanacUnitsClusterHandler: JobHandler = async (
  params: unknown
): Promise<ClusterResult> => {
  const p = parseParams(params);

  // 1. Assemble events list.
  //    Prefer events provided in params (Inngest may supply them inline).
  //    Fall back to GET endpoint; if that fails, log warning and exit early.
  let events: SourceEvent[];
  if (p.events !== undefined) {
    events = p.events;
  } else {
    events = await fetchSourceEvents(p.workspaceId, p.repo, p.sinceIso);
  }

  // Apply sinceIso filter when events came from params (GET path already filtered server-side).
  if (p.events !== undefined && p.sinceIso !== undefined) {
    const since = p.sinceIso;
    events = events.filter((e) => e.occurred_at >= since);
  }

  console.log(
    `[almanac.units.cluster] repo=${p.repo} events_in=${events.length}`
  );

  // 2. Early-out: no signal events → nothing to cluster.
  if (events.length === 0) {
    return { repo: p.repo, clusters: 0, files: 0, events_in: 0 };
  }

  // 3. Build co-change graph.
  const halfGraph = buildCoChangeGraph(events);

  // 4. Run 2-pass Louvain on the co-change graph.
  const communityMap = louvain(halfGraph, 2);

  // 5. Invert community map: communityId → set of files.
  const comToFiles = new Map<string, Set<string>>();
  for (const [file, com] of communityMap) {
    if (!comToFiles.has(com)) comToFiles.set(com, new Set());
    comToFiles.get(com)!.add(file);
  }

  // 6. For each community, compute cluster record.
  //    Filter: drop clusters with < MIN_FILES_PER_CLUSTER files OR < MIN_EVENTS_PER_CLUSTER events.
  const clusters: ClusterRecord[] = [];
  let totalDistinctFiles = 0;

  for (const [, fileSet] of comToFiles) {
    const fileArr = [...fileSet].sort();
    if (fileArr.length < MIN_FILES_PER_CLUSTER) continue;

    // Determine member events: events where >= 50% of their files_touched
    // are in this cluster's file_set (and the event touches at least 2 files overall).
    const fileSetForLookup = new Set(fileArr);
    const memberEvents: SourceEvent[] = [];
    for (const event of events) {
      const touched = event.files_touched;
      if (touched.length < 2) continue;
      const inCluster = touched.filter((f) => fileSetForLookup.has(f)).length;
      if (inCluster / touched.length >= MIN_OVERLAP_RATIO) {
        memberEvents.push(event);
      }
    }

    if (memberEvents.length < MIN_EVENTS_PER_CLUSTER) continue;

    const unit_id = clusterIdFromFiles(fileArr);

    // Compute time range from member events.
    const times = memberEvents.map((e) => e.occurred_at).sort();
    const first_seen_at = times[0]!;
    const last_active_at = times[times.length - 1]!;

    clusters.push({
      unit_id,
      file_set: fileArr,
      member_shas: memberEvents.map((e) => e.sha),
      first_seen_at,
      last_active_at,
    });

    totalDistinctFiles += fileArr.length;
  }

  console.log(
    `[almanac.units.cluster] repo=${p.repo} clusters_surviving=${clusters.length} total_files=${totalDistinctFiles}`
  );

  // 7. POST to ingest endpoint (only if we have surviving clusters).
  if (clusters.length > 0) {
    await postClusters(p.workspaceId, p.repo, clusters);
  }

  return {
    repo: p.repo,
    clusters: clusters.length,
    files: totalDistinctFiles,
    events_in: events.length,
  };
};
