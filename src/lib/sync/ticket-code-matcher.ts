/**
 * Ticket-first matcher (Almanac Phase 3 — KAN-45).
 *
 * Inverse of unmatched-pr-matcher.ts: given a Jira ticket with no linked
 * code evidence, find PRs / branches / commits that plausibly represent it.
 *
 * Match ladder:
 *   Tier A — PR vector + GitHub PR search        → auto-attach at score >= 0.75
 *   Tier B — Branch fuzzy name match             → always queue (cap 0.7)
 *   Tier C — Commit vector + list_commits        → always queue (cap 0.7)
 *
 * All candidates land in orphan_ticket_candidates for audit; Tier A
 * high-confidence hits also update code_events (linked_item_id etc.)
 * and set accepted_at on the candidate row.
 */
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { searchChunks } from '../embeddings/embed';
import { connectMCP, resolveServerConfig } from '../connectors/mcp-client';
import { getConnectorConfigBySource } from '../connectors/config-store';

// Auto-attach gate — matches almanac-plan.md locked decision.
const AUTO_ATTACH_THRESHOLD = 0.75;

// Vector path is available; score capped here so text-fallback never
// auto-attaches even if cosine sim is accidentally high.
const TEXT_FALLBACK_SCORE_CAP = 0.5;

// Branch similarity threshold for Tier B.
const BRANCH_SIM_THRESHOLD = 0.6;

// Tier B and C are queue-only; cap prevents them ever clearing the 0.75 gate.
const TIER_BC_SCORE_CAP = 0.7;

// Levenshtein-inspired ratio (Sorensen–Dice on token bigrams) — no npm dep.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function tokenBigrams(s: string): Set<string> {
  const tokens = s.replace(/[^a-z0-9]/gi, ' ').toLowerCase().split(/\s+/).filter(Boolean);
  const bg = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) bg.add(`${tokens[i]}|${tokens[i + 1]}`);
  // Also add unigrams so short strings still get a score.
  for (const t of tokens) bg.add(t);
  return bg;
}

function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  const sa = tokenBigrams(a);
  const sb = tokenBigrams(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const total = sa.size + sb.size;
  if (total === 0) return 0;
  return (2 * inter) / total;
}

// Map distance [0,2] → similarity [0,1] — mirrors unmatched-pr-matcher.ts.
function toScore(distance: number): number {
  return 1 - Math.min(1, Math.max(0, distance));
}

// Pull first N simple nouns from title — stop-word stripped, alpha only.
const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
  'from','as','is','was','are','were','be','been','has','have','had','do','does',
  'did','will','would','could','should','may','might','shall','can','need','not',
  'no','this','that','it','its','we','our','they','their','add','update','fix',
  'allow','enable','disable','remove','delete','create','change','use','set',
]);

function extractNouns(title: string, n: number): string[] {
  return title
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, n);
}

// ─── Public interfaces ──────────────────────────────────────────────────────

export interface OrphanTicket {
  id: string;            // work_items.id (UUID)
  source_id: string;     // Jira key, e.g. 'KAN-12'
  title: string;
  body: string | null;
  assignee: string | null;
  status: string | null;
  created_at: string;
  updated_at: string | null;
  project_key: string;   // 'KAN' from 'KAN-12'
}

export interface MatchResult {
  issueItemId: string;
  candidates: Array<{
    evidence_kind: 'pr' | 'branch' | 'commit';
    tier_reached: 'A' | 'B' | 'C';
    candidate_ref: string;    // e.g. 'owner/repo#42' or 'owner/repo@<sha>'
    score: number;
    signals: Record<string, unknown>;
  }>;
  auto_attached: number;      // count of code_events rows linked this run
}

// ─── Schema bootstrap ───────────────────────────────────────────────────────

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

// ─── Orphan-ticket finder ────────────────────────────────────────────────────

/**
 * Returns Jira work_items that have no issue_trails row and are in a status
 * suggesting they should have shipped (i.e. not Open/Backlog). Epics and
 * drafts are excluded. Age window: 7 days – 18 months.
 */
export async function findOrphanTickets(workspaceId: string): Promise<OrphanTicket[]> {
  await ensureInit();
  const db = getLibsqlDb();

  // 18-month and 7-day age bounds keep the candidate set tractable and ensure
  // the ticket is old enough to have code evidence but not so old the repo
  // context no longer exists locally.
  const cutoffOld = new Date();
  cutoffOld.setMonth(cutoffOld.getMonth() - 18);
  const cutoffFresh = new Date();
  cutoffFresh.setDate(cutoffFresh.getDate() - 7);

  interface RawRow {
    id: string;
    source_id: string;
    title: string;
    body: string | null;
    author: string | null;
    status: string | null;
    created_at: string;
    updated_at: string | null;
  }

  const rows = await db
    .prepare(
      `SELECT w.id, w.source_id, w.title, w.body, w.author, w.status,
              w.created_at, w.updated_at
       FROM work_items w
       WHERE w.source = 'jira'
         AND w.item_type != 'epic'
         AND w.status NOT IN ('Open','Backlog')
         AND w.title NOT LIKE 'Draft:%'
         AND w.title NOT LIKE '[Draft]%'
         AND w.created_at >= ?
         AND w.created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM issue_trails t WHERE t.issue_item_id = w.id
         )
       ORDER BY w.created_at DESC
       LIMIT 200`,
    )
    .all<RawRow>(cutoffOld.toISOString(), cutoffFresh.toISOString());

  return rows.map(r => {
    // Extract project key from Jira source_id like 'KAN-12' → 'KAN'.
    const project_key = r.source_id.replace(/-\d+$/, '');
    return {
      id: r.id,
      source_id: r.source_id,
      title: r.title,
      body: r.body,
      assignee: r.author,   // work_items.author holds the Jira assignee login
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      project_key,
    };
  });
}

// ─── GitHub MCP helpers (best-effort — skip cleanly if unavailable) ─────────

// Workspace ID cached for the lifetime of a matchTicket() call cycle so we
// don't re-open a new MCP connection per ticket.
let _mcpClient: { client: Awaited<ReturnType<typeof connectMCP>>; workspaceId: string } | null = null;

async function getMcpClient(workspaceId: string): Promise<Awaited<ReturnType<typeof connectMCP>> | null> {
  if (_mcpClient?.workspaceId === workspaceId) return _mcpClient.client;
  try {
    const serverCfg = await resolveServerConfig('github', 'github', workspaceId, process.env);
    if (!serverCfg) return null;
    const client = await connectMCP(serverCfg);
    _mcpClient = { client, workspaceId };
    return client;
  } catch {
    // MCP server not available in this environment — degrade gracefully.
    return null;
  }
}

/** Search merged PRs via GitHub MCP `search_issues` (search_pull_requests isn't a
 *  standard GitHub MCP tool; search_issues with `type:pr` is). Falls back to
 *  list_pull_requests if search_issues also fails. Returns raw PR-like objects. */
async function searchMergedPrs(
  client: NonNullable<Awaited<ReturnType<typeof getMcpClient>>>,
  repo: string,
  query: string,
): Promise<Array<{ number: number; title: string; merged_at?: string | null; user?: { login?: string } }>> {
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return [];

  // Try GitHub MCP `search_issues` with is:merged is:pr qualifier.
  // The official GitHub MCP server exposes `search_issues`; some forks may
  // call it `search_pull_requests` — we fall through on error.
  try {
    const resp: any = await client.callTool('search_issues', {
      query: `repo:${repo} is:pr is:merged ${query}`,
      per_page: 10,
    });
    const items: any[] = Array.isArray(resp) ? resp
      : Array.isArray(resp?.items) ? resp.items
      : Array.isArray(resp?.results) ? resp.results
      : [];
    return items.slice(0, 10);
  } catch {
    // Fallback: list recent merged PRs for the repo (no keyword filtering).
    try {
      const resp: any = await client.callTool('list_pull_requests', {
        owner,
        repo: repoName,
        state: 'closed',
        per_page: 30,
      });
      const items: any[] = Array.isArray(resp) ? resp : Array.isArray(resp?.pull_requests) ? resp.pull_requests : [];
      // Keep only merged ones that likely match.
      return items.filter((pr: any) => pr.merged_at).slice(0, 10);
    } catch {
      return [];
    }
  }
}

async function listBranches(
  client: NonNullable<Awaited<ReturnType<typeof getMcpClient>>>,
  repo: string,
): Promise<Array<{ name: string }>> {
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return [];
  try {
    const resp: any = await client.callTool('list_branches', {
      owner,
      repo: repoName,
      per_page: 100,
    });
    const items: any[] = Array.isArray(resp) ? resp : Array.isArray(resp?.branches) ? resp.branches : [];
    return items.map((b: any) => ({ name: typeof b === 'string' ? b : (b.name ?? '') }));
  } catch {
    return [];
  }
}

async function listCommits(
  client: NonNullable<Awaited<ReturnType<typeof getMcpClient>>>,
  repo: string,
  opts: { author?: string | null; since?: string; until?: string },
): Promise<Array<{ sha: string; commit?: { message?: string; author?: { name?: string; date?: string } }; author?: { login?: string } }>> {
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return [];
  try {
    const args: Record<string, unknown> = { owner, repo: repoName, per_page: 30 };
    if (opts.author) args.author = opts.author;
    if (opts.since) args.since = opts.since;
    if (opts.until) args.until = opts.until;
    const resp: any = await client.callTool('list_commits', args);
    return Array.isArray(resp) ? resp : Array.isArray(resp?.commits) ? resp.commits : [];
  } catch {
    return [];
  }
}

// ─── Repo list helper ────────────────────────────────────────────────────────

async function getConfiguredRepos(workspaceId: string): Promise<string[]> {
  try {
    const cfg = await getConnectorConfigBySource(workspaceId, 'github');
    if (!cfg) return [];
    const repos = (cfg.config.options?.repos as Array<{ id: string }> | undefined) ?? [];
    return repos.map(r => r.id).filter(Boolean);
  } catch {
    return [];
  }
}

// ─── matchTicket() ────────────────────────────────────────────────────────────

export async function matchTicket(workspaceId: string, ticket: OrphanTicket): Promise<MatchResult> {
  await ensureInit();
  const db = getLibsqlDb();

  const result: MatchResult = {
    issueItemId: ticket.id,
    candidates: [],
    auto_attached: 0,
  };

  const repos = await getConfiguredRepos(workspaceId);
  const mcpClient = await getMcpClient(workspaceId);

  // Build query text from ticket fields — same shape as buildPrQueryText() in
  // unmatched-pr-matcher.ts so we reuse the same vector index.
  const queryText = [ticket.source_id, ticket.title, ticket.body ?? ''].join('\n').slice(0, 4000);

  // ── Tier A: PR vector + optional GitHub MCP search ─────────────────────────

  const SEARCH_K = 20;
  let vectorHits: Awaited<ReturnType<typeof searchChunks>> = [];
  let vectorAvailable = true;

  try {
    // searchChunks looks against work_items (Jira chunks), so we scope to
    // code_events via a separate DB query below. For Tier A, we want to find
    // code_events whose message or files text overlaps with the ticket.
    // The codebase's searchChunks is designed for work_items (Jira source).
    // We do a two-pass approach:
    //   1. Vector search against work_items chunks to bootstrap similarity score.
    //   2. Then search code_events by ticket key + nouns (text match).
    vectorHits = await searchChunks(queryText, SEARCH_K);
  } catch {
    // searchChunks unavailable (embedding model offline, etc.) — use text path.
    vectorAvailable = false;
  }

  // Text-fallback: find code_events whose message mentions the ticket key or
  // significant nouns from the title. Score capped at TEXT_FALLBACK_SCORE_CAP
  // so it never auto-attaches.
  const nouns = extractNouns(ticket.title, 3);
  const keyInMsgSql = nouns.length > 0
    ? `(message LIKE ? OR message LIKE ? OR ${nouns.map(() => 'message LIKE ?').join(' OR ')})`
    : `message LIKE ?`;

  const keyPattern = `%${ticket.source_id}%`;
  const keyPatternNoSpace = `%${ticket.source_id.replace('-', '')}%`; // e.g. KAN12
  const nounPatterns = nouns.map(n => `%${n}%`);

  interface CodeEventRow {
    id: string;
    repo: string;
    sha: string;
    pr_number: number | null;
    kind: string;
    author_login: string | null;
    occurred_at: string;
    message: string | null;
  }

  const textMatchedPrs = await db
    .prepare(
      `SELECT id, repo, sha, pr_number, kind, author_login, occurred_at, message
       FROM code_events
       WHERE workspace_id = ?
         AND kind = 'pr_merged'
         AND ${keyInMsgSql}
       ORDER BY occurred_at DESC
       LIMIT 10`,
    )
    .all<CodeEventRow>(workspaceId, keyPattern, keyPatternNoSpace, ...nounPatterns);

  // Collect PRs from vector hits by looking up code_events linked to matching
  // work_items (cross-reference path). In practice the vector index covers
  // Jira chunks, not code_events directly, so vectorHits gives related issue
  // chunks — we use them purely as a confidence signal rather than as direct
  // PR links.
  const vectorItemIds = new Set(vectorHits.map(h => h.item_id));
  const vectorScore = vectorHits.length > 0 ? toScore(vectorHits[0].distance) : 0;

  // Augment with GitHub MCP if available.
  let mcpPrs: Array<{ number: number; title: string; merged_at?: string | null; user?: { login?: string } }> = [];
  if (mcpClient) {
    const searchQuery = [ticket.source_id, ...nouns].join(' ');
    for (const repo of repos) {
      const prs = await searchMergedPrs(mcpClient, repo, searchQuery);
      mcpPrs = mcpPrs.concat(prs.map(p => ({ ...p, _repo: repo } as any)));
    }
  }

  // Build Tier A candidates — combine text-matched + MCP results, score them.
  const seenRefs = new Set<string>();

  for (const ce of textMatchedPrs) {
    const ref = ce.pr_number != null ? `${ce.repo}#${ce.pr_number}` : `${ce.repo}@${ce.sha}`;
    if (seenRefs.has(ref)) continue;
    seenRefs.add(ref);

    const keyInTitle = (ce.message ?? '').includes(ticket.source_id) ? 0.3 : 0;
    const assigneeMatch = ticket.assignee && ce.author_login
      ? (ce.author_login.toLowerCase() === ticket.assignee.toLowerCase() ? 0.1 : 0)
      : 0;

    // Merge-time within ticket close window: ticket.updated_at ± 14 days.
    let mergeTimeBonus = 0;
    if (ticket.updated_at && ce.occurred_at) {
      const diffDays = Math.abs(Date.parse(ce.occurred_at) - Date.parse(ticket.updated_at)) / 86_400_000;
      if (diffDays <= 7) mergeTimeBonus = 0.05;
      else if (diffDays <= 30) mergeTimeBonus = 0.02;
    }

    // Vector cosine contributes when available; capped at TEXT_FALLBACK_SCORE_CAP
    // on the text-only path so it can never reach the auto-attach gate.
    const vectorContrib = vectorAvailable ? vectorScore * 0.6 : Math.min(0.4, vectorScore * 0.6);
    const textContrib = !vectorAvailable ? Math.min(0.3, keyInTitle) : 0;
    const rawScore = vectorContrib + keyInTitle + assigneeMatch + mergeTimeBonus + textContrib;
    // On the text-fallback path, cap at TEXT_FALLBACK_SCORE_CAP.
    const score = Math.min(1, vectorAvailable ? rawScore : Math.min(rawScore, TEXT_FALLBACK_SCORE_CAP));

    const signals: Record<string, unknown> = {
      vector_score: vectorAvailable ? Number(vectorScore.toFixed(3)) : null,
      key_in_message: keyInTitle > 0,
      assignee_match: assigneeMatch > 0,
      merge_time_bonus: mergeTimeBonus,
      text_fallback: !vectorAvailable,
    };

    result.candidates.push({
      evidence_kind: 'pr',
      tier_reached: 'A',
      candidate_ref: ref,
      score: Number(score.toFixed(3)),
      signals,
    });

    if (score >= AUTO_ATTACH_THRESHOLD) {
      // Auto-attach: write code_events link columns and audit row.
      await db
        .prepare(
          `UPDATE code_events
           SET linked_item_id = ?, link_confidence = ?, link_evidence = ?,
               ticket_link_status = 'auto_linked'
           WHERE id = ?`,
        )
        .run(ticket.id, Number(score.toFixed(3)), JSON.stringify(signals), ce.id);

      await db
        .prepare(
          `INSERT OR IGNORE INTO orphan_ticket_candidates
             (issue_item_id, evidence_kind, tier_reached, candidate_ref, score, signals,
              computed_at, accepted_at)
           VALUES (?, 'pr', 'A', ?, ?, ?, datetime('now'), datetime('now'))`,
        )
        .run(ticket.id, ref, Number(score.toFixed(3)), JSON.stringify(signals));

      result.auto_attached++;
    } else {
      await db
        .prepare(
          `INSERT OR IGNORE INTO orphan_ticket_candidates
             (issue_item_id, evidence_kind, tier_reached, candidate_ref, score, signals, computed_at)
           VALUES (?, 'pr', 'A', ?, ?, ?, datetime('now'))`,
        )
        .run(ticket.id, ref, Number(score.toFixed(3)), JSON.stringify(signals));
    }
  }

  // Tier A via MCP PRs not already covered by text-match.
  for (const pr of mcpPrs) {
    const repo = (pr as any)._repo ?? repos[0];
    if (!repo) continue;
    const ref = `${repo}#${pr.number}`;
    if (seenRefs.has(ref)) continue;
    seenRefs.add(ref);

    const titleLower = (pr.title ?? '').toLowerCase();
    const keyInTitle = titleLower.includes(ticket.source_id.toLowerCase()) ? 0.3 : 0;
    const nounInTitle = nouns.some(n => titleLower.includes(n)) ? 0.1 : 0;
    const assigneeMatch = ticket.assignee && pr.user?.login
      ? (pr.user.login.toLowerCase() === ticket.assignee.toLowerCase() ? 0.1 : 0)
      : 0;

    let mergeTimeBonus = 0;
    if (ticket.updated_at && pr.merged_at) {
      const diffDays = Math.abs(Date.parse(pr.merged_at) - Date.parse(ticket.updated_at)) / 86_400_000;
      if (diffDays <= 7) mergeTimeBonus = 0.05;
      else if (diffDays <= 30) mergeTimeBonus = 0.02;
    }

    const vectorContrib = vectorAvailable ? vectorScore * 0.6 : 0;
    const rawScore = vectorContrib + keyInTitle + nounInTitle + assigneeMatch + mergeTimeBonus;
    const score = Math.min(1, vectorAvailable ? rawScore : Math.min(rawScore, TEXT_FALLBACK_SCORE_CAP));

    const signals: Record<string, unknown> = {
      source: 'github_mcp',
      vector_score: vectorAvailable ? Number(vectorScore.toFixed(3)) : null,
      key_in_title: keyInTitle > 0,
      noun_in_title: nounInTitle > 0,
      assignee_match: assigneeMatch > 0,
      merge_time_bonus: mergeTimeBonus,
    };

    result.candidates.push({
      evidence_kind: 'pr',
      tier_reached: 'A',
      candidate_ref: ref,
      score: Number(score.toFixed(3)),
      signals,
    });

    // MCP-only path: we don't have a code_events row to update, just queue.
    await db
      .prepare(
        `INSERT OR IGNORE INTO orphan_ticket_candidates
           (issue_item_id, evidence_kind, tier_reached, candidate_ref, score, signals, computed_at)
         VALUES (?, 'pr', 'A', ?, ?, ?, datetime('now'))`,
      )
      .run(ticket.id, ref, Number(score.toFixed(3)), JSON.stringify(signals));
  }

  // ── Tier B: Branch fuzzy name match ─────────────────────────────────────────

  if (mcpClient && repos.length > 0) {
    // Build expected branch slug: e.g. 'KAN-12-rewrite-cleanup'.
    const titleSlug = slugify(ticket.title).slice(0, 60);
    const expectedSlug = `${ticket.source_id.toLowerCase()}-${titleSlug}`;
    const keySlug = ticket.source_id.toLowerCase(); // bare key: 'kan-12'

    for (const repo of repos) {
      const branches = await listBranches(mcpClient, repo);
      for (const branch of branches) {
        const nameLower = branch.name.toLowerCase();
        // Quick pre-filter before computing dice — avoids scoring hundreds of
        // irrelevant branches (e.g. 'main', 'release/v1.0').
        const containsKey = nameLower.includes(keySlug);
        const dice = diceCoefficient(expectedSlug, nameLower);
        if (!containsKey && dice < BRANCH_SIM_THRESHOLD) continue;

        const nameSim = containsKey ? Math.max(dice, 0.65) : dice;
        // Tier B score formula: name-similarity × 0.6 + assignee match bonus × 0.2.
        // Capped at TIER_BC_SCORE_CAP (0.7) — never auto-attaches.
        const assigneeBonus = 0; // branch objects don't carry author info
        const rawScore = nameSim * 0.6 + assigneeBonus;
        const score = Math.min(TIER_BC_SCORE_CAP, rawScore);

        const candidateRef = `${repo}@branch:${branch.name}`;
        if (seenRefs.has(candidateRef)) continue;
        seenRefs.add(candidateRef);

        const signals: Record<string, unknown> = {
          branch_name: branch.name,
          expected_slug: expectedSlug,
          dice_coefficient: Number(dice.toFixed(3)),
          contains_key: containsKey,
        };

        result.candidates.push({
          evidence_kind: 'branch',
          tier_reached: 'B',
          candidate_ref: candidateRef,
          score: Number(score.toFixed(3)),
          signals,
        });

        await db
          .prepare(
            `INSERT OR IGNORE INTO orphan_ticket_candidates
               (issue_item_id, evidence_kind, tier_reached, candidate_ref, score, signals, computed_at)
             VALUES (?, 'branch', 'B', ?, ?, ?, datetime('now'))`,
          )
          .run(ticket.id, candidateRef, Number(score.toFixed(3)), JSON.stringify(signals));
      }
    }
  }

  // ── Tier C: Commit vector + list_commits ─────────────────────────────────────

  // Vector search direct_commit rows in code_events via text match (same DB).
  const textMatchedCommits = await db
    .prepare(
      `SELECT id, repo, sha, kind, author_login, occurred_at, message
       FROM code_events
       WHERE workspace_id = ?
         AND kind IN ('direct_commit', 'pr_merged')
         AND (message LIKE ? OR ${nouns.map(() => 'message LIKE ?').join(' OR ')})
         AND linked_item_id IS NULL
       ORDER BY occurred_at DESC
       LIMIT 5`,
    )
    .all<CodeEventRow>(workspaceId, keyPattern, ...nounPatterns);

  for (const ce of textMatchedCommits) {
    const candidateRef = `${ce.repo}@${ce.sha}`;
    if (seenRefs.has(candidateRef)) continue;
    seenRefs.add(candidateRef);

    const keyInMsg = (ce.message ?? '').includes(ticket.source_id) ? 0.3 : 0;
    const assigneeMatch = ticket.assignee && ce.author_login
      ? (ce.author_login.toLowerCase() === ticket.assignee.toLowerCase() ? 0.2 : 0)
      : 0;

    let mergeTimeBonus = 0;
    if (ticket.updated_at && ce.occurred_at) {
      const diffDays = Math.abs(Date.parse(ce.occurred_at) - Date.parse(ticket.updated_at)) / 86_400_000;
      if (diffDays <= 7) mergeTimeBonus = 0.05;
    }

    // Tier C vector contribution is secondary; capped at TIER_BC_SCORE_CAP.
    const vectorContrib = vectorAvailable ? vectorScore * 0.6 : 0;
    const rawScore = vectorContrib + keyInMsg + assigneeMatch + mergeTimeBonus;
    const score = Math.min(TIER_BC_SCORE_CAP, rawScore);

    const signals: Record<string, unknown> = {
      vector_score: vectorAvailable ? Number(vectorScore.toFixed(3)) : null,
      key_in_message: keyInMsg > 0,
      assignee_match: assigneeMatch > 0,
      merge_time_bonus: mergeTimeBonus,
    };

    result.candidates.push({
      evidence_kind: 'commit',
      tier_reached: 'C',
      candidate_ref: candidateRef,
      score: Number(score.toFixed(3)),
      signals,
    });

    await db
      .prepare(
        `INSERT OR IGNORE INTO orphan_ticket_candidates
           (issue_item_id, evidence_kind, tier_reached, candidate_ref, score, signals, computed_at)
         VALUES (?, 'commit', 'C', ?, ?, ?, datetime('now'))`,
      )
      .run(ticket.id, candidateRef, Number(score.toFixed(3)), JSON.stringify(signals));
  }

  // Augment Tier C with GitHub MCP list_commits filtered by assignee + window.
  if (mcpClient && ticket.assignee) {
    const since = ticket.created_at;
    const until = ticket.updated_at ?? new Date().toISOString();
    for (const repo of repos) {
      const commits = await listCommits(mcpClient, repo, {
        author: ticket.assignee,
        since,
        until,
      });
      for (const c of commits.slice(0, 5)) {
        const candidateRef = `${repo}@${c.sha}`;
        if (seenRefs.has(candidateRef)) continue;
        seenRefs.add(candidateRef);

        const msgLower = (c.commit?.message ?? '').toLowerCase();
        const keyInMsg = msgLower.includes(ticket.source_id.toLowerCase()) ? 0.3 : 0;
        const nounInMsg = nouns.some(n => msgLower.includes(n)) ? 0.1 : 0;
        const rawScore = keyInMsg + nounInMsg + 0.2; // assignee filter already applied
        const score = Math.min(TIER_BC_SCORE_CAP, rawScore);

        const signals: Record<string, unknown> = {
          source: 'github_mcp',
          key_in_message: keyInMsg > 0,
          noun_in_message: nounInMsg > 0,
          commit_author: c.author?.login ?? c.commit?.author?.name,
        };

        result.candidates.push({
          evidence_kind: 'commit',
          tier_reached: 'C',
          candidate_ref: candidateRef,
          score: Number(score.toFixed(3)),
          signals,
        });

        await db
          .prepare(
            `INSERT OR IGNORE INTO orphan_ticket_candidates
               (issue_item_id, evidence_kind, tier_reached, candidate_ref, score, signals, computed_at)
             VALUES (?, 'commit', 'C', ?, ?, ?, datetime('now'))`,
          )
          .run(ticket.id, candidateRef, Number(score.toFixed(3)), JSON.stringify(signals));
      }
    }
  }

  return result;
}
