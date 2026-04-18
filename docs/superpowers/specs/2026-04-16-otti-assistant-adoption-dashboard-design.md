# Otti Assistant Adoption Dashboard — Design Spec

**Date:** 2026-04-16
**Status:** Approved
**Audience:** Internal (Arun for deep metrics, broader team for high-level adoption view)

## Overview

Add an "Otti Assistant" tab to the WorkGraph Tracker app that visualizes adoption and performance metrics for the Otti Assistant Slack bot. Data comes from session transcript JSONL files (pulled from EC2), ingested into the existing `workgraph.db` SQLite database.

## Data Layer

### Schema

```sql
CREATE TABLE otti_sessions (
  id TEXT PRIMARY KEY,           -- task_id from JSONL first line
  ts_start TEXT NOT NULL,        -- ISO timestamp (first event)
  ts_end TEXT NOT NULL,          -- ISO timestamp (last event)
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  persona TEXT NOT NULL,          -- engineering, product, general, customer_success
  intent TEXT NOT NULL,           -- code_read, db_query, notion_lookup, general_question, pr_review, code_write
  agent_type TEXT NOT NULL,       -- orchestrator, chat, pr_review
  model TEXT NOT NULL,            -- haiku, sonnet, opus
  repo_name TEXT,
  num_events INTEGER NOT NULL,
  duration_s REAL NOT NULL
);

CREATE INDEX idx_otti_sessions_ts ON otti_sessions(ts_start);
CREATE INDEX idx_otti_sessions_user ON otti_sessions(user_id);
CREATE INDEX idx_otti_sessions_intent ON otti_sessions(intent);
CREATE INDEX idx_otti_sessions_persona ON otti_sessions(persona);
CREATE INDEX idx_otti_sessions_model ON otti_sessions(model);

CREATE TABLE otti_deployments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,             -- e.g. "Codemesh Integration"
  deploy_date TEXT NOT NULL,      -- ISO date (YYYY-MM-DD)
  created_at TEXT NOT NULL
);
```

### Ingest Script

**File:** `scripts/ingest-otti-sessions.ts`

- Reads all `*.jsonl` from configurable source path (default: `~/Documents/code/ottiassistant/data/transcripts/sessions/`)
- Walks date directories (`2026-04-15/`, etc.)
- For each JSONL file: reads first line for metadata (task_id, user_id, channel_id, persona, intent, model, agent_type, repo_name, ts), last line for ts_end, counts lines for num_events, computes duration_s
- Upserts by `id` (task_id) — idempotent, safe to re-run
- Run with: `npx tsx scripts/ingest-otti-sessions.ts [--source /path/to/sessions]`

## API Route

**`GET /api/otti/sessions?period=7d&compare=false&split_date=`**

### Parameters
- `period`: `7d` (default), `30d`, `90d`, `all`
- `compare`: `true` | `false` (default)
- `split_date`: ISO date string (required when compare=true)

### Response Shape (normal mode)

```json
{
  "period": "7d",
  "range": { "start": "2026-04-09", "end": "2026-04-16" },
  "prior": { "start": "2026-04-02", "end": "2026-04-09" },
  "kpis": {
    "conversations": { "value": 284, "prior": 212, "delta_pct": 34 },
    "unique_users": { "value": 21, "prior": 14, "delta_pct": 50 },
    "sessions_per_user": { "value": 3.2, "prior": 3.6, "delta_pct": -11 },
    "median_speed_s": { "value": 174, "prior": 190, "delta_pct": -8 },
    "p90_speed_s": { "value": 351, "prior": 480, "delta_pct": -27 },
    "p95_speed_s": { "value": 607, "prior": 676, "delta_pct": -10 }
  },
  "daily_volume": [
    { "date": "2026-04-09", "count": 44 },
    ...
  ],
  "intents": [
    { "name": "code_read", "count": 36, "pct": 53.7 },
    ...
  ],
  "personas": [...],
  "models": [...],
  "agent_types": [...],
  "hourly_heatmap": {
    "2026-04-15": [0, 0, 0, 0, 0, 0, 0, 3, 2, 0, 0, 4, 9, 6, 4, 7, 3, 5, 10, 2, 1, 2, 6, 3]
  },
  "speed_by_intent": [
    { "name": "code_read", "median": 230, "p90": 485, "delta_median_pct": -13 },
    ...
  ],
  "speed_by_model": [...],
  "speed_by_persona": [...],
  "speed_buckets": [
    { "label": "< 1m", "count": 5, "pct": 7.8 },
    ...
  ],
  "top_users": [
    { "user_id": "U03DRPJSAGL", "sessions": 9, "persona": "engineering", "top_intents": ["notion_lookup", "code_read"], "avg_duration_s": 180 },
    ...
  ],
  "single_event_count": 3,
  "single_event_pct": 4.5
}
```

### Response Shape (compare mode)

When `compare=true` and `split_date` is provided, every metric is returned as a `{ before, after, delta_pct }` structure instead of `{ value, prior, delta_pct }`. The `before` window is from period start to split_date, `after` is from split_date to period end.

### Deployments Sub-route

**`GET /api/otti/deployments`** — returns all saved deployments
**`POST /api/otti/deployments`** — creates a new deployment `{ name, deploy_date }`

## Page Layout

**Route:** `/otti`
**Nav label:** "Otti Assistant" (added to topbar navItems)
**File:** `src/app/otti/page.tsx` (server component) + `src/app/otti/otti-client.tsx` (client component for interactivity)

### Section 1: Header + Controls

- Title: "Otti Assistant" / subtitle: "Adoption & Performance"
- Period selector pills: 7d (default), 30d, 90d, All
- Compare toggle button — when active, shows:
  - Dropdown of saved deployments (from otti_deployments table)
  - Date picker for custom split date
  - "Save as deployment" option for new dates

### Section 2: Adoption

- **4 KPI cards** (reuse `StatCard`): Conversations, Unique Users, Sessions/User, Median Speed
  - Normal mode: value + delta vs prior period
  - Compare mode: before value / after value + delta between them
- **Daily volume bar chart**: bars for each day in period, colored by peak/normal/low
  - Compare mode: vertical line marking the split date

### Section 3: Usage Patterns

- **2x2 grid** of breakdown cards:
  - Intent breakdown — segmented bar + legend with counts/percentages
  - Persona breakdown — segmented bar + legend
  - Model distribution — segmented bar + legend
  - Agent routing — segmented bar + orchestrator hit rate %
- Compare mode: dual bars (before/after) stacked vertically in each card

### Section 4: Performance

- **3 KPI cards**: Median Speed, P90 Speed, P95 Speed (with deltas)
- **Speed by intent table**: columns = intent, median, P90, delta
  - Compare mode: adds before/after columns
- **Speed by model table**: same format
- **Speed by persona table**: same format
- **Speed buckets chart**: horizontal bars showing distribution across time brackets

### Section 5: Engagement Details

- **Top users table**: rank, user_id, session count, primary persona, top intents, avg duration
- **Hourly heatmap**: 24-column (hours) x N-row (days) grid, intensity = session count per cell
- **Single-event sessions**: count + percentage, flagged amber if > 5%

## Component Plan

### Reuse from Existing
- `StatCard` — all KPI cards
- `Card` / `CardContent` / `CardTitle` — chart containers
- Design tokens — g1-g9, accent-green, accent-red, rounded-card, bg-surface

### New Components
- `src/components/otti/period-selector.tsx` — pill buttons with active state
- `src/components/otti/breakdown-bar.tsx` — segmented bar + legend (used for intent, persona, model, agent)
- `src/components/otti/speed-table.tsx` — tabular speed metrics with pre/post columns
- `src/components/otti/hourly-heatmap.tsx` — 24x7 grid with color intensity
- `src/components/otti/compare-controls.tsx` — compare toggle + deployment dropdown + date picker
- `src/components/otti/volume-chart.tsx` — daily volume bar chart with optional split-date marker

## Design System Compliance

- Warm white theme (bg: #fafafa, cards: white, borders: black/[0.07])
- Font: Inter, sizes matching existing pages (0.67rem labels, 0.78rem body, 2rem hero numbers)
- Section headers: 0.67rem uppercase semibold tracking-wide
- Card radius: 14px (rounded-card)
- Green (#1a8754) for positive deltas, red (#c53030) for negative
- No dark mode
