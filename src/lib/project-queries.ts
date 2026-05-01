import { getDb } from './db';

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

export interface ProjectAnomaly {
  id: string;
  scope: string;
  kind: string;
  severity: number;
  explanation: string | null;
  evidence_item_ids: string[];
  detected_at: string;
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
  OA: 'Otti Assistant',
  PEX: 'Partner Experience',
  INT: 'Integrations',
};

// --- Helpers ---

function periodToDays(period: string): number | null {
  switch (period) {
    case '30d': return 30;
    case '90d': return 90;
    default: return null;
  }
}

function periodRange(period: string): { start: string; end: string; priorStart: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const days = periodToDays(period);

  if (!days) {
    const db = getDb();
    const row = db.prepare("SELECT MIN(created_at) as m FROM work_items WHERE source = 'jira'").get() as { m: string } | undefined;
    const minDate = row?.m?.slice(0, 10) || end;
    return { start: minDate, end, priorStart: minDate };
  }

  const start = new Date(now);
  start.setDate(start.getDate() - days);
  const priorStart = new Date(start);
  priorStart.setDate(priorStart.getDate() - days);

  return { start: start.toISOString().slice(0, 10), end, priorStart: priorStart.toISOString().slice(0, 10) };
}

function extractTicketKeys(text: string): string[] {
  const matches = text.match(/[A-Z]+-\d+/g);
  return matches ? [...new Set(matches)] : [];
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

export function getProjectDetail(projectKey: string, period: string): ProjectDetail {
  const db = getDb();
  const { start, end, priorStart } = periodRange(period);
  const endTs = end + 'T23:59:59';
  const startTs = start + 'T00:00:00';
  const priorStartTs = priorStart + 'T00:00:00';

  const name = PROJECT_NAMES[projectKey] || projectKey;

  // --- Tickets ---
  const allTickets = db.prepare(`
    SELECT id, source_id, title, status, created_at, updated_at, url
    FROM work_items
    WHERE source = 'jira' AND json_extract(metadata, '$.project') = ?
    ORDER BY updated_at DESC, created_at DESC
  `).all(projectKey) as ProjectTicket[];

  const totalTickets = allTickets.length;
  const doneTickets = allTickets.filter(t => ['done', 'closed', 'resolved'].includes(t.status));
  const openTickets = allTickets.filter(t => !['done', 'closed', 'resolved'].includes(t.status));

  // --- Link PRs to tickets ---
  const allPRs = db.prepare(`
    SELECT source_id, title, status, updated_at, url,
           json_extract(metadata, '$.repo') as repo
    FROM work_items
    WHERE source = 'github'
  `).all() as (LinkedPR & { repo: string })[];

  // Build a map: ticket key → PRs
  const ticketPRMap = new Map<string, LinkedPR[]>();
  let projectPRCount = 0;
  for (const pr of allPRs) {
    const keys = extractTicketKeys(pr.title + ' ' + pr.source_id);
    for (const key of keys) {
      if (key.startsWith(projectKey + '-')) {
        if (!ticketPRMap.has(key)) ticketPRMap.set(key, []);
        ticketPRMap.get(key)!.push(pr);
        projectPRCount++;
      }
    }
  }

  // Attach PRs to tickets
  const ticketsWithPRs: ProjectTicket[] = allTickets.map(t => ({
    ...t,
    linked_prs: ticketPRMap.get(t.source_id) || [],
  }));

  // Deduplicate PR count (same PR may link to multiple tickets)
  const uniquePRIds = new Set<string>();
  for (const prs of ticketPRMap.values()) {
    for (const pr of prs) uniquePRIds.add(pr.source_id);
  }
  const totalPRs = uniquePRIds.size;

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

  const completionPct = totalTickets > 0
    ? Math.round(doneTickets.length / totalTickets * 100)
    : 0;

  // --- Code Activity ---
  const projectPRs = allPRs.filter(pr => {
    const keys = extractTicketKeys(pr.title + ' ' + pr.source_id);
    return keys.some(k => k.startsWith(projectKey + '-'));
  });
  const mergedPRs = projectPRs.filter(pr => pr.status === 'done' || pr.status === 'merged');
  const openPRs = projectPRs.filter(pr => pr.status === 'open');
  // Actually get unique authors from work_items
  const uniquePRIdsArr = Array.from(uniquePRIds);
  const authorRows = uniquePRIdsArr.length > 0
    ? db.prepare(`
        SELECT DISTINCT author FROM work_items
        WHERE source = 'github' AND source_id IN (${uniquePRIdsArr.map(() => '?').join(',')})
        AND author IS NOT NULL
      `).all(...uniquePRIdsArr) as { author: string }[]
    : [];
  const contributorNames = authorRows.map(r => r.author);

  const days = periodToDays(period) || 60;
  const weeks = Math.max(days / 7, 1);
  const mergeCadence = Math.round(mergedPRs.length / weeks * 10) / 10;

  const repos = [...new Set(projectPRs.map(pr => pr.repo).filter(Boolean))];

  // --- Velocity Weekly ---
  const weeklyRows = db.prepare(`
    SELECT strftime('%Y-%W', updated_at) as week, COUNT(*) as closed
    FROM work_items
    WHERE source = 'jira'
      AND json_extract(metadata, '$.project') = ?
      AND status IN ('done', 'closed', 'resolved')
      AND updated_at >= ? AND updated_at <= ?
    GROUP BY week ORDER BY week ASC
  `).all(projectKey, startTs, endTs) as { week: string; closed: number }[];

  const velocityWeekly: VelocityWeek[] = weeklyRows
    .filter(r => r.week != null)
    .map(r => ({
      week: 'W' + r.week.slice(5),
      closed: r.closed,
    }));

  // --- Summary ---
  const summaryRow = db.prepare(
    'SELECT recap, summary_generated_at FROM project_summaries WHERE project_key = ?'
  ).get(projectKey) as { recap: string | null; summary_generated_at: string | null } | undefined;

  const signals: ProjectSignals = {
    completion_pct: completionPct,
    completion_done: doneTickets.length,
    completion_total: totalTickets,
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

  // suppress unused variable warning
  void projectPRCount;

  return {
    project: { key: projectKey, name, total_tickets: totalTickets, total_prs: totalPRs },
    health: {
      status: computeHealthStatus(signals),
      summary: summaryRow?.recap || null,
      summary_generated_at: summaryRow?.summary_generated_at || null,
      signals,
    },
    velocity_weekly: velocityWeekly,
    code_activity: {
      total_prs: totalPRs,
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

export function getProjectSummaryCards(period: string): ProjectSummaryCard[] {
  const db = getDb();
  const { start, end, priorStart } = periodRange(period);
  const startTs = start + 'T00:00:00';
  const endTs = end + 'T23:59:59';
  const priorStartTs = priorStart + 'T00:00:00';

  // Get all JIRA project keys
  const projectKeys = db.prepare(`
    SELECT DISTINCT json_extract(metadata, '$.project') as key
    FROM work_items WHERE source = 'jira'
  `).all() as { key: string }[];

  // All PRs for linking
  const allPRs = db.prepare("SELECT source_id, title FROM work_items WHERE source = 'github'").all() as { source_id: string; title: string }[];

  const cards: ProjectSummaryCard[] = [];

  for (const { key } of projectKeys) {
    if (!key) continue;
    const name = PROJECT_NAMES[key] || key;

    const allTickets = db.prepare(`
      SELECT status, updated_at, created_at FROM work_items
      WHERE source = 'jira' AND json_extract(metadata, '$.project') = ?
    `).all(key) as { status: string; updated_at: string | null; created_at: string }[];

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

    // Count PRs linked to this project
    const prCount = new Set(allPRs.filter(pr => {
      const keys = extractTicketKeys(pr.title + ' ' + pr.source_id);
      return keys.some(k => k.startsWith(key + '-'));
    }).map(pr => pr.source_id)).size;

    // Summary
    const summaryRow = db.prepare(
      'SELECT recap FROM project_summaries WHERE project_key = ?'
    ).get(key) as { recap: string | null } | undefined;
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
