/**
 * Per-Jira-ticket AI generator for PR delivery context.
 *
 * Inputs: the ticket itself + every issue_trails row attached to it.
 * Outputs (single AI call):
 *   - delivery_summary  → work_items.pr_summary
 *   - decisions[]       → issue_decisions (wipe + insert, idempotent)
 *   - anomalies[]       → anomalies table (auto-resolve prior, upsert new)
 *
 * Modeled after src/lib/sync/project-actions.ts. Uses getModel('extract')
 * with generateObject + Zod for structured output.
 */
import { z } from 'zod';
import { generateObject } from 'ai';
import { v4 as uuid } from 'uuid';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';
import { getModel } from '../ai';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

// --- Inputs ---

interface TicketRow {
  id: string;
  source_id: string;
  title: string;
  body: string | null;
  status: string | null;
  priority: string | null;
  metadata: string | null;
}

interface TrailRow {
  id: string;
  pr_ref: string;
  pr_url: string | null;
  kind: 'pr_opened' | 'pr_review' | 'pr_merged' | 'pr_closed';
  actor: string | null;
  title: string | null;
  body: string | null;
  state: string | null;
  diff_summary: string | null;
  occurred_at: string;
  diff_text: string | null;
  functional_summary: string | null;
}

// --- AI schema ---

const ANOMALY_KINDS = ['impl_drift', 'incomplete_impl', 'unmerged_long'] as const;
const GAP_STATUSES = ['complete', 'partial', 'gap', 'unknown'] as const;

const TicketDeliverySchema = z.object({
  // 2-4 sentences. What shipped, what's in flight, what's blocked.
  delivery_summary: z.string()
    .describe('Plain-prose 2-4 sentence narrative of how the ticket was addressed by its PRs. Reference PRs by their #NN ref. If incomplete, say so.'),
  // Per-PR plain-English description of what the code change does. Cached on
  // issue_trails.functional_summary so the embedding index sees PR semantics.
  pr_intents: z.array(z.object({
    pr_ref: z.string().describe('owner/repo#NN as it appears in the trail.'),
    functional_summary: z.string().describe(
      'One short sentence in plain English describing what this PR functionally changes — what visual, architectural, or behavioral effect it has. Avoid file names; describe outcomes.',
    ),
  })).describe('One entry per PR seen in the trail. Skip pr_review/pr_merged/pr_closed events — only describe the PR itself once.'),
  // Explicit shipped-vs-asked breakdown. Distinct from anomalies, which are
  // qualitative warnings; this is the structured fulfillment ledger.
  gap_analysis: z.object({
    status: z.enum(GAP_STATUSES).describe(
      'complete = every requirement is implemented. ' +
      'partial = some requirements implemented, others not. ' +
      'gap = work shipped but did not address the asked requirements. ' +
      'unknown = ticket too vague to evaluate fulfillment.',
    ),
    shipped: z.array(z.string()).describe(
      'Specific requirements from the ticket that the PRs implement. Each item is one short phrase. ' +
      'When citing which PR delivered it, use the human-readable PR ref like "owner/repo#123" in parentheses. ' +
      'NEVER use the [trail:<uuid>] syntax inside this field — that syntax is reserved for the source_trail_id field on decisions only.',
    ),
    missing: z.array(z.string()).describe(
      'Specific requirements asked for in the ticket that the PRs do NOT address. Each item is one short phrase. Empty if status=complete. ' +
      'Do not cite trail UUIDs here — only ticket language and PR refs in "owner/repo#NN" form.',
    ),
    notes: z.string().describe(
      '1-2 sentences explaining the verdict. Neutral tone. Cite PR refs as "owner/repo#NN", never as [trail:<uuid>]. ' +
      'Empty string when status=unknown is self-explanatory.',
    ),
  }),
  decisions: z.array(z.object({
    text: z.string().describe('Concrete decision made during review (e.g. "use Redis instead of in-memory cache"). Avoid vague generalizations.'),
    rationale: z.string().optional().describe('Why this decision was reached.'),
    actor: z.string().optional().describe('GitHub login of the person who voiced or accepted the decision.'),
    decided_at: z.string().optional().describe('ISO timestamp from the source review/comment.'),
    confidence: z.number().min(0).max(1).describe('How explicit the decision was (1.0 = stated outright, 0.5 = implied, 0.3 = speculative).'),
    source_trail_id: z.string().optional().describe('The trail row id (UUID) this decision came from, if obvious.'),
  })).max(5).describe('Distinct technical or scope decisions extracted from the review thread. Skip routine code-style nitpicks.'),
  anomalies: z.array(z.object({
    kind: z.enum(ANOMALY_KINDS).describe(
      'impl_drift = PR scope materially differs from ticket ask. ' +
      'incomplete_impl = ticket lists multiple acceptance criteria, only some addressed. ' +
      'unmerged_long = PR linked but open for >14 days with stalled review.',
    ),
    severity: z.number().min(0).max(1),
    explanation: z.string().describe('One sentence, neutral tone, references specific PR refs.'),
    pr_refs: z.array(z.string()).describe('owner/repo#NN list — at least one.'),
  })).max(3),
});

type TicketDelivery = z.infer<typeof TicketDeliverySchema>;
export type GapAnalysisStatus = (typeof GAP_STATUSES)[number];

// --- DB readers ---

async function loadTicket(issueItemId: string): Promise<TicketRow | null> {
  const db = getLibsqlDb();
  const row = await db
    .prepare(
      `SELECT id, source_id, title, body, status, priority, metadata
       FROM work_items WHERE id = ? AND source = 'jira'`,
    )
    .get<TicketRow>(issueItemId);
  return row ?? null;
}

const TRAIL_LIMIT = 30;

async function loadTrails(issueItemId: string): Promise<TrailRow[]> {
  const db = getLibsqlDb();
  const rows = await db
    .prepare(
      `SELECT id, pr_ref, pr_url, kind, actor, title, body, state, diff_summary, occurred_at,
              diff_text, functional_summary
       FROM issue_trails
       WHERE issue_item_id = ?
       ORDER BY occurred_at DESC
       LIMIT ?`,
    )
    .all<TrailRow>(issueItemId, TRAIL_LIMIT);
  return rows.reverse();
}

// --- Prompt building ---

function summarizeMetadata(meta: string | null): string {
  if (!meta) return '';
  try {
    const parsed = JSON.parse(meta);
    const fields = ['acceptance_criteria', 'description', 'project', 'labels', 'epic_link'];
    const lines: string[] = [];
    for (const f of fields) {
      if (parsed[f]) {
        const val = typeof parsed[f] === 'string' ? parsed[f] : JSON.stringify(parsed[f]);
        lines.push(`${f}: ${val}`);
      }
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

function formatTrailLine(t: TrailRow): string {
  const diffParts: string[] = [];
  if (t.diff_summary) {
    try {
      const d = JSON.parse(t.diff_summary);
      if (d.additions != null || d.deletions != null) diffParts.push(`+${d.additions ?? '?'}/-${d.deletions ?? '?'}`);
      if (d.branch) diffParts.push(`branch:${d.branch}`);
    } catch {
      // ignore
    }
  }
  const diff = diffParts.length ? ` (${diffParts.join(' ')})` : '';
  const actor = t.actor ? `@${t.actor}` : '';
  const state = t.state ? ` [${t.state}]` : '';
  const head = `${t.occurred_at}  ${t.kind}${state}  ${t.pr_ref}  ${actor}${diff}`;
  const body = t.body ? `\n  └ ${t.body.slice(0, 800).replace(/\n/g, '\n     ')}` : '';
  // Surface a cached functional summary so the model trusts it as ground
  // truth from a prior pass — saves it from re-translating on every refresh.
  const cachedIntent = t.functional_summary
    ? `\n  ⚐ cached intent: ${t.functional_summary}`
    : '';
  return `[trail:${t.id}] ${head}${body}${cachedIntent}`;
}

// Diff context is bulky, so we only surface it for pr_opened rows where we
// fetched it. Capped per ticket to keep the prompt small even when many PRs
// have stored diffs.
const DIFF_CONTEXT_PER_PR_CAP_CHARS = 4000;
const DIFF_CONTEXT_TOTAL_CAP_CHARS = 12000;

function buildDiffContextSection(trails: TrailRow[]): string {
  const opened = trails.filter((t) => t.kind === 'pr_opened' && t.diff_text);
  if (opened.length === 0) return '';
  const blocks: string[] = [];
  let totalChars = 0;
  for (const t of opened) {
    if (totalChars >= DIFF_CONTEXT_TOTAL_CAP_CHARS) {
      blocks.push(`… (${opened.length - blocks.length} more PR(s) had diffs but the prompt budget is exhausted)`);
      break;
    }
    const remaining = DIFF_CONTEXT_TOTAL_CAP_CHARS - totalChars;
    const cap = Math.min(DIFF_CONTEXT_PER_PR_CAP_CHARS, remaining);
    const text = (t.diff_text ?? '').slice(0, cap);
    const truncMark = (t.diff_text ?? '').length > cap ? '\n… (truncated)' : '';
    const block = `### ${t.pr_ref}\n${text}${truncMark}`;
    blocks.push(block);
    totalChars += block.length;
  }
  return ['## PR diffs (truncated patches for sparse-description PRs)', ...blocks].join('\n\n');
}

function buildPrompt(ticket: TicketRow, trails: TrailRow[]): { system: string; user: string } {
  const system = [
    'You analyze how Jira tickets are addressed by their linked GitHub pull requests.',
    'You are given the ticket plus a chronological log of PR events (pr_opened, pr_review, pr_merged, pr_closed).',
    'For PRs whose description was sparse, you also see a truncated patch — read it to infer functional intent (what the change *does* in plain English), not what files moved.',
    'Each event line is tagged with [trail:<uuid>] which you may reference back as source_trail_id when reporting decisions.',
    '',
    'Produce five things:',
    '  1. delivery_summary: 2-4 plain sentences. Mention PRs by their owner/repo#NN ref.',
    '  2. pr_intents: one short plain-English sentence per PR (one entry per pr_ref) describing the functional intent of the change. If a cached intent is shown, you may reuse it verbatim when accurate.',
    '  3. gap_analysis: explicit shipped-vs-asked breakdown — read the ticket\'s acceptance criteria / description carefully and compare against what the PRs actually do. Use status="unknown" when the ticket has no concrete asks to compare against; never invent missing items just to fill the array.',
    '  4. decisions: technical or scope decisions made during reviews. Skip code-style nitpicks. Skip "approved" / "LGTM" without substance.',
    '  5. anomalies: only if the implementation visibly diverges from the ticket ask, leaves criteria unaddressed, or stalls.',
    '',
    'Be calibrated. Empty arrays are correct when nothing applies. Do not invent decisions, anomalies, or missing requirements to fill quota.',
  ].join('\n');

  const diffContext = buildDiffContextSection(trails);

  const user = [
    `# Ticket ${ticket.source_id}`,
    `Title: ${ticket.title}`,
    `Status: ${ticket.status ?? 'unknown'}`,
    `Priority: ${ticket.priority ?? 'none'}`,
    '',
    ticket.body ? `## Description\n${ticket.body}` : '',
    summarizeMetadata(ticket.metadata),
    '',
    `## PR trail (${trails.length} events, oldest first)`,
    trails.map(formatTrailLine).join('\n\n'),
    '',
    diffContext,
  ]
    .filter(Boolean)
    .join('\n');

  return { system, user };
}

// --- Persistence ---

async function persistSummary(issueItemId: string, summary: string): Promise<void> {
  const db = getLibsqlDb();
  await db
    .prepare(
      `UPDATE work_items SET pr_summary = ?, pr_summary_generated_at = datetime('now') WHERE id = ?`,
    )
    .run(summary, issueItemId);
}

async function persistGapAnalysis(
  issueItemId: string,
  gap: TicketDelivery['gap_analysis'] | null,
): Promise<void> {
  const db = getLibsqlDb();
  if (!gap) {
    await db
      .prepare(
        `UPDATE work_items SET gap_analysis = NULL, gap_analysis_generated_at = NULL WHERE id = ?`,
      )
      .run(issueItemId);
    return;
  }
  await db
    .prepare(
      `UPDATE work_items SET gap_analysis = ?, gap_analysis_generated_at = datetime('now') WHERE id = ?`,
    )
    .run(JSON.stringify(gap), issueItemId);
}

async function persistPrIntents(
  trailIds: Set<string>,
  trails: TrailRow[],
  intents: TicketDelivery['pr_intents'],
): Promise<void> {
  const db = getLibsqlDb();
  if (intents.length === 0) return;
  // Apply each intent to every trail row sharing the same pr_ref so the cache
  // works regardless of which event the model picked. trailIds bound the
  // update to this ticket's trail (defense in depth — we wouldn't want to
  // bleed intents across tickets if the model hallucinated a foreign ref).
  const trailIdsByRef = new Map<string, string[]>();
  for (const t of trails) {
    if (!trailIdsByRef.has(t.pr_ref)) trailIdsByRef.set(t.pr_ref, []);
    trailIdsByRef.get(t.pr_ref)!.push(t.id);
  }
  const updateSql = `UPDATE issue_trails SET functional_summary = ?, functional_summary_generated_at = datetime('now') WHERE id = ?`;
  for (const intent of intents) {
    if (!intent.functional_summary?.trim()) continue;
    const ids = trailIdsByRef.get(intent.pr_ref);
    if (!ids) continue;
    for (const id of ids) {
      if (!trailIds.has(id)) continue;
      await db.prepare(updateSql).run(intent.functional_summary.trim(), id);
    }
  }
}

async function persistDecisions(
  issueItemId: string,
  trailIds: Set<string>,
  decisions: TicketDelivery['decisions'],
): Promise<void> {
  const db = getLibsqlDb();
  // Wipe previous AI-generated decisions for this issue; user-entered or
  // future non-AI sources stay (derived_from!='ai_pr_review').
  await db
    .prepare(
      `DELETE FROM issue_decisions WHERE issue_item_id = ? AND derived_from = 'ai_pr_review'`,
    )
    .run(issueItemId);

  if (decisions.length === 0) return;

  const insertSql = `INSERT INTO issue_decisions
      (id, issue_item_id, trail_id, text, rationale, actor, decided_at, ai_confidence, derived_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai_pr_review')`;
  for (const d of decisions) {
    const trailId = d.source_trail_id && trailIds.has(d.source_trail_id) ? d.source_trail_id : null;
    await db.prepare(insertSql).run(
      uuid(),
      issueItemId,
      trailId,
      d.text,
      d.rationale ?? null,
      d.actor ?? null,
      d.decided_at ?? null,
      d.confidence,
    );
  }
}

const KNOWN_PR_KINDS: ReadonlySet<string> = new Set(ANOMALY_KINDS);

async function persistAnomalies(
  workspaceId: string,
  issueItemId: string,
  anomalies: TicketDelivery['anomalies'],
): Promise<void> {
  const db = getLibsqlDb();
  const scope = `item:${issueItemId}`;
  // Auto-resolve any prior PR-scoped anomalies for this ticket that the new
  // pass didn't re-flag. Identified by kind being in our PR set.
  const flagged = new Set(anomalies.map((a) => a.kind));
  const existing = await db
    .prepare(
      `SELECT kind FROM anomalies WHERE workspace_id = ? AND scope = ? AND resolved_at IS NULL`,
    )
    .all<{ kind: string }>(workspaceId, scope);
  const resolveSql = `UPDATE anomalies SET resolved_at = datetime('now')
     WHERE workspace_id = ? AND scope = ? AND kind = ? AND resolved_at IS NULL`;
  for (const e of existing) {
    if (KNOWN_PR_KINDS.has(e.kind) && !flagged.has(e.kind as TicketDelivery['anomalies'][number]['kind'])) {
      await db.prepare(resolveSql).run(workspaceId, scope, e.kind);
    }
  }

  const upsertSql = `INSERT INTO anomalies (id, workspace_id, scope, kind, severity, evidence_item_ids, explanation, detected_at, resolved_at, dismissed_by_user)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL, 0)
    ON CONFLICT(workspace_id, scope, kind) DO UPDATE SET
      severity = excluded.severity,
      explanation = excluded.explanation,
      detected_at = excluded.detected_at,
      resolved_at = NULL`;
  const evidence = JSON.stringify([issueItemId]);
  for (const a of anomalies) {
    // PR refs go into the explanation so the UI's anomaly source pills
    // surface them. evidence_item_ids stays as work_item UUIDs only.
    const refs = a.pr_refs?.length ? ` [${a.pr_refs.join(', ')}]` : '';
    await db.prepare(upsertSql).run(
      uuid(),
      workspaceId,
      scope,
      a.kind,
      a.severity,
      evidence,
      `${a.explanation}${refs}`,
    );
  }
}

// --- Public entry point ---

export interface IssuePrSummaryResult {
  ok: boolean;
  reason?: string;
  trailCount?: number;
  decisionCount?: number;
  anomalyCount?: number;
  prIntentCount?: number;
  gapStatus?: GapAnalysisStatus | null;
}

export async function generateIssuePrSummary(
  workspaceId: string,
  issueItemId: string,
): Promise<IssuePrSummaryResult> {
  await ensureInit();

  const ticket = await loadTicket(issueItemId);
  if (!ticket) return { ok: false, reason: 'ticket not found or not jira' };

  const trails = await loadTrails(issueItemId);
  if (trails.length === 0) {
    // Nothing to summarize — also clear any stale AI rows so the UI doesn't
    // show outdated info from a prior trails ingest.
    await persistSummary(issueItemId, '');
    await persistDecisions(issueItemId, new Set(), []);
    await persistAnomalies(workspaceId, issueItemId, []);
    await persistGapAnalysis(issueItemId, null);
    return { ok: true, trailCount: 0, decisionCount: 0, anomalyCount: 0, prIntentCount: 0, gapStatus: null };
  }

  const { system, user } = buildPrompt(ticket, trails);
  let result: TicketDelivery;
  try {
    const { object } = await generateObject({
      model: getModel('extract'),
      maxOutputTokens: 3000,
      system,
      schema: TicketDeliverySchema,
      prompt: user,
    });
    result = object;
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  const trailIds = new Set(trails.map((t) => t.id));
  await persistSummary(issueItemId, result.delivery_summary);
  await persistPrIntents(trailIds, trails, result.pr_intents);
  await persistGapAnalysis(issueItemId, result.gap_analysis);
  await persistDecisions(issueItemId, trailIds, result.decisions);
  await persistAnomalies(workspaceId, issueItemId, result.anomalies);

  return {
    ok: true,
    trailCount: trails.length,
    decisionCount: result.decisions.length,
    anomalyCount: result.anomalies.length,
    prIntentCount: result.pr_intents.length,
    gapStatus: result.gap_analysis.status,
  };
}
