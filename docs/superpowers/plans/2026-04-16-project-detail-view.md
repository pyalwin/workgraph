# Project Detail View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project detail pages with health snapshots, delivery metrics, code activity, AI-generated summaries, and a ticket list with linked GitHub PRs — plus redesign the projects index as compact summary cards.

**Architecture:** Query layer computes all metrics from existing `work_items` table (JIRA tickets + GitHub PRs). PRs are linked to tickets by extracting JIRA keys from PR titles. AI summaries are generated via Claude Haiku with 24h cache in `project_summaries`. Health status is computed from velocity/cycle time/stale signals.

**Tech Stack:** Next.js 14 App Router, better-sqlite3, Anthropic SDK (Claude Haiku), Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-04-16-project-detail-view-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/lib/project-queries.ts` | All SQL: project metrics, health scoring, ticket-PR linking, index summaries |
| Create | `src/lib/project-summary.ts` | Claude Haiku summary generation + cache check + storage |
| Modify | `src/lib/schema.ts` | Add summary_generated_at column to project_summaries |
| Create | `src/app/api/projects/[key]/route.ts` | GET project detail metrics |
| Create | `src/app/api/projects/[key]/refresh-summary/route.ts` | POST force regenerate summary |
| Create | `src/components/projects/health-snapshot.tsx` | Narrative + signal strip banner |
| Create | `src/components/projects/project-card.tsx` | Compact summary card for index |
| Create | `src/components/projects/ticket-list.tsx` | Filterable ticket rows with linked PRs |
| Create | `src/app/projects/[key]/page.tsx` | Server component for detail page |
| Create | `src/app/projects/[key]/project-detail-client.tsx` | Client component for detail page |
| Rewrite | `src/app/projects/page.tsx` | Redesigned index with summary cards |
| Rewrite | `src/app/projects/projects-client.tsx` | Card grid layout for index |

---

### Task 1: Schema — Add summary_generated_at column

**Files:**
- Modify: `src/lib/schema.ts`

- [ ] **Step 1: Add column migration**

In `src/lib/schema.ts`, add a new exported function after `seedOttiUsers()`:

```typescript
export function migrateProjectSummaries() {
  const db = getDb();
  // SQLite doesn't support IF NOT EXISTS for ALTER TABLE columns
  // Check if column exists first
  const cols = db.prepare("PRAGMA table_info(project_summaries)").all() as { name: string }[];
  if (!cols.find(c => c.name === 'summary_generated_at')) {
    db.exec("ALTER TABLE project_summaries ADD COLUMN summary_generated_at TEXT");
  }
}
```

- [ ] **Step 2: Verify**

```bash
cd ~/Documents/Tracker/workgraph && npx tsx -e "
const { initSchema, migrateProjectSummaries } = require('./src/lib/schema');
initSchema(); migrateProjectSummaries();
const { getDb } = require('./src/lib/db');
const cols = getDb().prepare('PRAGMA table_info(project_summaries)').all();
console.log(cols.map(c => c.name));
"
```

Expected: columns list includes `summary_generated_at`.

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Tracker/workgraph && git add src/lib/schema.ts && git commit -m "feat(projects): add summary_generated_at column migration"
```

---

### Task 2: Query Layer — project-queries.ts

**Files:**
- Create: `src/lib/project-queries.ts`

- [ ] **Step 1: Create the query module**

Create `src/lib/project-queries.ts` with all SQL logic for project metrics.

```typescript
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

export interface ProjectDetail {
  project: { key: string; name: string; total_tickets: number; total_prs: number };
  health: ProjectHealth;
  velocity_weekly: VelocityWeek[];
  code_activity: CodeActivity;
  tickets: ProjectTicket[];
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
  const contributors = [...new Set(projectPRs.map(pr => {
    // Extract author from metadata if available, fallback to repo
    return pr.repo || 'unknown';
  }))];
  // Actually get unique authors from work_items
  const authorRows = db.prepare(`
    SELECT DISTINCT author FROM work_items
    WHERE source = 'github' AND source_id IN (${Array.from(uniquePRIds).map(() => '?').join(',')})
    AND author IS NOT NULL
  `).all(...Array.from(uniquePRIds)) as { author: string }[];
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

  const velocityWeekly: VelocityWeek[] = weeklyRows.map(r => ({
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
```

- [ ] **Step 2: Verify queries work**

```bash
cd ~/Documents/Tracker/workgraph && npx tsx -e "
const { initSchema, migrateProjectSummaries } = require('./src/lib/schema');
initSchema(); migrateProjectSummaries();
const { getProjectDetail, getProjectSummaryCards } = require('./src/lib/project-queries');
const d = getProjectDetail('OA', '30d');
console.log('OA:', d.project.total_tickets, 'tickets,', d.project.total_prs, 'PRs');
console.log('Health:', d.health.status, '| velocity:', d.health.signals.velocity);
console.log('Tickets with PRs:', d.tickets.filter(t => t.linked_prs.length > 0).length);
console.log('---');
const cards = getProjectSummaryCards('30d');
cards.forEach(c => console.log(c.key, c.name, c.completion_pct + '%', c.velocity, 'velocity'));
"
```

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Tracker/workgraph && git add src/lib/project-queries.ts && git commit -m "feat(projects): add query layer for project metrics and ticket-PR linking"
```

---

### Task 3: AI Summary — project-summary.ts

**Files:**
- Create: `src/lib/project-summary.ts`

- [ ] **Step 1: Create the summary module**

Create `src/lib/project-summary.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from './db';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface SummaryCache {
  recap: string | null;
  summary_generated_at: string | null;
}

function isCacheStale(generatedAt: string | null): boolean {
  if (!generatedAt) return true;
  const age = Date.now() - new Date(generatedAt).getTime();
  return age > CACHE_TTL_MS;
}

export async function getOrGenerateSummary(projectKey: string, projectName: string): Promise<string> {
  const db = getDb();

  // Check cache
  const cached = db.prepare(
    'SELECT recap, summary_generated_at FROM project_summaries WHERE project_key = ?'
  ).get(projectKey) as SummaryCache | undefined;

  if (cached?.recap && !isCacheStale(cached.summary_generated_at)) {
    return cached.recap;
  }

  // Gather context for the summary
  const tickets = db.prepare(`
    SELECT source_id, title, status, body FROM work_items
    WHERE source = 'jira' AND json_extract(metadata, '$.project') = ?
      AND status IN ('done', 'closed', 'resolved')
    ORDER BY updated_at DESC
    LIMIT 30
  `).all(projectKey) as { source_id: string; title: string; status: string; body: string | null }[];

  // Find linked PRs for these tickets
  const allPRs = db.prepare(`
    SELECT source_id, title FROM work_items WHERE source = 'github'
  `).all() as { source_id: string; title: string }[];

  const ticketSummaries = tickets.map(t => {
    const linkedPRs = allPRs.filter(pr => {
      const text = pr.title + ' ' + pr.source_id;
      return text.includes(t.source_id);
    });
    const prList = linkedPRs.length > 0
      ? linkedPRs.map(pr => `  - PR: ${pr.title}`).join('\n')
      : '';
    return `${t.source_id}: ${t.title}${prList ? '\n' + prList : ''}`;
  }).join('\n');

  if (tickets.length === 0) {
    const fallback = `No recently completed tickets for ${projectName}.`;
    storeSummary(projectKey, projectName, fallback);
    return fallback;
  }

  // Generate via Claude Haiku
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `You are summarizing an engineering project's recent activity for a dashboard.

Project: ${projectName} (${projectKey})

Recent completed tickets and their linked PRs:
${ticketSummaries}

Write a 2-3 sentence summary of what was shipped. Focus on features built and problems solved. Be specific — name the features, not just counts. Keep it concise.`,
      }],
    });

    const summary = response.content[0].type === 'text' ? response.content[0].text : '';
    storeSummary(projectKey, projectName, summary);
    return summary;
  } catch (e) {
    // If API fails, return cached or fallback
    return cached?.recap || `${projectName}: ${tickets.length} tickets completed recently.`;
  }
}

export async function forceRegenerateSummary(projectKey: string, projectName: string): Promise<string> {
  // Clear the timestamp to force regeneration
  const db = getDb();
  db.prepare('UPDATE project_summaries SET summary_generated_at = NULL WHERE project_key = ?').run(projectKey);
  return getOrGenerateSummary(projectKey, projectName);
}

function storeSummary(projectKey: string, projectName: string, recap: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO project_summaries (project_key, name, recap, summary_generated_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_key) DO UPDATE SET
      recap = excluded.recap,
      summary_generated_at = excluded.summary_generated_at,
      updated_at = excluded.updated_at
  `).run(projectKey, projectName, recap, now, now);
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/Documents/Tracker/workgraph && git add src/lib/project-summary.ts && git commit -m "feat(projects): add Claude Haiku summary generation with 24h cache"
```

---

### Task 4: API Routes

**Files:**
- Create: `src/app/api/projects/[key]/route.ts`
- Create: `src/app/api/projects/[key]/refresh-summary/route.ts`

- [ ] **Step 1: Create project detail API route**

Create `src/app/api/projects/[key]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { initSchema, migrateProjectSummaries } from '@/lib/schema';
import { getProjectDetail } from '@/lib/project-queries';
import { getOrGenerateSummary } from '@/lib/project-summary';

export const dynamic = 'force-dynamic';

const PROJECT_NAMES: Record<string, string> = {
  OA: 'Otti Assistant',
  PEX: 'Partner Experience',
  INT: 'Integrations',
};

export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  initSchema();
  migrateProjectSummaries();

  const period = req.nextUrl.searchParams.get('period') || '30d';
  const projectKey = params.key.toUpperCase();
  const projectName = PROJECT_NAMES[projectKey] || projectKey;

  const detail = getProjectDetail(projectKey, period);

  // Generate or fetch cached summary
  const summary = await getOrGenerateSummary(projectKey, projectName);
  detail.health.summary = summary;

  return NextResponse.json(detail);
}
```

- [ ] **Step 2: Create refresh summary API route**

Create `src/app/api/projects/[key]/refresh-summary/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { initSchema, migrateProjectSummaries } from '@/lib/schema';
import { forceRegenerateSummary } from '@/lib/project-summary';

export const dynamic = 'force-dynamic';

const PROJECT_NAMES: Record<string, string> = {
  OA: 'Otti Assistant',
  PEX: 'Partner Experience',
  INT: 'Integrations',
};

export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  initSchema();
  migrateProjectSummaries();

  const projectKey = params.key.toUpperCase();
  const projectName = PROJECT_NAMES[projectKey] || projectKey;

  const summary = await forceRegenerateSummary(projectKey, projectName);
  return NextResponse.json({ summary });
}
```

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Tracker/workgraph && git add src/app/api/projects/ && git commit -m "feat(projects): add detail and refresh-summary API routes"
```

---

### Task 5: Components — HealthSnapshot, ProjectCard, TicketList

**Files:**
- Create: `src/components/projects/health-snapshot.tsx`
- Create: `src/components/projects/project-card.tsx`
- Create: `src/components/projects/ticket-list.tsx`

- [ ] **Step 1: Create HealthSnapshot**

Create `src/components/projects/health-snapshot.tsx`:

```tsx
'use client';

import { cn } from '@/lib/utils';

interface ProjectSignals {
  completion_pct: number;
  completion_done: number;
  completion_total: number;
  velocity: number;
  velocity_delta_pct: number;
  cycle_time_days: number;
  cycle_time_delta_pct: number;
  pr_cadence_per_week: number;
  stale_count: number;
  stale_pct: number;
}

interface HealthSnapshotProps {
  status: 'healthy' | 'needs_attention' | 'at_risk';
  summary: string | null;
  signals: ProjectSignals;
  onRefresh: () => void;
  refreshing: boolean;
}

const STATUS_CONFIG = {
  healthy: { label: 'Healthy', color: 'text-accent-green', bg: 'bg-accent-green', dot: 'bg-accent-green' },
  needs_attention: { label: 'Needs Attention', color: 'text-[#b8860b]', bg: 'bg-[#b8860b]', dot: 'bg-[#b8860b]' },
  at_risk: { label: 'At Risk', color: 'text-accent-red', bg: 'bg-accent-red', dot: 'bg-accent-red' },
};

export function HealthSnapshot({ status, summary, signals, onRefresh, refreshing }: HealthSnapshotProps) {
  const cfg = STATUS_CONFIG[status];

  return (
    <div className="bg-surface border border-black/[0.07] rounded-card overflow-hidden">
      {/* Narrative top */}
      <div className="px-[22px] pt-[18px] pb-[14px] border-b border-black/[0.05]">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-[8px]">
            <div className={cn("w-[9px] h-[9px] rounded-full", cfg.dot)} />
            <span className={cn("text-[0.82rem] font-semibold", cfg.color)}>{cfg.label}</span>
          </div>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="text-[0.68rem] text-g5 hover:text-g3 transition-colors cursor-pointer disabled:opacity-50"
          >
            {refreshing ? 'Generating...' : 'Refresh'}
          </button>
        </div>
        {summary && (
          <p className="text-[0.78rem] text-g3 leading-[1.55]">{summary}</p>
        )}
      </div>
      {/* Signal strip */}
      <div className="grid grid-cols-5 divide-x divide-black/[0.05] bg-[#fafafa]">
        <div className="py-[12px] px-[14px] text-center">
          <div className="text-[1.1rem] font-bold text-black tabular-nums">{signals.completion_pct}%</div>
          <div className="text-[0.6rem] text-g5">complete</div>
        </div>
        <div className="py-[12px] px-[14px] text-center">
          <div className={cn(
            "text-[1.1rem] font-bold tabular-nums",
            signals.velocity_delta_pct > 0 ? "text-accent-green" : signals.velocity_delta_pct < 0 ? "text-accent-red" : "text-black"
          )}>
            {signals.velocity_delta_pct > 0 ? '+' : ''}{signals.velocity_delta_pct}%
          </div>
          <div className="text-[0.6rem] text-g5">velocity</div>
        </div>
        <div className="py-[12px] px-[14px] text-center">
          <div className="text-[1.1rem] font-bold text-black tabular-nums">{signals.cycle_time_days}d</div>
          <div className="text-[0.6rem] text-g5">cycle time</div>
        </div>
        <div className="py-[12px] px-[14px] text-center">
          <div className="text-[1.1rem] font-bold text-black tabular-nums">{signals.pr_cadence_per_week}</div>
          <div className="text-[0.6rem] text-g5">PRs/wk</div>
        </div>
        <div className="py-[12px] px-[14px] text-center">
          <div className={cn(
            "text-[1.1rem] font-bold tabular-nums",
            signals.stale_count > 0 ? "text-accent-red" : "text-black"
          )}>{signals.stale_count}</div>
          <div className={cn("text-[0.6rem]", signals.stale_count > 0 ? "text-accent-red" : "text-g5")}>stale</div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create ProjectCard**

Create `src/components/projects/project-card.tsx`:

```tsx
import Link from 'next/link';
import { cn } from '@/lib/utils';

interface ProjectCardProps {
  projectKey: string;
  name: string;
  healthStatus: 'healthy' | 'needs_attention' | 'at_risk';
  summarySnippet: string | null;
  completionPct: number;
  completionDone: number;
  completionTotal: number;
  velocity: number;
  velocityDeltaPct: number;
  openCount: number;
  staleCount: number;
  prCount: number;
}

const HEALTH_DOT = {
  healthy: 'bg-accent-green',
  needs_attention: 'bg-[#b8860b]',
  at_risk: 'bg-accent-red',
};

const HEALTH_LABEL = {
  healthy: 'Healthy',
  needs_attention: 'Needs Attention',
  at_risk: 'At Risk',
};

export function ProjectCard({
  projectKey, name, healthStatus, summarySnippet,
  completionPct, completionDone, completionTotal,
  velocity, velocityDeltaPct, openCount, staleCount, prCount,
}: ProjectCardProps) {
  return (
    <Link href={`/projects/${projectKey}`} className="no-underline block">
      <div className="bg-surface border border-black/[0.07] rounded-card p-[22px] transition-all hover:shadow-[0_4px_20px_rgba(0,0,0,0.04)] hover:border-black/[0.13] cursor-pointer">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-[1.05rem] font-semibold tracking-tight text-black">{name}</h2>
            <span className="text-[0.68rem] font-mono text-g5 bg-g9 px-[6px] py-[1px] rounded">{projectKey}</span>
          </div>
          <div className="flex items-center gap-[6px]">
            <div className={cn("w-[7px] h-[7px] rounded-full", HEALTH_DOT[healthStatus])} />
            <span className="text-[0.7rem] font-medium text-g4">{HEALTH_LABEL[healthStatus]}</span>
          </div>
        </div>

        {/* Summary snippet */}
        {summarySnippet && (
          <p className="text-[0.76rem] text-g4 leading-[1.5] mb-3 line-clamp-2">{summarySnippet}</p>
        )}

        {/* Progress bar */}
        <div className="flex h-[5px] rounded-[3px] overflow-hidden bg-g8 mb-3">
          <div className="bg-black rounded-[3px] transition-all" style={{ width: `${completionPct}%` }} />
        </div>

        {/* Signal row */}
        <div className="flex items-center gap-4 text-[0.7rem]">
          <div className="flex items-center gap-1">
            <span className="font-semibold text-g2 tabular-nums">{completionPct}%</span>
            <span className="text-g5">done</span>
          </div>
          <div className="flex items-center gap-1">
            <span className={cn(
              "font-semibold tabular-nums",
              velocityDeltaPct > 0 ? "text-accent-green" : velocityDeltaPct < 0 ? "text-accent-red" : "text-g2"
            )}>
              {velocity}
            </span>
            <span className="text-g5">closed</span>
            {velocityDeltaPct !== 0 && (
              <span className={cn(
                "text-[0.62rem] tabular-nums",
                velocityDeltaPct > 0 ? "text-accent-green" : "text-accent-red"
              )}>
                ({velocityDeltaPct > 0 ? '+' : ''}{velocityDeltaPct}%)
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <span className="font-semibold text-g2 tabular-nums">{openCount}</span>
            <span className="text-g5">open</span>
          </div>
          {staleCount > 0 && (
            <div className="flex items-center gap-1">
              <span className="font-semibold text-accent-red tabular-nums">{staleCount}</span>
              <span className="text-accent-red">stale</span>
            </div>
          )}
          <div className="flex items-center gap-1 ml-auto">
            <span className="font-semibold text-g3 tabular-nums">{prCount}</span>
            <span className="text-g5">PRs</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
```

- [ ] **Step 3: Create TicketList**

Create `src/components/projects/ticket-list.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface LinkedPR {
  source_id: string;
  title: string;
  status: string;
  updated_at: string | null;
  repo: string;
  url: string | null;
}

interface Ticket {
  id: string;
  source_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string | null;
  url: string | null;
  linked_prs: LinkedPR[];
}

interface TicketListProps {
  tickets: Ticket[];
}

type Filter = 'recent' | 'active' | 'stale' | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'recent', label: 'Recently Completed' },
  { key: 'active', label: 'Active' },
  { key: 'stale', label: 'Stale' },
  { key: 'all', label: 'All' },
];

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function isDone(status: string): boolean {
  return ['done', 'closed', 'resolved'].includes(status);
}

function isStale(ticket: Ticket): boolean {
  const lastUpdate = new Date(ticket.updated_at || ticket.created_at);
  return !isDone(ticket.status) && (Date.now() - lastUpdate.getTime()) / 86400000 >= 14;
}

export function TicketList({ tickets }: TicketListProps) {
  const [filter, setFilter] = useState<Filter>('recent');

  const filtered = tickets.filter(t => {
    switch (filter) {
      case 'recent': return isDone(t.status);
      case 'active': return !isDone(t.status) && !isStale(t);
      case 'stale': return isStale(t);
      case 'all': return true;
    }
  });

  return (
    <div>
      {/* Filter pills */}
      <div className="flex gap-[6px] mb-4">
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              "px-[14px] py-[5px] rounded-lg text-[0.74rem] border cursor-pointer transition-all",
              filter === f.key
                ? "bg-black border-black text-white font-medium"
                : "bg-surface border-black/[0.07] text-g4 hover:border-black/[0.13]"
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-[0.8rem] text-g5 py-6 text-center">No tickets match this filter.</div>
      ) : (
        <div className="bg-surface border border-black/[0.07] rounded-card overflow-hidden">
          {filtered.map((t, i) => (
            <div key={t.id} className={cn("px-[18px] py-[14px]", i > 0 && "border-t border-black/[0.05]")}>
              {/* Ticket row */}
              <div className="flex items-center gap-[10px] mb-1">
                <span className="text-[0.68rem] font-semibold text-g5 bg-g9 px-[6px] py-[1px] rounded shrink-0">
                  {t.source_id}
                </span>
                <span className="text-[0.8rem] font-medium text-g2 truncate flex-1">
                  {t.url ? (
                    <a href={t.url} target="_blank" rel="noopener noreferrer" className="hover:underline text-g2 no-underline">
                      {t.title}
                    </a>
                  ) : t.title}
                </span>
                <Badge
                  variant="secondary"
                  className={cn(
                    "text-[0.6rem] shrink-0",
                    isDone(t.status) ? "bg-[rgba(26,135,84,0.08)] text-[#1a8754]" : ""
                  )}
                >
                  {t.status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                </Badge>
                <span className="text-[0.68rem] text-g6 tabular-nums shrink-0">
                  {formatDate(t.updated_at || t.created_at)}
                </span>
              </div>

              {/* Linked PRs */}
              {t.linked_prs.length > 0 ? (
                <div className="flex flex-wrap gap-[6px] mt-[6px] ml-[2px]">
                  {t.linked_prs.map(pr => (
                    <div key={pr.source_id} className="flex items-center gap-[5px] text-[0.68rem] text-g5 bg-[#fafafa] border border-black/[0.05] px-[8px] py-[2px] rounded">
                      <span className="font-medium text-g3">GH</span>
                      {pr.url ? (
                        <a href={pr.url} target="_blank" rel="noopener noreferrer" className="text-g5 hover:text-g3 no-underline hover:underline">
                          {pr.source_id.split('/').pop()}
                        </a>
                      ) : (
                        <span>{pr.source_id.split('/').pop()}</span>
                      )}
                      <span className="text-g6">
                        {pr.updated_at ? formatDate(pr.updated_at) : ''}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[0.66rem] text-g6 mt-[4px] ml-[2px] italic">No linked PRs</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/Tracker/workgraph && git add src/components/projects/ && git commit -m "feat(projects): add health snapshot, project card, and ticket list components"
```

---

### Task 6: Project Detail Page

**Files:**
- Create: `src/app/projects/[key]/page.tsx`
- Create: `src/app/projects/[key]/project-detail-client.tsx`

- [ ] **Step 1: Create server component**

Create `src/app/projects/[key]/page.tsx`:

```tsx
import { initSchema, migrateProjectSummaries } from '@/lib/schema';
import { ProjectDetailClient } from './project-detail-client';

export const dynamic = 'force-dynamic';

export default function ProjectDetailPage({ params }: { params: { key: string } }) {
  initSchema();
  migrateProjectSummaries();

  return <ProjectDetailClient projectKey={params.key.toUpperCase()} />;
}
```

- [ ] **Step 2: Create client component**

Create `src/app/projects/[key]/project-detail-client.tsx`:

```tsx
'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { StatCard } from '@/components/stat-card';
import { PeriodSelector } from '@/components/otti/period-selector';
import { HealthSnapshot } from '@/components/projects/health-snapshot';
import { TicketList } from '@/components/projects/ticket-list';
import type { ProjectDetail } from '@/lib/project-queries';

const PERIODS = ['30d', '90d', 'all'];

export function ProjectDetailClient({ projectKey }: { projectKey: string }) {
  const [period, setPeriod] = useState('30d');
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/projects/${projectKey}?period=${period}`);
    const json = await res.json();
    setData(json);
    setLoading(false);
  }, [projectKey, period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    const res = await fetch(`/api/projects/${projectKey}/refresh-summary`, { method: 'POST' });
    const { summary } = await res.json();
    setData(prev => prev ? { ...prev, health: { ...prev.health, summary } } : prev);
    setRefreshing(false);
  };

  if (loading && !data) {
    return (
      <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
        <div className="text-[0.82rem] text-g5">Loading...</div>
      </div>
    );
  }

  if (!data) return null;

  const d = data;
  const s = d.health.signals;
  const maxWeekly = Math.max(...d.velocity_weekly.map(w => w.closed), 1);

  return (
    <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
      {/* Header */}
      <div className="mb-2">
        <Link href="/projects" className="text-[0.74rem] text-g5 hover:text-g3 no-underline transition-colors">
          &larr; Back to Projects
        </Link>
      </div>
      <div className="flex items-start justify-between mb-7">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[1.5rem] font-bold tracking-tight text-black">{d.project.name}</h1>
            <span className="text-[0.72rem] font-mono text-g5 bg-g9 px-[7px] py-[2px] rounded">{d.project.key}</span>
          </div>
          <p className="text-[0.82rem] text-g5">
            {d.project.total_tickets} tickets &middot; {d.project.total_prs} linked PRs
          </p>
        </div>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      {/* Health Snapshot */}
      <div className="mb-8">
        <HealthSnapshot
          status={d.health.status}
          summary={d.health.summary}
          signals={d.health.signals}
          onRefresh={handleRefresh}
          refreshing={refreshing}
        />
      </div>

      {/* Delivery Health */}
      <div className="mb-8">
        <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-4 pb-2 border-b border-black/[0.07]">
          Delivery Health
        </div>
        <div className="grid grid-cols-12 gap-[10px]">
          <div className="col-span-3">
            <StatCard label="Completion" value={`${s.completion_pct}%`} delta={`${s.completion_done} of ${s.completion_total}`} trend={s.completion_pct >= 50 ? 'up' : 'down'} />
          </div>
          <div className="col-span-3">
            <StatCard label="Velocity" value={String(s.velocity)} delta={`${s.velocity_delta_pct > 0 ? '+' : ''}${s.velocity_delta_pct}% vs prior`} trend={s.velocity_delta_pct >= 0 ? 'up' : 'down'} />
          </div>
          <div className="col-span-3">
            <StatCard label="Avg Cycle Time" value={`${s.cycle_time_days}d`} delta={s.cycle_time_delta_pct !== 0 ? `${s.cycle_time_delta_pct > 0 ? '+' : ''}${s.cycle_time_delta_pct}%` : 'stable'} trend={s.cycle_time_delta_pct <= 0 ? 'up' : 'down'} />
          </div>
          <div className="col-span-3">
            <StatCard label="Stale Tickets" value={String(s.stale_count)} delta={s.stale_count > 0 ? `${s.stale_pct}% of open` : 'none'} trend={s.stale_count === 0 ? 'up' : 'down'} />
          </div>

          {/* Velocity chart */}
          <div className="col-span-12 bg-surface border border-black/[0.07] rounded-card p-[22px]">
            <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Tickets Closed / Week</div>
            {d.velocity_weekly.length === 0 ? (
              <div className="text-[0.8rem] text-g5 py-4">No velocity data for this period.</div>
            ) : (
              <div className="flex items-end gap-[4px]" style={{ height: 120 }}>
                {d.velocity_weekly.map((w, i) => {
                  const h = Math.max(Math.round((w.closed / maxWeekly) * 100), w.closed > 0 ? 6 : 2);
                  const isLast = i === d.velocity_weekly.length - 1;
                  return (
                    <div key={w.week} className="flex-1 flex flex-col items-center justify-end gap-1" style={{ height: 110 }}>
                      <div className="text-[0.58rem] font-semibold tabular-nums text-g4">{w.closed}</div>
                      <div
                        className={`w-full rounded-t-[3px] ${w.closed === 0 ? 'bg-g8' : isLast ? 'bg-accent-green' : 'bg-black'}`}
                        style={{ height: h }}
                      />
                      <span className="text-[0.55rem] text-g5 tabular-nums">{w.week}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Code Activity */}
      <div className="mb-8">
        <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-4 pb-2 border-b border-black/[0.07]">
          Code Activity
        </div>
        <div className="grid grid-cols-12 gap-[10px]">
          <div className="col-span-3">
            <StatCard label="Linked PRs" value={String(d.code_activity.total_prs)} delta={`${d.code_activity.merged_prs} merged, ${d.code_activity.open_prs} open`} />
          </div>
          <div className="col-span-3">
            <StatCard label="Contributors" value={String(d.code_activity.contributor_count)} delta={d.code_activity.contributors.slice(0, 3).join(', ')} />
          </div>
          <div className="col-span-3">
            <StatCard label="Merge Cadence" value={String(d.code_activity.merge_cadence_per_week)} delta="PRs merged / week" />
          </div>
          <div className="col-span-3">
            <StatCard label="Repos" value={String(d.code_activity.repo_count)} delta={d.code_activity.repos.map(r => r.split('/').pop()).join(', ')} />
          </div>
        </div>
      </div>

      {/* Tickets & Features */}
      <div className="mb-8">
        <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-4 pb-2 border-b border-black/[0.07]">
          Tickets & Features Built
        </div>
        <TicketList tickets={d.tickets} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Tracker/workgraph && git add src/app/projects/\[key\]/ && git commit -m "feat(projects): add project detail page with health, metrics, and ticket list"
```

---

### Task 7: Redesign Projects Index

**Files:**
- Rewrite: `src/app/projects/page.tsx`
- Rewrite: `src/app/projects/projects-client.tsx`

- [ ] **Step 1: Rewrite server component**

Replace `src/app/projects/page.tsx` with:

```tsx
import { initSchema, migrateProjectSummaries } from '@/lib/schema';
import { getProjectSummaryCards } from '@/lib/project-queries';
import { ProjectsIndexClient } from './projects-client';

export const dynamic = 'force-dynamic';

export default function ProjectsPage() {
  initSchema();
  migrateProjectSummaries();

  const cards = getProjectSummaryCards('30d');
  return <ProjectsIndexClient initialCards={cards} />;
}
```

- [ ] **Step 2: Rewrite client component**

Replace `src/app/projects/projects-client.tsx` with:

```tsx
'use client';

import { useState, useEffect } from 'react';
import { PeriodSelector } from '@/components/otti/period-selector';
import { ProjectCard } from '@/components/projects/project-card';
import type { ProjectSummaryCard } from '@/lib/project-queries';

const PERIODS = ['30d', '90d', 'all'];

export function ProjectsIndexClient({ initialCards }: { initialCards: ProjectSummaryCard[] }) {
  const [period, setPeriod] = useState('30d');
  const [cards, setCards] = useState(initialCards);

  useEffect(() => {
    // Refetch when period changes (initial render uses server data)
    if (period === '30d') {
      setCards(initialCards);
      return;
    }
    fetch(`/api/projects/index?period=${period}`)
      .then(r => r.json())
      .then(setCards)
      .catch(() => {});
  }, [period, initialCards]);

  const totalTickets = cards.reduce((s, c) => s + c.completion_total, 0);
  const totalPRs = cards.reduce((s, c) => s + c.pr_count, 0);

  return (
    <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
      <div className="flex items-start justify-between mb-7">
        <div>
          <h1 className="text-[1.5rem] font-bold tracking-tight text-black mb-[2px]">Projects</h1>
          <p className="text-[0.82rem] text-g5">
            {cards.length} projects &middot; {totalTickets} tickets &middot; {totalPRs} PRs
          </p>
        </div>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      {cards.length === 0 ? (
        <div className="p-8 bg-white border border-black/[0.07] rounded-[14px] text-center text-g5 text-[0.87rem]">
          No project data yet. Run a sync from Settings to populate work items.
        </div>
      ) : (
        <div className="flex flex-col gap-[12px]">
          {cards.map(c => (
            <ProjectCard
              key={c.key}
              projectKey={c.key}
              name={c.name}
              healthStatus={c.health_status}
              summarySnippet={c.summary_snippet}
              completionPct={c.completion_pct}
              completionDone={c.completion_done}
              completionTotal={c.completion_total}
              velocity={c.velocity}
              velocityDeltaPct={c.velocity_delta_pct}
              openCount={c.open_count}
              staleCount={c.stale_count}
              prCount={c.pr_count}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add index API route for period switching**

Create `src/app/api/projects/index/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { initSchema, migrateProjectSummaries } from '@/lib/schema';
import { getProjectSummaryCards } from '@/lib/project-queries';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  initSchema();
  migrateProjectSummaries();

  const period = req.nextUrl.searchParams.get('period') || '30d';
  return NextResponse.json(getProjectSummaryCards(period));
}
```

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/Tracker/workgraph && git add src/app/projects/page.tsx src/app/projects/projects-client.tsx src/app/api/projects/index/ && git commit -m "feat(projects): redesign index page with compact summary cards"
```

---

### Task 8: Verify

- [ ] **Step 1: Start dev server**

```bash
cd ~/Documents/Tracker/workgraph && bun run dev
```

- [ ] **Step 2: Verify index page**

Open `/projects` — should show compact cards for OA, PEX, INT with health badges, summary snippets, metrics, and progress bars. Click a card to navigate to detail.

- [ ] **Step 3: Verify detail page**

Open `/projects/OA` — should show:
- Health snapshot with AI summary (first load generates it, ~2s)
- Delivery health KPIs + velocity chart
- Code activity KPIs
- Ticket list with linked PRs
- Refresh button regenerates summary

- [ ] **Step 4: Test period switching**

Switch between 30d / 90d / All on both pages.

- [ ] **Step 5: Fix any issues**

- [ ] **Step 6: Final commit**

```bash
cd ~/Documents/Tracker/workgraph && git add -A && git commit -m "feat(projects): complete project detail view with health, metrics, and AI summaries"
```
