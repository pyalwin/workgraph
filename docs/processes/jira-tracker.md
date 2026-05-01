# JIRA Tracker — Process Specification

> Living document. The scheduled tracker reads this contract to know what to
> do and how often. Future iterations will expose this as an editable Settings
> panel so users can tune weights, schedules, prompts, and thresholds without
> shipping code.

## What this process does

For each JIRA project a user wants to track, WorkGraph runs a recurring
pipeline that:

1. Pulls all relevant issues into local SQLite
2. Enriches every issue into a graph-quality node (AI summary + characteristic metadata)
3. Synthesizes a project-level health view (summary + dashboard metrics)
4. Extracts action items, measurable goals, and per-user trackers
5. Flags anomalies — stale work, scope creep, priority inversions, missed deadlines

Everything is local-first. The AI calls go to whichever provider is configured
in Settings → AI (OpenRouter by default). Source data goes only to the JIRA
host the user authenticated with.

---

## Phase 0 — Setup (one-time, per workspace)

**User journey**

1. Settings → Connectors → Jira → "Connect"
2. OAuth handshake with Atlassian
3. Project picker shows every accessible project (paginated through `getVisibleJiraProjects`, capped at 2,000)
4. User selects N projects
5. Workspace records:
   - Selected project keys
   - Sync cadence per project (default: daily incremental, weekly full re-summary)
   - Backfill horizon (default: 2026-01-01)
   - User scope: just my issues, my team, or everyone (default: my issues — `assignee/reporter/watcher = me`)

**Stored where:** `workspace_connector_configs.config` (already encrypted-at-rest via `WORKGRAPH_SECRET_KEY`).

---

## Phase 1 — Sync orchestration

**Default cadence per project**

| Frequency | Job | Purpose |
|---|---|---|
| On connect | Full backfill | One-time pull of everything since horizon |
| Every 30 min | Incremental sync | `updated >= last_synced_for_project` |
| Daily 06:00 local | Re-enrich + re-summarize changed | AI work for items modified since last enrichment |
| Weekly Monday 06:00 | Project re-summary | Refresh dashboard metrics + AI project summary |
| Weekly Monday 06:00 | Anomaly scan | Stale / drifting / blocked detection |

When the user has selected **>1 project**, each project gets its own
independent schedule. They run in parallel — no cross-project blocking,
no global serialization.

**Background runtime — recommendation**

Vercel + Temporal: Temporal Cloud handles the workflows, but the **Workers**
that execute activity code need a long-lived process and don't fit in
Vercel's serverless model. Two viable shapes:

- **Temporal Cloud + Workers on a separate host** (Fly.io, Render, Railway, or a self-hosted box). The Vercel-hosted app starts workflows; workers run elsewhere. Highest fidelity, biggest ops surface.
- **Inngest or Trigger.dev** — built specifically for serverless backgrounds. Both have first-class Vercel integrations, durable execution, retries, schedules, and concurrency controls. Lower ceiling than Temporal but vastly less infra.

**Decision:** start with Inngest or Trigger.dev. Migrate to Temporal only if
we hit real workflow-orchestration limits (long-running multi-day workflows,
versioned signal handlers, etc.) — unlikely for this use case.

**Idempotency rules**

- Each scheduled run is keyed by `(workspace_id, project_key, run_kind, run_at)`. Re-running is a no-op if the key already completed.
- Item upserts use `(source, source_id)` UNIQUE — re-syncs overwrite, never duplicate.
- AI enrichment is gated on `enriched_at < updated_at` (only re-enrich if the issue actually changed).

---

## Phase 2 — Issue ingestion

For every issue pulled, we produce one `work_items` row plus a few derived rows.

**Core normalization** (existing — `connectors/adapters/atlassian.ts`):

```
source         'jira'
source_id      issue key (PEX-123)
item_type      issuetype lowercased (task / story / epic / bug / sub-task)
title          fields.summary
body           description + comments  (concatenated for embedding)
author         assignee or reporter
status         normalized → done / active / open / backlog
priority       priority.name lowercased
url            <base>/browse/<key>
created_at     fields.created
updated_at     fields.updated
```

**Metadata entities — new, written into `metadata` JSON**

These are the "graph-qualifying" properties that turn a raw issue into a
queryable node.

| Key | Source | Purpose |
|---|---|---|
| `source` | `'jira'` | Source-kind discriminator for crossref weights |
| `entity_key` | project key (e.g. `PEX`) | Anchors issue to its project hub |
| `status_bucket` | normalized status | Used by dashboards |
| `period.year`, `period.month`, `period.day` | from `created_at` and `updated_at` | Enables time-window filters without recomputing per query |
| `assigned_to_me` | bool | Quick filter for the "my work" tracker |
| `is_mine` | bool — assignee OR reporter OR watcher == auth user | Used by per-user views |
| `team` | from project metadata or assignee group | Optional grouping |
| `epic_key`, `parent_key` | parent.key | For hierarchy traversal |
| `sprint_name`, `sprint_state` | active/closed | For "in-flight this sprint" queries |
| `comment_count` | int | Cheap activity signal |
| `last_commented_at` | latest comment timestamp | Anomaly detection input |
| `labels[]`, `components[]` | passthrough | Topic clustering |
| `resolution` | resolution.name | "Done" vs "Won't Do" disambiguation |

**Derived items** (existing pattern — keep):

- `project:<KEY>` — project hub node, one per project
- Parent placeholder if the parent is outside the sync window

**Pre-computed deterministic links** (existing):

- `<issue> → in_project → project:<KEY>`
- `<issue> → child_of → <parent_key>`
- `<parent_key> → in_project → project:<KEY>`

---

## Phase 3 — AI enrichment per issue

For every changed issue (gated by `enriched_at < updated_at`), Claude/OpenRouter
produces:

**1. Concise summary** (1–2 sentences) — what the ticket is about, what's
happening on it now. Stored on `work_items.summary`.

**2. Characteristic metadata entities** — pulled into the `entities` +
`entity_mentions` tables so they participate in the graph. Includes:

- `theme` — the high-level topic ("billing rewrite", "auth flow", "v2 schema")
- `capability` — the product capability touched ("invoice approval", "sso")
- `system` — the technical surface ("api-gateway", "ingest-worker")
- `decision` — when present, the decided/asked-but-not-shipped axis
- `risk` — flagged blocker/dependency/regulatory concern
- `effort_signal` — explicit estimate or implicit "this is going to take a while" cue

**3. Action items** — extracted as discrete strings linked back to the issue.
Each has:

- `text`
- `assignee` (best-effort from comment authors / mentions)
- `due_at` (best-effort from text)
- `ai_priority` ∈ {p0, p1, p2, p3}

Stored in a new `action_items` table (Phase 5).

**Output contract** — single JSON object:

```json
{
  "summary": "string — 1 to 2 sentences",
  "entities": [
    { "type": "theme|capability|system|decision|risk", "canonical_form": "string", "surface_form": "string" }
  ],
  "action_items": [
    { "text": "string", "assignee": "string|null", "due_at": "ISO|null", "ai_priority": "p0|p1|p2|p3" }
  ],
  "anomaly_signals": [
    { "kind": "stale|churning|scope_creep|priority_inversion|deadline_risk", "severity": 0..1, "evidence": "string" }
  ]
}
```

---

## Phase 4 — Project synthesis

Once a week (or on-demand from the project page), we produce a project-level
view. Two artifacts:

**A. AI project summary** — extends existing `project_summaries.recap`.
Replaces the Haiku 2-3 sentence recap with a richer Sonnet-grade narrative
that answers:

- What's the current state? (in plain prose)
- What shipped this period?
- What's actively being worked on?
- What's stuck or at risk?
- What decisions are open?

Stored on `project_summaries.summary` (markdown, ≤300 words).

**B. Dashboard metrics** — pre-computed and cached so the project page is
instant. Stored as JSON on `project_summaries.metrics`:

| Metric | Computation |
|---|---|
| Throughput | Tickets done in last 7 / 30 / 90 days |
| Cycle time (p50, p90) | `(done_at - in_progress_at)` per ticket |
| WIP | Currently active items |
| Stale-rate | items with `updated_at` > 14 days, % of total open |
| Blocker count | items tagged with `risk` entity of kind `blocker` |
| Sprint commitment vs. delivered | for the current sprint |
| Top contributors | top N assignees by done-count |
| Top topics | top entity themes by item count |
| Decision velocity | # decisions extracted per week |

These are computable from `work_items` + `entity_mentions` — no new tables
required, just queries.

---

## Phase 5 — Action items

**Data model** (new table):

```sql
CREATE TABLE action_items (
  id TEXT PRIMARY KEY,
  source_item_id TEXT REFERENCES work_items(id),
  text TEXT NOT NULL,
  assignee TEXT,
  due_at TEXT,
  user_priority TEXT,                  -- 'p0'..'p3' set by user, nullable
  ai_priority TEXT,                    -- 'p0'..'p3' set by AI, derived
  state TEXT NOT NULL DEFAULT 'open',  -- open / done / dismissed
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

**Priority resolution** — when both are set, `user_priority` wins. UI shows
both side-by-side so the user can see when the AI disagrees.

**AI priority signal sources:**

- Severity from anomaly signals on the parent issue
- Mentions of customer impact / SLA / outage in the issue body
- Sprint context (in-sprint > backlog)
- Project-level priority from dashboard metrics
- Explicit priority field on the JIRA issue

---

## Phase 6 — Measurable goals & deliverables

For each project, AI identifies a small set of **trackable goals** by reading
the project summary, recent decisions, and active issues. Each goal:

- Is concrete and measurable (number to hit, deadline, or completion criterion)
- Anchors to specific work items as evidence
- Has owners (best-effort from assignees / reporters / mentioned actors)
- Has a confidence score (how certain is the AI this is actually a goal vs. noise)

**Data model** — extends the existing `goals` table with:

```sql
ALTER TABLE goals ADD COLUMN owner_user_id TEXT;
ALTER TABLE goals ADD COLUMN target_metric TEXT;     -- e.g. 'pct_done', 'item_count'
ALTER TABLE goals ADD COLUMN target_value REAL;
ALTER TABLE goals ADD COLUMN target_at TEXT;          -- deadline ISO
ALTER TABLE goals ADD COLUMN ai_confidence REAL;
ALTER TABLE goals ADD COLUMN derived_from TEXT;      -- 'manual' | 'ai_project_summary'
```

User can edit / delete / promote AI-suggested goals. Edited goals get
`derived_from = 'manual'` and are no longer overwritten.

---

## Phase 7 — Per-user tracker

For the logged-in user, generated daily:

**1. Their open work** — issues where `is_mine = true`, ordered by `ai_priority`.

**2. Their goals** — goals where `owner_user_id = user.id`, with current
progress vs. target.

**3. Their action items** — open action items where `assignee` matches
(fuzzy-matched to their AuthKit profile email/name).

**4. AI-generated tracker narrative** — short prose digest:

> "This week, you have 3 open p0 items in Integrations. ACME-247 has been
> idle for 12 days — it's blocking the v2 schema goal which is due in 8 days.
> You shipped 4 issues last week, +1 vs your trailing 4-week average."

**Where it lives:** the `/dashboard` route. Replaces the current generic
overview when the user is signed in.

---

## Phase 8 — Anomaly detection

Run weekly per project. Detects:

| Anomaly | Heuristic |
|---|---|
| Stale | `status = active` AND `updated_at` > 14 days |
| Churning | comment count > 8, no status change in 7+ days |
| Scope creep | issue body grew > 2× since first sync, status still `active` |
| Priority inversion | low-priority issue blocking high-priority issue (via `links`) |
| Deadline risk | sprint end < 7 days, > 50% of sprint items still active |
| Owner gap | active issue with no assignee for > 3 days |
| Goal drift | goal `target_at` < 30 days, < 50% of contributing items done |

Each anomaly is written to a `anomalies` table with severity (0..1),
evidence (the items that triggered it), and a one-sentence AI explanation.
Surfaced in the user tracker (Phase 7) and on the project dashboard.

```sql
CREATE TABLE anomalies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL,              -- 'project:PEX' or 'item:PEX-123'
  kind TEXT NOT NULL,
  severity REAL NOT NULL,
  evidence_item_ids TEXT NOT NULL,  -- JSON array
  explanation TEXT,
  detected_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,                 -- nullable; set when no longer triggered
  dismissed_by_user INTEGER DEFAULT 0
);
```

Anomalies expire if their trigger condition no longer holds on the next
weekly run (`resolved_at` is set automatically).

---

## Phase 9 — Process tweaking

This document is the contract. Future iterations will expose a Settings
panel that lets the user edit, per workspace:

- **Schedules** — cadences for sync, re-enrichment, project re-summary, anomaly scan
- **Backfill horizon** — how far back to pull
- **User scope** — my work / my team / everyone
- **AI prompt overrides** — for summary, action items, goals (advanced; copy-paste prompt strings)
- **Anomaly thresholds** — stale-day cutoff, churn comment cutoff, scope-creep ratio
- **Dashboard metrics** — pick which metrics show on the project page
- **Goal target metrics** — define what "done" means for a goal type

The settings are stored in `workspace_connector_configs.config` so they
travel with the workspace. Migrations between schema versions live in
`src/lib/connectors/migrations/`.

---

## Open questions

1. **Background runtime** — Inngest vs Trigger.dev vs Temporal Cloud. Lean toward Inngest for first iteration, but worth a 30-minute spike on each.
2. **AI cost ceiling** — full re-enrichment of a project with 5,000 issues is non-trivial. Need a per-workspace daily token budget knob.
3. **User identity matching** — assignee names from JIRA are display names; AuthKit gives email. We need a deterministic mapping (per-workspace alias table) so per-user views actually work.
4. **Anomaly fatigue** — 7 detection kinds across N projects can produce a lot of noise. Need a "snooze for 7 days" affordance and per-kind enable/disable.
5. **Webhooks** — JIRA webhooks would let us drop the 30-min poll for a near-realtime path. Adds infra (incoming webhook endpoint + signature verification) — defer to v2.
