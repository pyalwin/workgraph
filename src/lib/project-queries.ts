import { ensureSchemaAsync } from './db/init-schema-async';
import { getLibsqlDb } from './db/libsql';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

// --- Types ---

export interface ProjectSignals {
  completion_pct: number;
  completion_done: number;
  completion_total: number;
  velocity: number;
  velocity_prior: number;
  velocity_delta_pct: number;
  cycle_time_days: number;
  cycle_time_prior_days: number;
  cycle_time_delta_pct: number;
  pr_cadence_per_week: number;
  stale_count: number;
  stale_pct: number;
}

export interface ProjectHealth {
  status: 'healthy' | 'needs_attention' | 'at_risk';
  summary: string | null;
  summary_generated_at: string | null;
  signals: ProjectSignals;
}

export interface LinkedPR {
  source_id: string;
  title: string;
  status: string;
  updated_at: string | null;
  repo: string;
  url: string | null;
}

export interface ProjectTicket {
  id: string;
  source_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string | null;
  url: string | null;
  linked_prs: LinkedPR[];
  /** From work_items.gap_analysis.status — 'unknown' is normalized to null. */
  gap_status: 'complete' | 'partial' | 'gap' | null;
}

export interface VelocityWeek {
  week: string;
  closed: number;
}

export interface CodeActivity {
  total_prs: number;
  merged_prs: number;
  open_prs: number;
  contributors: string[];
  contributor_count: number;
  merge_cadence_per_week: number;
  repos: string[];
  repo_count: number;
}

export interface AnomalyEvidence {
  id: string;
  source_id: string;
  title: string;
  url: string | null;
}

export interface ProjectAnomaly {
  id: string;
  scope: string;
  kind: string;
  severity: number;
  explanation: string | null;
  evidence_item_ids: string[];
  evidence: AnomalyEvidence[];
  detected_at: string;
  // Set when the user has acted on the anomaly. action_item_id and
  // jira_issue_key are mutually optional — a user can both create an action
  // item AND a Jira ticket from the same anomaly, but typically picks one.
  action_item_id?: string | null;
  jira_issue_key?: string | null;
  handled_at?: string | null;
  dismissed_by_user?: number;
}

export interface ProjectActionItem {
  id: string;
  source_item_id: string;
  source_id: string;
  source_title: string;
  text: string;
  assignee: string | null;
  ai_priority: string | null;
  user_priority: string | null;
  due_at: string | null;
}

export interface ProjectKeyResult {
  id: string;
  text: string;
  why: string | null;
  target_metric: string | null;
  target_value: number | null;
  target_at: string | null;
  ai_confidence: number | null;
  derived_from: string;
}

export interface ProjectObjective {
  id: string;
  title: string;
  why: string | null;
  ai_confidence: number | null;
  derived_from: string;
  key_results: ProjectKeyResult[];
}

export interface ProjectDetail {
  project: { key: string; name: string; total_tickets: number; total_prs: number };
  health: ProjectHealth;
  velocity_weekly: VelocityWeek[];
  code_activity: CodeActivity;
  tickets: ProjectTicket[];
  anomalies?: ProjectAnomaly[];
  actionItems?: ProjectActionItem[];
  readme?: { content: string | null; generatedAt: string | null };
  okrs?: ProjectObjective[];
}

export interface ProjectSummaryCard {
  key: string;
  name: string;
  health_status: 'healthy' | 'needs_attention' | 'at_risk';
  summary_snippet: string | null;
  completion_pct: number;
  completion_done: number;
  completion_total: number;
  velocity: number;
  velocity_delta_pct: number;
  open_count: number;
  stale_count: number;
  pr_count: number;
}

// --- Config ---

const PROJECT_NAMES: Record<string, string> = {
  ALPHA: 'Alpha Initiative',
  BETA: 'Beta Platform',
  GAMMA: 'Gamma Workflow',
};

// --- Helpers ---

function periodToDays(period: string): number | null {
  switch (period) {
    case '30d': return 30;
    case '90d': return 90;
    default: return null;
  }
}

async function periodRange(period: string): Promise<{ start: string; end: string; priorStart: string }> {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const days = periodToDays(period);

  if (!days) {
    const db = getLibsqlDb();
    const row = await db
      .prepare("SELECT MIN(created_at) as m FROM work_items WHERE source = 'jira'")
      .get<{ m: string }>();
    const minDate = row?.m?.slice(0, 10) || end;
    return { start: minDate, end, priorStart: minDate };
  }

  const start = new Date(now);
  start.setDate(start.getDate() - days);
  const priorStart = new Date(start);
  priorStart.setDate(priorStart.getDate() - days);

  return { start: start.toISOString().slice(0, 10), end, priorStart: priorStart.toISOString().slice(0, 10) };
}

function computeHealthStatus(signals: ProjectSignals): 'healthy' | 'needs_attention' | 'at_risk' {
  const velocityDeclining = signals.velocity_delta_pct < -20;
  const staleHigh = signals.stale_pct > 20;
  const noPRs = signals.pr_cadence_per_week === 0;

  if (velocityDeclining || staleHigh || noPRs) return 'at_risk';

  const velocityFlat = Math.abs(signals.velocity_delta_pct) <= 5 && signals.velocity_prior > 0;
  const staleMed = signals.stale_pct >= 10 && signals.stale_pct <= 20;
  const cycleTimeUp = signals.cycle_time_delta_pct > 20;

  if (velocityFlat || staleMed || cycleTimeUp) return 'needs_attention';

  return 'healthy';
}

// --- Main Queries ---

export async function getProjectDetail(projectKey: string, period: string): Promise<ProjectDetail> {
  await ensureInit();
  const db = getLibsqlDb();
  const { start, end, priorStart } = await periodRange(period);
  const endTs = end + 'T23:59:59';
  const startTs = start + 'T00:00:00';
  const priorStartTs = priorStart + 'T00:00:00';

  const name = PROJECT_NAMES[projectKey] || projectKey;
  const inPeriod = (ts: string | null | undefined) =>
    !!ts && ts >= startTs && ts <= endTs;

  // --- Tickets ---
  // Pull gap_analysis status alongside the ticket fields so the list view can
  // badge "Partially Shipped" / "Implementation Gap" without a follow-up call.
  // We extract just the status string via json_extract — no need to ship the
  // whole shipped/missing arrays here (the drawer fetches the full object).
  const allTicketsRows = await db.prepare(`
    SELECT id, source_id, title, status, created_at, updated_at, url,
           json_extract(gap_analysis, '$.status') AS gap_status_raw
    FROM work_items
    WHERE source = 'jira' AND json_extract(metadata, '$.project') = ?
    ORDER BY updated_at DESC, created_at DESC
  `).all<any>(projectKey);
  const allTickets = allTicketsRows.map((t: any) => ({
    id: t.id,
    source_id: t.source_id,
    title: t.title,
    status: t.status,
    created_at: t.created_at,
    updated_at: t.updated_at,
    url: t.url,
    linked_prs: [] as LinkedPR[],
    // 'unknown' isn't worth surfacing — collapse it to null so the UI only
    // renders a badge when the model actually evaluated fulfillment.
    gap_status: (t.gap_status_raw === 'complete' || t.gap_status_raw === 'partial' || t.gap_status_raw === 'gap')
      ? (t.gap_status_raw as 'complete' | 'partial' | 'gap')
      : null,
  })) as ProjectTicket[];

  // Project totals are period-independent — they describe the project as a whole.
  // Period-scoped views below filter to tickets that were created or updated
  // within the window.
  const projectTotalTickets = allTickets.length;
  const ticketsInPeriod = allTickets.filter(
    (t) => inPeriod(t.updated_at) || inPeriod(t.created_at),
  );
  const doneTickets = allTickets.filter(t => ['done', 'closed', 'resolved'].includes(t.status));
  const openTickets = allTickets.filter(t => !['done', 'closed', 'resolved'].includes(t.status));
  const doneInPeriodTickets = ticketsInPeriod.filter((t) =>
    ['done', 'closed', 'resolved'].includes(t.status),
  );

  // --- Link PRs to tickets via issue_trails ---
  // PRs aren't work_items anymore; they're trail rows anchored to Jira
  // tickets. Aggregate per pr_ref so the project KPI strip + tickets list
  // see one entry per PR with derived status, latest activity, contributors.
  const trailRows = await db
    .prepare(
      `SELECT t.pr_ref, t.repo, t.kind, t.actor, t.title, t.pr_url, t.occurred_at,
              t.state, t.match_status, w.source_id AS ticket_source_id
       FROM issue_trails t
       JOIN work_items w ON w.id = t.issue_item_id
       WHERE w.source = 'jira'
         AND json_extract(w.metadata, '$.project') = ?
         AND t.match_status IN ('matched', 'ai_matched')
       ORDER BY t.occurred_at ASC`,
    )
    .all<{
      pr_ref: string;
      repo: string | null;
      kind: 'pr_opened' | 'pr_review' | 'pr_merged' | 'pr_closed';
      actor: string | null;
      title: string | null;
      pr_url: string | null;
      occurred_at: string;
      state: string | null;
      ticket_source_id: string;
    }>(projectKey);

  type PrAgg = {
    pr_ref: string;
    repo: string | null;
    url: string | null;
    title: string | null;
    status: 'open' | 'merged' | 'closed';
    latest_at: string;
    earliest_at: string;
    authors: Set<string>;
  };
  const prMap = new Map<string, PrAgg>();
  for (const r of trailRows) {
    let agg = prMap.get(r.pr_ref);
    if (!agg) {
      agg = {
        pr_ref: r.pr_ref,
        repo: r.repo,
        url: r.pr_url,
        title: r.title,
        status: 'open',
        latest_at: r.occurred_at,
        earliest_at: r.occurred_at,
        authors: new Set(),
      };
      prMap.set(r.pr_ref, agg);
    }
    if (r.kind === 'pr_merged') agg.status = 'merged';
    else if (r.kind === 'pr_closed' && agg.status !== 'merged') agg.status = 'closed';
    if (r.actor) agg.authors.add(r.actor);
    if (r.occurred_at > agg.latest_at) agg.latest_at = r.occurred_at;
    if (r.occurred_at < agg.earliest_at) agg.earliest_at = r.occurred_at;
    if (!agg.title && r.title) agg.title = r.title;
    if (!agg.url && r.pr_url) agg.url = r.pr_url;
    if (!agg.repo && r.repo) agg.repo = r.repo;
  }

  // Build per-ticket linked_prs map. Dedup by pr_ref since the same trail
  // row repeats per kind (opened / review / merged) but tickets only need
  // one entry per PR.
  const ticketPRMap = new Map<string, LinkedPR[]>();
  const ticketSeen = new Map<string, Set<string>>();
  for (const r of trailRows) {
    const agg = prMap.get(r.pr_ref);
    if (!agg) continue;
    if (!ticketPRMap.has(r.ticket_source_id)) {
      ticketPRMap.set(r.ticket_source_id, []);
      ticketSeen.set(r.ticket_source_id, new Set());
    }
    const seen = ticketSeen.get(r.ticket_source_id)!;
    if (seen.has(agg.pr_ref)) continue;
    seen.add(agg.pr_ref);
    ticketPRMap.get(r.ticket_source_id)!.push({
      source_id: agg.pr_ref,
      title: agg.title || agg.pr_ref,
      status: agg.status,
      updated_at: agg.latest_at,
      repo: agg.repo ?? '',
      url: agg.url,
    });
  }

  // Attach PRs to tickets — list view shows only tickets active in the period.
  const ticketsWithPRs: ProjectTicket[] = ticketsInPeriod.map((t) => ({
    ...t,
    linked_prs: ticketPRMap.get(t.source_id) || [],
  }));

  const allProjectPrs = [...prMap.values()];
  const totalPRs = allProjectPrs.length;

  // --- Delivery Signals ---
  // Velocity: tickets closed in period
  const velocity = doneTickets.filter(t =>
    t.updated_at && t.updated_at >= startTs && t.updated_at <= endTs
  ).length;

  const velocityPrior = doneTickets.filter(t =>
    t.updated_at && t.updated_at >= priorStartTs && t.updated_at < startTs
  ).length;

  const velocityDeltaPct = velocityPrior > 0
    ? Math.round(((velocity - velocityPrior) / velocityPrior) * 100)
    : velocity > 0 ? 100 : 0;

  // Cycle time: avg days from created_at to updated_at for done tickets in period
  const doneInPeriod = doneTickets.filter(t =>
    t.updated_at && t.updated_at >= startTs && t.updated_at <= endTs
  );
  const cycleTimes = doneInPeriod.map(t => {
    const created = new Date(t.created_at).getTime();
    const updated = new Date(t.updated_at!).getTime();
    return (updated - created) / 86400000;
  }).filter(d => d >= 0);
  const cycleTimeDays = cycleTimes.length > 0
    ? Math.round(cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length * 10) / 10
    : 0;

  const doneInPrior = doneTickets.filter(t =>
    t.updated_at && t.updated_at >= priorStartTs && t.updated_at < startTs
  );
  const priorCycleTimes = doneInPrior.map(t => {
    const created = new Date(t.created_at).getTime();
    const updated = new Date(t.updated_at!).getTime();
    return (updated - created) / 86400000;
  }).filter(d => d >= 0);
  const cycleTimePriorDays = priorCycleTimes.length > 0
    ? Math.round(priorCycleTimes.reduce((a, b) => a + b, 0) / priorCycleTimes.length * 10) / 10
    : 0;

  const cycleTimeDeltaPct = cycleTimePriorDays > 0
    ? Math.round(((cycleTimeDays - cycleTimePriorDays) / cycleTimePriorDays) * 100)
    : 0;

  // Stale: open tickets with no update in 14+ days
  const now = new Date();
  const staleTickets = openTickets.filter(t => {
    const lastUpdate = new Date(t.updated_at || t.created_at);
    return (now.getTime() - lastUpdate.getTime()) / 86400000 >= 14;
  });
  const staleCount = staleTickets.length;
  const stalePct = openTickets.length > 0
    ? Math.round(staleCount / openTickets.length * 1000) / 10
    : 0;

  // Completion is scoped to the period: of tickets active in the window, what
  // share is done. For "all" this naturally collapses to overall completion.
  const completionTotal = ticketsInPeriod.length;
  const completionDone = doneInPeriodTickets.length;
  const completionPct = completionTotal > 0
    ? Math.round(completionDone / completionTotal * 100)
    : 0;

  // --- Code Activity (sourced from issue_trails) ---
  const projectPRsInPeriod = allProjectPrs.filter((pr) => inPeriod(pr.latest_at));
  const mergedPRs = projectPRsInPeriod.filter((pr) => pr.status === 'merged');
  const openPRs = projectPRsInPeriod.filter((pr) => pr.status === 'open');

  const contributorNames = [
    ...new Set(allProjectPrs.flatMap((pr) => [...pr.authors])),
  ];

  // For 30d/90d use the explicit window; for "all" estimate from earliest
  // PR in scope so the cadence stays meaningful instead of dividing by ~60d.
  const explicitDays = periodToDays(period);
  let cadenceWeeks = explicitDays ? explicitDays / 7 : 1;
  if (!explicitDays && allProjectPrs.length > 0) {
    const earliest = allProjectPrs.reduce<string | null>(
      (acc, pr) => (acc && acc < pr.earliest_at ? acc : pr.earliest_at),
      null,
    );
    if (earliest) {
      const span = (Date.now() - new Date(earliest).getTime()) / 86400000;
      cadenceWeeks = Math.max(span / 7, 1);
    }
  }
  const mergeCadence = Math.round(mergedPRs.length / Math.max(cadenceWeeks, 1) * 10) / 10;

  const repos = [
    ...new Set(allProjectPrs.map((pr) => pr.repo).filter((r): r is string => !!r)),
  ];

  // --- Velocity Weekly ---
  const weeklyRows = await db.prepare(`
    SELECT strftime('%Y-%W', updated_at) as week, COUNT(*) as closed
    FROM work_items
    WHERE source = 'jira'
      AND json_extract(metadata, '$.project') = ?
      AND status IN ('done', 'closed', 'resolved')
      AND updated_at >= ? AND updated_at <= ?
    GROUP BY week ORDER BY week ASC
  `).all<{ week: string; closed: number }>(projectKey, startTs, endTs);

  const velocityWeekly: VelocityWeek[] = weeklyRows
    .filter(r => r.week != null)
    .map(r => ({
      week: 'W' + r.week.slice(5),
      closed: r.closed,
    }));

  // --- Summary ---
  const summaryRow = await db
    .prepare('SELECT recap, summary_generated_at FROM project_summaries WHERE project_key = ?')
    .get<{ recap: string | null; summary_generated_at: string | null }>(projectKey);

  const signals: ProjectSignals = {
    completion_pct: completionPct,
    completion_done: completionDone,
    completion_total: completionTotal,
    velocity,
    velocity_prior: velocityPrior,
    velocity_delta_pct: velocityDeltaPct,
    cycle_time_days: cycleTimeDays,
    cycle_time_prior_days: cycleTimePriorDays,
    cycle_time_delta_pct: cycleTimeDeltaPct,
    pr_cadence_per_week: mergeCadence,
    stale_count: staleCount,
    stale_pct: stalePct,
  };

  return {
    project: { key: projectKey, name, total_tickets: projectTotalTickets, total_prs: totalPRs },
    health: {
      status: computeHealthStatus(signals),
      summary: summaryRow?.recap || null,
      summary_generated_at: summaryRow?.summary_generated_at || null,
      signals,
    },
    velocity_weekly: velocityWeekly,
    code_activity: {
      total_prs: projectPRsInPeriod.length,
      merged_prs: mergedPRs.length,
      open_prs: openPRs.length,
      contributors: contributorNames,
      contributor_count: contributorNames.length,
      merge_cadence_per_week: mergeCadence,
      repos,
      repo_count: repos.length,
    },
    tickets: ticketsWithPRs,
  };
}

export async function getProjectSummaryCards(period: string): Promise<ProjectSummaryCard[]> {
  await ensureInit();
  const db = getLibsqlDb();
  const { start, end, priorStart } = await periodRange(period);
  const startTs = start + 'T00:00:00';
  const endTs = end + 'T23:59:59';
  const priorStartTs = priorStart + 'T00:00:00';

  // Get all JIRA project keys
  const projectKeys = await db.prepare(`
    SELECT DISTINCT json_extract(metadata, '$.project') as key
    FROM work_items WHERE source = 'jira'
  `).all<{ key: string }>();

  // PR counts per project, sourced from issue_trails. PRs aren't work_items
  // anymore — they're trail rows anchored to Jira tickets. One DISTINCT
  // pr_ref per project gives us the per-card pr_count below.
  const prCountsRows = await db
    .prepare(
      `SELECT json_extract(w.metadata, '$.project') AS project,
              COUNT(DISTINCT t.pr_ref) AS n
       FROM issue_trails t
       JOIN work_items w ON w.id = t.issue_item_id
       WHERE w.source = 'jira'
         AND t.match_status IN ('matched', 'ai_matched')
       GROUP BY project`,
    )
    .all<{ project: string | null; n: number }>();
  const prCountsByProject = new Map<string, number>();
  for (const r of prCountsRows) if (r.project) prCountsByProject.set(r.project, r.n);

  const cards: ProjectSummaryCard[] = [];

  for (const { key } of projectKeys) {
    if (!key) continue;
    const name = PROJECT_NAMES[key] || key;

    const allTickets = await db.prepare(`
      SELECT status, updated_at, created_at FROM work_items
      WHERE source = 'jira' AND json_extract(metadata, '$.project') = ?
    `).all<{ status: string; updated_at: string | null; created_at: string }>(key);

    const total = allTickets.length;
    const done = allTickets.filter(t => ['done', 'closed', 'resolved'].includes(t.status)).length;
    const open = allTickets.filter(t => !['done', 'closed', 'resolved'].includes(t.status));
    const completionPct = total > 0 ? Math.round(done / total * 100) : 0;

    const velocity = allTickets.filter(t =>
      ['done', 'closed', 'resolved'].includes(t.status) &&
      t.updated_at && t.updated_at >= startTs && t.updated_at <= endTs
    ).length;

    const velocityPrior = allTickets.filter(t =>
      ['done', 'closed', 'resolved'].includes(t.status) &&
      t.updated_at && t.updated_at >= priorStartTs && t.updated_at < startTs
    ).length;

    const velocityDeltaPct = velocityPrior > 0
      ? Math.round(((velocity - velocityPrior) / velocityPrior) * 100)
      : velocity > 0 ? 100 : 0;

    const now = new Date();
    const stale = open.filter(t => {
      const lastUpdate = new Date(t.updated_at || t.created_at);
      return (now.getTime() - lastUpdate.getTime()) / 86400000 >= 14;
    }).length;

    const stalePct = open.length > 0 ? stale / open.length * 100 : 0;

    const prCount = prCountsByProject.get(key) ?? 0;

    // Summary
    const summaryRow = await db
      .prepare('SELECT recap FROM project_summaries WHERE project_key = ?')
      .get<{ recap: string | null }>(key);
    const snippet = summaryRow?.recap?.split(/[.!]\s/)[0] || null;

    // Health
    const signals: ProjectSignals = {
      completion_pct: completionPct, completion_done: done, completion_total: total,
      velocity, velocity_prior: velocityPrior, velocity_delta_pct: velocityDeltaPct,
      cycle_time_days: 0, cycle_time_prior_days: 0, cycle_time_delta_pct: 0,
      pr_cadence_per_week: 0, stale_count: stale, stale_pct: stalePct,
    };

    cards.push({
      key,
      name,
      health_status: computeHealthStatus(signals),
      summary_snippet: snippet ? snippet + '.' : null,
      completion_pct: completionPct,
      completion_done: done,
      completion_total: total,
      velocity,
      velocity_delta_pct: velocityDeltaPct,
      open_count: open.length,
      stale_count: stale,
      pr_count: prCount,
    });
  }

  // Sort: configured projects first, then by total tickets
  const configuredKeys = Object.keys(PROJECT_NAMES);
  cards.sort((a, b) => {
    const aIdx = configuredKeys.indexOf(a.key);
    const bIdx = configuredKeys.indexOf(b.key);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return b.completion_total - a.completion_total;
  });

  return cards;
}
