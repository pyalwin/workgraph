/**
 * GitHub trails sync — pulls PRs from configured repos and writes them as
 * `issue_trails` rows anchored to the Jira tickets they address.
 *
 * Distinct from the connector-runner pipeline because the output is NOT
 * work_items. PRs and review events become append-only trail entries on
 * the existing Jira ticket node. Releases continue to flow through the
 * regular GitHub connector adapter.
 *
 * Pipeline (see plan: lucky-singing-shell.md):
 *   1. Connect MCP via the workspace's github connector config
 *   2. list_pull_requests per configured repo (parallel, since-filtered)
 *   3. Extract Jira key from title / branch / body via the Jira adapter regex
 *   4. Resolve key → work_items.id (matched), else mark unmatched
 *   5. Per matched PR, fetch reviews + review_comments (parallel)
 *   6. Upsert one row per (PR-event, occurred_at) — pr_opened, pr_review,
 *      pr_merged, pr_closed
 *   7. Reconcile any prior unmatched rows whose key now exists
 *
 * Idempotent — UNIQUE(pr_ref, kind, occurred_at) makes re-ingest a no-op.
 */
import { v4 as uuid } from 'uuid';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { getConnector } from '../connectors/registry';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}
import { connectMCP, resolveServerConfig } from '../connectors/mcp-client';
import { getConnectorConfigBySource, markSyncStarted, markSyncFinished } from '../connectors/config-store';
import { atlassianConnector } from '../connectors/adapters/atlassian';

// One week default — overridable via options.since
const DEFAULT_WINDOW_DAYS = 7;

// Max PRs to process per repo per run (safety cap)
const PR_LIMIT_PER_REPO = 200;

const REPO_CONCURRENCY = 4;
const PR_DETAIL_CONCURRENCY = 8;

const BODY_CAP_BYTES = 4096;

// --- Smart diff ingestion (Phase 1) ---
// PR descriptions are often empty or one-liners. When that's the case, the
// downstream LLM has nothing to translate intent from, and the per-ticket
// gap analysis devolves to "we shipped some PRs". We pull a *truncated*
// patch for sparse PRs only — full diffs explode the prompt and SQLite size
// without proportionally helping the model.
const SPARSE_BODY_CHAR_LIMIT = 200;
const SPARSE_STRUCTURAL_MARKERS = /(^|\n)\s*(##|\*\*|- |1\.|what|why|how|test plan)/i;
const DIFF_PER_FILE_LINE_CAP = 200;
const DIFF_TOTAL_LINE_CAP = 3000;
const DIFF_FILE_CAP = 30;

// Filename patterns we never include in fetched diff context — they're
// either generated, binary, or noise that crowds out signal.
const DIFF_SKIP_PATTERNS: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)bun\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.sum$/,
  /\.svg$/i,
  /\.png$/i,
  /\.jpg$/i,
  /\.jpeg$/i,
  /\.gif$/i,
  /\.ico$/i,
  /\.pdf$/i,
  /\.min\.(js|css)$/i,
  /\.snap$/i,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)node_modules\//,
  /\.generated\.(ts|js|tsx|jsx|py|go)$/i,
];

function needsDiffContext(body: string | null | undefined): boolean {
  if (!body) return true;
  const trimmed = body.trim();
  if (trimmed.length < SPARSE_BODY_CHAR_LIMIT) return true;
  // Has prose but no structural markers — likely an unstructured wall of
  // text, still worth fetching diff to ground intent.
  if (!SPARSE_STRUCTURAL_MARKERS.test(trimmed)) return true;
  return false;
}

function shouldSkipFile(path: string): boolean {
  for (const re of DIFF_SKIP_PATTERNS) if (re.test(path)) return true;
  return false;
}

interface PrFileEntry {
  filename?: string;
  path?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

/**
 * Build a compact patch string from `get_pull_request_files` output. The
 * shape mirrors what Sonnet sees in a code review thread: file header,
 * status, +/- counts, then truncated hunk body.
 */
function buildDiffText(files: PrFileEntry[]): string {
  const kept: string[] = [];
  let totalLines = 0;
  let droppedFiles = 0;
  let filesIncluded = 0;
  for (const f of files) {
    if (filesIncluded >= DIFF_FILE_CAP) {
      droppedFiles += files.length - filesIncluded;
      break;
    }
    const path = f.filename ?? f.path ?? '';
    if (!path) continue;
    if (shouldSkipFile(path)) {
      droppedFiles++;
      continue;
    }
    const header = `### ${path}  (${f.status ?? 'modified'} +${f.additions ?? '?'}/-${f.deletions ?? '?'})`;
    const patch = (f.patch ?? '').split('\n');
    const truncatedPatch = patch.length > DIFF_PER_FILE_LINE_CAP
      ? [...patch.slice(0, DIFF_PER_FILE_LINE_CAP), `… (${patch.length - DIFF_PER_FILE_LINE_CAP} more lines truncated)`]
      : patch;
    const block = [header, ...truncatedPatch].join('\n');
    const blockLines = truncatedPatch.length + 1;
    if (totalLines + blockLines > DIFF_TOTAL_LINE_CAP) {
      droppedFiles += files.length - filesIncluded;
      break;
    }
    kept.push(block);
    totalLines += blockLines;
    filesIncluded++;
  }
  if (droppedFiles > 0) kept.push(`… (${droppedFiles} more file(s) skipped or truncated)`);
  return kept.join('\n\n');
}

async function fetchPrFiles(
  client: any,
  repo: string,
  prNumber: number,
): Promise<PrFileEntry[]> {
  const [owner, repoName] = repo.split('/');
  try {
    const resp: any = await client.callTool('get_pull_request_files', {
      owner,
      repo: repoName,
      pull_number: prNumber,
    });
    if (Array.isArray(resp)) return resp;
    if (Array.isArray(resp?.files)) return resp.files;
    if (Array.isArray(resp?.items)) return resp.items;
    return [];
  } catch {
    return [];
  }
}

export interface RunGithubTrailsOptions {
  /** ISO date or sentinel ('all' | '7d' | '30d'). Default: 7 days ago. */
  since?: string | null;
}

export interface GithubTrailsResult {
  ok: boolean;
  reposProcessed: number;
  prsSeen: number;
  matched: number;
  unmatched: number;
  trailRowsWritten: number;
  reconciled: number;
  errors: string[];
  /** Jira issue UUIDs whose trail moved this run — used to fan out summary refresh. */
  movedIssueIds: string[];
}

interface PrTrailWriteRow {
  pr_ref: string;
  pr_url: string | null;
  repo: string;
  issue_item_id: string | null;
  match_status: 'matched' | 'unmatched';
  match_evidence: string | null;
  raw: any;
}

function resolveSinceWindow(since: string | null | undefined): string {
  if (!since || since === '' || since === '7d') {
    const d = new Date();
    d.setDate(d.getDate() - DEFAULT_WINDOW_DAYS);
    return d.toISOString();
  }
  if (since === '30d') {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString();
  }
  if (since === 'all' || since === 'full') return '';
  // Already an ISO date
  return since;
}

function capBody(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.length > BODY_CAP_BYTES ? s.slice(0, BODY_CAP_BYTES) : s;
}

function findJiraKey(...candidates: (string | null | undefined)[]): { key: string; from: string } | null {
  // Walk candidates in priority order (caller passes branch first, then title, then body).
  const sources = ['branch', 'title', 'body'];
  for (let i = 0; i < candidates.length; i++) {
    const text = candidates[i];
    if (!text) continue;
    const refs = atlassianConnector.idDetection!.findReferences(text);
    if (refs.length > 0) return { key: refs[0], from: sources[i] ?? 'unknown' };
  }
  return null;
}

async function resolveJiraItemIds(jiraKeys: string[]): Promise<Map<string, string>> {
  if (jiraKeys.length === 0) return new Map();
  const db = getLibsqlDb();
  const placeholders = jiraKeys.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT source_id, id FROM work_items
       WHERE source = 'jira' AND source_id IN (${placeholders})`,
    )
    .all<{ source_id: string; id: string }>(...jiraKeys);
  return new Map(rows.map((r) => [r.source_id, r.id]));
}

async function upsertTrail(row: {
  issue_item_id: string | null;
  pr_ref: string;
  pr_url: string | null;
  repo: string;
  kind: 'pr_opened' | 'pr_review' | 'pr_merged' | 'pr_closed';
  actor: string | null;
  title: string | null;
  body: string | null;
  state: string | null;
  diff_summary: any;
  occurred_at: string;
  match_status: 'matched' | 'unmatched' | 'ai_matched';
  match_evidence: string | null;
  raw_metadata: any;
  /** Truncated patch text — only set on pr_opened rows. */
  diff_text?: string | null;
}): Promise<boolean> {
  const db = getLibsqlDb();
  // SQLite ON CONFLICT requires the conflict target columns. Our UNIQUE is
  // (pr_ref, kind, occurred_at) — match-state changes don't change those.
  // We DO want to update the issue_item_id on a row that flips from
  // unmatched → matched (the reconciler relies on this), so use UPSERT.
  const result = await db
    .prepare(
      `INSERT INTO issue_trails
        (id, issue_item_id, pr_ref, pr_url, repo, kind, actor, title, body,
         state, diff_summary, occurred_at, match_status, match_evidence, raw_metadata,
         diff_text, diff_text_fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)
      ON CONFLICT(pr_ref, kind, occurred_at) DO UPDATE SET
        issue_item_id = COALESCE(excluded.issue_item_id, issue_item_id),
        match_status = CASE
          WHEN issue_trails.match_status = 'unmatched' AND excluded.match_status IN ('matched', 'ai_matched')
            THEN excluded.match_status
          ELSE issue_trails.match_status
        END,
        match_evidence = COALESCE(excluded.match_evidence, match_evidence),
        pr_url = COALESCE(excluded.pr_url, pr_url),
        title = COALESCE(excluded.title, title),
        body = COALESCE(excluded.body, body),
        state = COALESCE(excluded.state, state),
        diff_summary = COALESCE(excluded.diff_summary, diff_summary),
        actor = COALESCE(excluded.actor, actor),
        diff_text = COALESCE(excluded.diff_text, diff_text),
        diff_text_fetched_at = CASE
          WHEN excluded.diff_text IS NOT NULL THEN datetime('now')
          ELSE diff_text_fetched_at
        END`,
    )
    .run(
      uuid(),
      row.issue_item_id,
      row.pr_ref,
      row.pr_url,
      row.repo,
      row.kind,
      row.actor,
      row.title,
      row.body,
      row.state,
      row.diff_summary ? JSON.stringify(row.diff_summary) : null,
      row.occurred_at,
      row.match_status,
      row.match_evidence,
      row.raw_metadata ? JSON.stringify(row.raw_metadata) : null,
      row.diff_text ?? null,
      row.diff_text ?? null,
    );
  return result.changes > 0;
}

async function reconcileUnmatched(): Promise<{ reconciled: number; movedIssueIds: string[] }> {
  const db = getLibsqlDb();
  // Two paths: rows whose first extraction already found a Jira key but
  // couldn't resolve it (regex_unresolved — the most common reconcile case),
  // and rows that were previously skipped entirely. For the first path we
  // read the stored key from match_evidence rather than re-running the regex
  // — saves work and uses the original branch hit (which we no longer have
  // access to from the row alone).
  const rows = await db
    .prepare(
      `SELECT id, pr_ref, title, body, diff_summary, match_evidence
       FROM issue_trails
       WHERE match_status = 'unmatched'`,
    )
    .all<{
      id: string;
      pr_ref: string;
      title: string | null;
      body: string | null;
      diff_summary: string | null;
      match_evidence: string | null;
    }>();
  if (rows.length === 0) return { reconciled: 0, movedIssueIds: [] };

  const candidates: { rowId: string; pr_ref: string; key: string }[] = [];
  const allKeys = new Set<string>();
  for (const r of rows) {
    let key: string | null = null;
    // Path A: stored evidence has the key already.
    if (r.match_evidence) {
      try {
        const ev = JSON.parse(r.match_evidence);
        if (typeof ev.key === 'string') key = ev.key;
      } catch {
        // ignore — fall through to re-extraction
      }
    }
    // Path B: no stored key — re-extract, this time including the branch
    // pulled from diff_summary so we don't miss branch-name references.
    if (!key) {
      let branch: string | null = null;
      if (r.diff_summary) {
        try {
          const d = JSON.parse(r.diff_summary);
          if (typeof d.branch === 'string') branch = d.branch;
        } catch {
          // ignore
        }
      }
      const found = findJiraKey(branch, r.title, r.body);
      if (found) key = found.key;
    }
    if (!key) continue;
    candidates.push({ rowId: r.id, pr_ref: r.pr_ref, key });
    allKeys.add(key);
  }
  if (candidates.length === 0) return { reconciled: 0, movedIssueIds: [] };

  const map = await resolveJiraItemIds([...allKeys]);
  const updateSql = `UPDATE issue_trails
     SET issue_item_id = ?, match_status = 'matched', match_evidence = ?
     WHERE pr_ref = ? AND match_status = 'unmatched'`;
  const moved = new Set<string>();
  for (const c of candidates) {
    const itemId = map.get(c.key);
    if (!itemId) continue;
    const evidence = JSON.stringify({ source: 'reconciler', key: c.key, at: new Date().toISOString() });
    const res = await db.prepare(updateSql).run(itemId, evidence, c.pr_ref);
    if (res.changes > 0) moved.add(itemId);
  }
  return { reconciled: moved.size, movedIssueIds: [...moved] };
}

function explainGithubError(repo: string, raw: string): string {
  // GitHub returns 401 "Bad credentials" for two distinct cases that look
  // identical on the wire:
  //   1. The PAT is invalid or expired.
  //   2. The PAT is valid but the org enforces SSO and the user hasn't
  //      authorized this token for the org. Same response, different fix.
  // The MCP server bubbles up the raw GitHub error string; we rewrite it
  // here so the user knows what to do.
  if (/bad credentials|authentication failed|401/i.test(raw)) {
    const owner = repo.split('/')[0];
    return `${repo}: GitHub rejected the PAT. If "${owner}" enforces SSO, authorize this token for the org at https://github.com/settings/tokens (find the token → "Configure SSO" → enable for ${owner}). If using a fine-grained PAT, ensure it includes "${repo}" with "Pull requests: read" + "Contents: read".`;
  }
  if (/not found|404/i.test(raw)) {
    return `${repo}: not found or the PAT can't see it. Confirm the repo name and PAT scope.`;
  }
  if (/rate limit|secondary rate/i.test(raw)) {
    return `${repo}: GitHub rate limit hit. The next scheduled tick will retry.`;
  }
  return `${repo}: ${raw}`;
}

async function listPullRequestsForRepo(
  client: any,
  repo: string,
  sinceISO: string,
): Promise<any[]> {
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return [];

  const all: any[] = [];
  let page = 1;
  const PER_PAGE = 50;
  while (all.length < PR_LIMIT_PER_REPO) {
    let resp: any;
    try {
      resp = await client.callTool('list_pull_requests', {
        owner,
        repo: repoName,
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: PER_PAGE,
        page,
      });
    } catch (err: any) {
      throw new Error(explainGithubError(repo, err.message ?? String(err)));
    }
    const items: any[] = Array.isArray(resp) ? resp : (resp?.pull_requests ?? resp?.items ?? []);
    if (items.length === 0) break;
    let stoppedByWindow = false;
    for (const pr of items) {
      const updated = pr.updated_at || pr.created_at;
      if (sinceISO && updated && updated < sinceISO) {
        stoppedByWindow = true;
        break;
      }
      all.push(pr);
      if (all.length >= PR_LIMIT_PER_REPO) break;
    }
    if (stoppedByWindow || items.length < PER_PAGE) break;
    page++;
  }
  return all;
}

async function fetchReviewsForPr(
  client: any,
  repo: string,
  prNumber: number,
): Promise<{ reviews: any[]; reviewComments: any[] }> {
  const [owner, repoName] = repo.split('/');
  // Tool names + param casing match @modelcontextprotocol/server-github
  // schemas (snake_case, get_ prefix). Earlier camelCase / list_ names were
  // silently dropped by the server, returning empty arrays for every PR.
  const [reviews, reviewComments] = await Promise.all([
    client
      .callTool('get_pull_request_reviews', { owner, repo: repoName, pull_number: prNumber })
      .catch(() => [])
      .then((r: any) => (Array.isArray(r) ? r : (r?.reviews ?? r?.items ?? []))),
    client
      .callTool('get_pull_request_comments', { owner, repo: repoName, pull_number: prNumber })
      .catch(() => [])
      .then((r: any) => (Array.isArray(r) ? r : (r?.comments ?? r?.items ?? []))),
  ]);
  return { reviews, reviewComments };
}

/** Deduplicate by url so review-then-comment threads merge into one trail row. */
function buildReviewBody(review: any, comments: any[]): string {
  const parts: string[] = [];
  if (review.body) parts.push(String(review.body));
  for (const c of comments) {
    if (!c?.body) continue;
    const path = c.path ? `[${c.path}] ` : '';
    parts.push(`${path}${c.user?.login ?? 'unknown'}: ${c.body}`);
  }
  return parts.join('\n\n');
}

export async function runGithubTrailsSync(
  workspaceId: string,
  slot: string,
  options: RunGithubTrailsOptions = {},
): Promise<GithubTrailsResult> {
  await ensureInit();

  const cfg = await getConnectorConfigBySource(workspaceId, 'github');
  if (!cfg) {
    return {
      ok: false,
      reposProcessed: 0,
      prsSeen: 0,
      matched: 0,
      unmatched: 0,
      trailRowsWritten: 0,
      reconciled: 0,
      errors: ['No github connector configured for this workspace'],
      movedIssueIds: [],
    };
  }
  const repos = ((cfg.config?.options as any)?.repos as string[] | undefined) ?? [];
  if (repos.length === 0) {
    return {
      ok: true,
      reposProcessed: 0,
      prsSeen: 0,
      matched: 0,
      unmatched: 0,
      trailRowsWritten: 0,
      reconciled: 0,
      errors: ['No repos selected — sync skipped'],
      movedIssueIds: [],
    };
  }

  const connector = getConnector('github');
  const server = await resolveServerConfig(connector.serverId, 'github', workspaceId, process.env);
  if (!server) {
    return {
      ok: false,
      reposProcessed: 0,
      prsSeen: 0,
      matched: 0,
      unmatched: 0,
      trailRowsWritten: 0,
      reconciled: 0,
      errors: [`No MCP server config resolved for github (workspace=${workspaceId})`],
      movedIssueIds: [],
    };
  }

  await markSyncStarted(workspaceId, slot);
  const sinceISO = resolveSinceWindow(options.since ?? null);
  const errors: string[] = [];
  let trailRowsWritten = 0;
  let prsSeen = 0;
  let matched = 0;
  let unmatched = 0;
  const movedIssueIds = new Set<string>();

  let client: any = null;
  try {
    client = await connectMCP(server);

    // 1. Fetch PRs per repo in parallel.
    type RepoBatch = { repo: string; prs: any[] };
    const repoBatches: RepoBatch[] = [];
    let cursor = 0;
    const fetchWorkers: Promise<void>[] = [];
    for (let w = 0; w < REPO_CONCURRENCY; w++) {
      fetchWorkers.push((async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= repos.length) return;
          const repo = repos[idx];
          try {
            const prs = await listPullRequestsForRepo(client, repo, sinceISO);
            repoBatches.push({ repo, prs });
          } catch (err: any) {
            errors.push(err.message);
          }
        }
      })());
    }
    await Promise.all(fetchWorkers);
    prsSeen = repoBatches.reduce((sum, b) => sum + b.prs.length, 0);

    // 2. Extract Jira keys + resolve to work_items.id in one batch.
    const writes: PrTrailWriteRow[] = [];
    const allKeys = new Set<string>();
    for (const batch of repoBatches) {
      for (const pr of batch.prs) {
        const branch = pr.head?.ref ?? null;
        const found = findJiraKey(branch, pr.title, pr.body);
        if (found) allKeys.add(found.key);
      }
    }
    const keyMap = await resolveJiraItemIds([...allKeys]);

    for (const batch of repoBatches) {
      for (const pr of batch.prs) {
        const branch = pr.head?.ref ?? null;
        const found = findJiraKey(branch, pr.title, pr.body);
        const pr_ref = `${batch.repo}#${pr.number}`;
        let issueItemId: string | null = null;
        let match_status: 'matched' | 'unmatched' = 'unmatched';
        let evidence: string | null = null;
        if (found) {
          const id = keyMap.get(found.key);
          if (id) {
            issueItemId = id;
            match_status = 'matched';
            evidence = JSON.stringify({ source: 'regex', from: found.from, key: found.key });
            matched++;
          } else {
            // Key looked like Jira but not in DB yet — still unmatched, but
            // store the candidate evidence so the reconciler can pick it up.
            evidence = JSON.stringify({ source: 'regex_unresolved', from: found.from, key: found.key });
            unmatched++;
          }
        } else {
          unmatched++;
        }
        writes.push({
          pr_ref,
          pr_url: pr.html_url ?? null,
          repo: batch.repo,
          issue_item_id: issueItemId,
          match_status,
          match_evidence: evidence,
          raw: pr,
        });
      }
    }

    // 3. Fetch reviews for matched PRs only — saves API calls; unmatched
    // PRs get their reviews on the next pass after AI matcher attaches them.
    const matchedWrites = writes.filter((w) => w.match_status === 'matched');
    const reviewsByRef = new Map<string, { reviews: any[]; reviewComments: any[] }>();
    let reviewCursor = 0;
    const reviewWorkers: Promise<void>[] = [];
    for (let w = 0; w < PR_DETAIL_CONCURRENCY; w++) {
      reviewWorkers.push((async () => {
        while (true) {
          const idx = reviewCursor++;
          if (idx >= matchedWrites.length) return;
          const write = matchedWrites[idx];
          try {
            const out = await fetchReviewsForPr(client, write.repo, write.raw.number);
            reviewsByRef.set(write.pr_ref, out);
          } catch (err: any) {
            errors.push(`reviews ${write.pr_ref}: ${err.message}`);
          }
        }
      })());
    }
    await Promise.all(reviewWorkers);

    // 3b. Fetch a truncated diff for sparse-description PRs whose diff_text
    // isn't already cached. We grab unmatched PRs too so the orphan-PR
    // matcher (which runs separately) has real semantic context to work
    // with — without diff text, it only has title+body and the embedding
    // search returns noise. Cap by sparseness check + 30-day cache so cost
    // is bounded even on the first orphan-PR backfill.
    const diffTextByRef = new Map<string, string>();
    const diffTargets = writes.filter((w) => needsDiffContext(w.raw.body));
    const cachedDiffs: Set<string> = await (async () => {
      if (diffTargets.length === 0) return new Set<string>();
      const placeholders = diffTargets.map(() => '?').join(',');
      const refs = diffTargets.map((w) => w.pr_ref);
      const rows = await getLibsqlDb()
        .prepare(
          `SELECT DISTINCT pr_ref FROM issue_trails
           WHERE pr_ref IN (${placeholders})
             AND diff_text IS NOT NULL
             AND diff_text_fetched_at IS NOT NULL
             AND datetime(diff_text_fetched_at) > datetime('now', '-30 days')`,
        )
        .all<{ pr_ref: string }>(...refs);
      return new Set(rows.map((r) => r.pr_ref));
    })();
    const toFetchDiff = diffTargets.filter((w) => !cachedDiffs.has(w.pr_ref));
    let diffCursor = 0;
    const diffWorkers: Promise<void>[] = [];
    for (let w = 0; w < PR_DETAIL_CONCURRENCY; w++) {
      diffWorkers.push((async () => {
        while (true) {
          const idx = diffCursor++;
          if (idx >= toFetchDiff.length) return;
          const write = toFetchDiff[idx];
          try {
            const files = await fetchPrFiles(client, write.repo, write.raw.number);
            if (files.length === 0) continue;
            const diffText = buildDiffText(files);
            if (diffText) diffTextByRef.set(write.pr_ref, diffText);
          } catch (err: any) {
            errors.push(`diff ${write.pr_ref}: ${err.message}`);
          }
        }
      })());
    }
    await Promise.all(diffWorkers);

    // 4. Upsert trail rows.
    for (const write of writes) {
      const pr = write.raw;
      const diff = {
        additions: pr.additions ?? null,
        deletions: pr.deletions ?? null,
        changed_files: pr.changed_files ?? null,
        branch: pr.head?.ref ?? null,
        base: pr.base?.ref ?? null,
      };

      // pr_opened
      const opened = await upsertTrail({
        issue_item_id: write.issue_item_id,
        pr_ref: write.pr_ref,
        pr_url: write.pr_url,
        repo: write.repo,
        kind: 'pr_opened',
        actor: pr.user?.login ?? null,
        title: pr.title ?? null,
        body: capBody(pr.body),
        state: pr.state ?? null,
        diff_summary: diff,
        occurred_at: pr.created_at,
        match_status: write.match_status,
        match_evidence: write.match_evidence,
        raw_metadata: { number: pr.number, draft: pr.draft ?? false },
        diff_text: diffTextByRef.get(write.pr_ref) ?? null,
      });
      if (opened) trailRowsWritten++;
      if (opened && write.issue_item_id) movedIssueIds.add(write.issue_item_id);

      const reviewBundle = reviewsByRef.get(write.pr_ref);
      if (reviewBundle) {
        // Group review comments by review id; reviews without comments still emit.
        const commentsByReview = new Map<number, any[]>();
        for (const c of reviewBundle.reviewComments) {
          const rid = c?.pull_request_review_id;
          if (!rid) continue;
          if (!commentsByReview.has(rid)) commentsByReview.set(rid, []);
          commentsByReview.get(rid)!.push(c);
        }
        for (const review of reviewBundle.reviews) {
          if (!review?.submitted_at) continue;
          const comments = commentsByReview.get(review.id) ?? [];
          const wrote = await upsertTrail({
            issue_item_id: write.issue_item_id,
            pr_ref: write.pr_ref,
            pr_url: write.pr_url,
            repo: write.repo,
            kind: 'pr_review',
            actor: review.user?.login ?? null,
            title: review.state ? `${review.user?.login ?? 'reviewer'} · ${review.state}` : null,
            body: capBody(buildReviewBody(review, comments)),
            state: review.state ?? null,
            diff_summary: null,
            occurred_at: review.submitted_at,
            match_status: write.match_status,
            match_evidence: write.match_evidence,
            raw_metadata: { review_id: review.id, comment_count: comments.length },
          });
          if (wrote) trailRowsWritten++;
        }
      }

      // pr_merged / pr_closed
      if (pr.merged_at) {
        const wrote = await upsertTrail({
          issue_item_id: write.issue_item_id,
          pr_ref: write.pr_ref,
          pr_url: write.pr_url,
          repo: write.repo,
          kind: 'pr_merged',
          actor: pr.merged_by?.login ?? null,
          title: pr.title ?? null,
          body: null,
          state: 'merged',
          diff_summary: diff,
          occurred_at: pr.merged_at,
          match_status: write.match_status,
          match_evidence: write.match_evidence,
          raw_metadata: { merge_commit_sha: pr.merge_commit_sha ?? null },
        });
        if (wrote) trailRowsWritten++;
      } else if (pr.closed_at) {
        const wrote = await upsertTrail({
          issue_item_id: write.issue_item_id,
          pr_ref: write.pr_ref,
          pr_url: write.pr_url,
          repo: write.repo,
          kind: 'pr_closed',
          actor: pr.user?.login ?? null,
          title: pr.title ?? null,
          body: null,
          state: 'closed',
          diff_summary: diff,
          occurred_at: pr.closed_at,
          match_status: write.match_status,
          match_evidence: write.match_evidence,
          raw_metadata: {},
        });
        if (wrote) trailRowsWritten++;
      }
    }

    // 5. Reconcile any prior unmatched rows whose key is now in the DB.
    const recon = await reconcileUnmatched();
    for (const id of recon.movedIssueIds) movedIssueIds.add(id);

    await markSyncFinished(workspaceId, slot, {
      ok: errors.length === 0,
      itemsSynced: trailRowsWritten,
      error: errors.length > 0 ? errors.slice(0, 3).join('; ') : null,
    });

    return {
      ok: errors.length === 0,
      reposProcessed: repoBatches.length,
      prsSeen,
      matched,
      unmatched,
      trailRowsWritten,
      reconciled: recon.reconciled,
      errors,
      movedIssueIds: [...movedIssueIds],
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    await markSyncFinished(workspaceId, slot, { ok: false, error: message });
    throw err;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
  }
}

/** Standalone reconciler — exposed for the Inngest function to call after Jira sync. */
export async function reconcileGithubTrailsUnmatched(): Promise<{ reconciled: number; movedIssueIds: string[] }> {
  await ensureInit();
  return reconcileUnmatched();
}
