# Project Detail View — Design Spec

**Date:** 2026-04-16
**Status:** Approved
**Audience:** Internal — Arun for deep project health metrics, team for feature visibility

## Overview

Add a project detail page (`/projects/[key]`) to the WorkGraph Tracker that shows delivery health, code activity, and a ticket-level feature list with linked GitHub PRs. Each project gets an AI-generated narrative summary (cached 24h, Claude Haiku) and a computed health score.

## Data Layer

### PR ↔ Ticket Linking

GitHub PRs are linked to JIRA tickets at query time by extracting ticket keys from PR titles and source_ids using regex `/([A-Z]+-\d+)/`. Example: PR title "PEX-779: Fix missing Exists import" links to JIRA ticket PEX-779.

No new table needed — both PR and ticket data already exist in `work_items`. The query joins them via the extracted key.

### Summary Cache

Use existing `project_summaries` table. Add `summary_generated_at TEXT` column via schema migration (ALTER TABLE IF NOT EXISTS pattern in initSchema).

Fields used:
- `project_key` — JIRA project key (OA, PEX, INT)
- `recap` — AI-generated summary text
- `summary_generated_at` — ISO timestamp of last generation

Cache TTL: 24 hours. On page load, if `summary_generated_at` is null or older than 24h, regenerate. A refresh button forces immediate regeneration.

### Health Score

Computed from metrics at query time, not stored. Three levels:

| Status | Criteria |
|--------|----------|
| **Healthy** | Velocity stable or up AND stale < 10% of open tickets AND cycle time stable or improving |
| **Needs Attention** | Velocity flat OR stale 10-20% of open OR cycle time increasing by > 20% |
| **At Risk** | Velocity declining > 20% OR stale > 20% of open OR no merged PRs in 7+ days |

Velocity comparison: current period tickets closed vs prior equivalent period.
Cycle time comparison: current period avg days (open → done) vs prior period.
Stale definition: open ticket with no updates in 14+ days.

## API Routes

### `GET /api/projects/[key]?period=30d`

**Parameters:**
- `period`: `30d` (default), `90d`, `all`

**Response:**

```json
{
  "project": {
    "key": "OA",
    "name": "Otti Assistant",
    "total_tickets": 100,
    "total_prs": 47
  },
  "health": {
    "status": "healthy",
    "summary": "Shipped WebSocket streaming for real-time Slack responses, integrated Codemesh knowledge graph...",
    "summary_generated_at": "2026-04-16T10:00:00Z",
    "signals": {
      "completion_pct": 62,
      "completion_done": 62,
      "completion_total": 100,
      "velocity": 18,
      "velocity_prior": 14,
      "velocity_delta_pct": 28,
      "cycle_time_days": 4.2,
      "cycle_time_prior_days": 5.5,
      "cycle_time_delta_pct": -24,
      "pr_cadence_per_week": 3.2,
      "stale_count": 5,
      "stale_pct": 13.2
    }
  },
  "velocity_weekly": [
    { "week": "W12", "closed": 3 },
    { "week": "W13", "closed": 5 }
  ],
  "code_activity": {
    "total_prs": 47,
    "merged_prs": 42,
    "open_prs": 5,
    "contributors": ["arunv", "cody.towstik", "gus.fernandes"],
    "contributor_count": 8,
    "merge_cadence_per_week": 3.2,
    "repos": ["plateiq/server", "plateiq/datadash"],
    "repo_count": 2
  },
  "tickets": [
    {
      "id": "work-item-uuid",
      "source_id": "OA-131",
      "title": "Disable Claude Code Review CI on PRs",
      "status": "done",
      "created_at": "2026-03-15",
      "updated_at": "2026-04-08",
      "linked_prs": [
        {
          "source_id": "plateiq/server#26675",
          "title": "OA-131 Disable Claude Code Review CI on PRs",
          "status": "done",
          "merged_at": "2026-04-08",
          "repo": "plateiq/server"
        }
      ]
    }
  ]
}
```

### `POST /api/projects/[key]/refresh-summary`

Forces regeneration of the AI summary. Returns the new summary text.

## AI Summary Generation

**Module:** `src/lib/project-summary.ts`

**Process:**
1. Gather up to 30 most recent done/closed tickets for the project with their descriptions
2. Gather linked PR titles and bodies
3. Call Claude Haiku with prompt:

```
You are summarizing an engineering project's recent activity for a dashboard.

Project: {project_name} ({project_key})
Period: last {period_days} days

Recent completed tickets and their linked PRs:
{ticket_list_with_pr_titles}

Write a 2-3 sentence summary of what was shipped. Focus on features built and problems solved. 
If there are stale or blocked tickets, mention them briefly.
Be specific — name the features, not just counts.
```

4. Store result in `project_summaries.recap` with `summary_generated_at = now()`
5. Return the summary text

**Model:** Claude Haiku (fast, cheap — `claude-haiku-4-5-20251001`)
**Max tokens:** 200
**Cache TTL:** 24 hours

## Page Structure

### Route: `/projects/[key]`

**Files:**
- `src/app/projects/[key]/page.tsx` — server component (init schema, load project key)
- `src/app/projects/[key]/project-detail-client.tsx` — client component (fetch + render)

### Section 1: Header + Health Snapshot

- Back link: "← Back to Projects"
- Title: project name + key badge + total tickets/PRs count
- Period selector: 30d (default), 90d, All
- Health snapshot card (Compact Combined style):
  - Top: health dot + status label + one-line narrative from AI summary
  - Bottom: 5-cell signal strip (completion %, velocity delta, cycle time, PRs/wk, stale count)
  - Refresh button (regenerates AI summary)

### Section 2: Delivery Health

- 4 KPI cards (reuse StatCard): Completion %, Velocity (period), Avg Cycle Time, Stale Count
- Weekly velocity bar chart (tickets closed per week)

### Section 3: Code Activity

- 4 KPI cards: Linked PRs (merged/open), Contributors, Merge Cadence, Repos Touched

### Section 4: Tickets & Features Built

- Filter pills: Recently Completed (default), Active, Stale, All
- Ticket list — each row:
  - JIRA key badge, ticket title, status badge, date
  - Nested: linked GitHub PRs (repo badge, PR number + title snippet, merge date)
  - Tickets with no PRs: "No linked PRs yet" in muted text
- Expandable rows (reuse existing ItemDetailPanel pattern from projects-client.tsx)

## Navigation Changes

Modify existing `/projects` page:
- Each project card becomes a clickable link to `/projects/[key]`
- No other changes to the index page

## Components

### Reuse
- `StatCard` — all KPI cards
- `Card` / `CardContent` / `CardTitle` — containers
- `Badge` — status and source badges
- `VolumeChart` — reuse for weekly velocity (or adapt)
- `PeriodSelector` — reuse from otti components
- Design tokens: g1-g9, accent-green, accent-red, rounded-card

### New
- `src/components/projects/health-snapshot.tsx` — narrative + signal strip banner
- `src/components/projects/ticket-list.tsx` — filterable ticket rows with nested linked PRs
- `src/lib/project-queries.ts` — all SQL queries for project metrics, health scoring, ticket-PR linking
- `src/lib/project-summary.ts` — Claude Haiku summary generation + cache check + storage

## Schema Changes

Add column to existing table (safe — ALTER TABLE IF column doesn't exist):

```sql
-- In initSchema, after project_summaries table creation
ALTER TABLE project_summaries ADD COLUMN summary_generated_at TEXT;
```

Use a try/catch around the ALTER since SQLite doesn't support IF NOT EXISTS for columns.

## Design System Compliance

- Warm white theme (bg: #fafafa, cards: white, borders: black/[0.07])
- Font: Inter, sizes matching existing pages
- Health badge colors: green (#1a8754) = Healthy, amber (#b8860b) = Needs Attention, red (#c53030) = At Risk
- Card radius: 14px (rounded-card)
- Section headers: 0.67rem uppercase semibold tracking-wide
