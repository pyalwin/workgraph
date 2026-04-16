# WorkGraph Data Sync Pipeline Design

## Overview

A scheduled data sync pipeline that pulls work items from five sources (Jira, Slack, Meetings, Notion, Gmail) into the WorkGraph SQLite database. Runs as a Claude Code scheduled agent once daily, using MCP tools for authentication and data access. All items are cross-referenced, classified to strategic goals, and versioned on change.

## Architecture

### Pipeline Phases

```
Phase 1 — Anchors (parallel)
├── jira-sync      → Issues from Integrations, PEX, OA projects
├── slack-sync     → Messages from all user channels
└── meetings-sync  → Meetings from Granola + data/meetings.json

Phase 2 — Enrichment (after Phase 1)
├── notion-sync    → Pages, matched against known Jira keys & topics
└── gmail-sync     → Threads, matched against known Jira keys & topics

Phase 3 — Processing (after Phase 2)
├── classify       → Tag items to strategic goals (existing classify.ts)
├── cross-reference → Link items across sources (existing crossref.ts)
└── metrics        → Compute goal snapshots (existing metrics.ts)
```

### Execution Model

- **Runtime**: Claude Code scheduled agent (daily, morning)
- **Auth**: MCP tool connections (no API keys to manage)
- **Initial sync**: YTD from Jan 1, 2026
- **Incremental sync**: Uses `sync_log.completed_at` per source as watermark, pulls only items created/updated since last successful sync

## Data Sources

### Jira (Phase 1)

- **MCP tools**: `mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql`, `mcp__claude_ai_Atlassian__getJiraIssue`
- **Scope**: Projects — Integrations, PEX, OA
- **Query**: `project IN (Integrations, PEX, OA) AND updated >= "2026-01-01"`
- **Incremental**: `updated >= <last_sync_date>`
- **Mapping**:
  - `source`: `"jira"`
  - `source_id`: issue key (e.g., `PEX-123`)
  - `item_type`: issue type (epic, story, bug, task)
  - `title`: summary
  - `body`: description
  - `author`: assignee
  - `status`: issue status
  - `priority`: priority field
  - `url`: issue URL
  - `metadata`: JSON with labels, sprint, components, reporter, created/updated dates

### Slack (Phase 1)

- **MCP tools**: `mcp__plugin_slack_slack__slack_search_public_and_private`, `mcp__plugin_slack_slack__slack_read_channel`
- **Scope**: All channels user is part of
- **Query**: Messages since Jan 1, 2026
- **Mapping**:
  - `source`: `"slack"`
  - `source_id`: `<channel_id>:<message_ts>`
  - `item_type`: `"message"` or `"thread"`
  - `title`: first 120 chars of text or thread topic
  - `body`: full message text
  - `author`: sender display name
  - `status`: `"posted"`
  - `url`: message permalink
  - `metadata`: JSON with channel name, thread_ts, reaction count, reply count

### Meetings (Phase 1)

- **MCP tools**: `mcp__claude_ai_Granola__list_meetings`, `mcp__claude_ai_Granola__get_meeting_transcript`
- **Scope**: All meetings since Jan 1, 2026
- **Additional**: Ingest `data/meetings.json` on first run (deduplicate by title + date)
- **Mapping**:
  - `source`: `"meeting"`
  - `source_id`: meeting ID (UUID)
  - `title`: meeting title
  - `body`: transcript or notes (summary when available)
  - `author`: organizer or first participant
  - `status`: `"completed"`
  - `url`: meeting URL (if available)
  - `metadata`: JSON with participants, duration, date, folder

### Notion (Phase 2)

- **MCP tools**: `mcp__claude_ai_Notion__notion-search`, `mcp__claude_ai_Notion__notion-fetch`
- **Scope**: Pages and databases related to work (matched against Jira keys and topics from Phase 1)
- **Mapping**:
  - `source`: `"notion"`
  - `source_id`: page ID
  - `title`: page title
  - `body`: content snippet (first 500 chars)
  - `author`: last edited by
  - `status`: `"published"`
  - `url`: page URL
  - `metadata`: JSON with parent database, last edited time, tags/properties

### Gmail (Phase 2)

- **MCP tools**: `mcp__claude_ai_Gmail__search_threads`, `mcp__claude_ai_Gmail__get_thread`
- **Scope**: Threads user is part of since Jan 1, 2026
- **Mapping**:
  - `source`: `"gmail"`
  - `source_id`: thread ID
  - `title`: subject line
  - `body`: snippet or latest message body
  - `author`: sender of first message
  - `status`: `"received"` or `"sent"`
  - `url`: Gmail thread URL
  - `metadata`: JSON with participants, label IDs, message count, date

## Versioning on Conflict

### Schema

```sql
CREATE TABLE work_item_versions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_items(id),
  changed_fields TEXT NOT NULL,  -- JSON: {"status": {"old": "In Progress", "new": "Done"}}
  snapshot TEXT NOT NULL,         -- JSON: full previous state of the work_item row
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_versions_item ON work_item_versions(item_id);
CREATE INDEX idx_versions_changed ON work_item_versions(changed_at);
```

### Upsert Logic

1. Look up existing row by `(source, source_id)`
2. If exists:
   a. Compare incoming fields against stored fields
   b. If any differ → insert `work_item_versions` row with diff and full previous snapshot
   c. Update `work_items` row with new values, set `synced_at = now()`
3. If no changes → touch `synced_at` only
4. If new → insert into `work_items`

## Adapter Interface

```typescript
interface SyncAdapter {
  source: string;
  sync(since: string): Promise<SyncResult>;
}

interface SyncResult {
  itemsSynced: number;
  itemsUpdated: number;
  itemsSkipped: number;
  errors: string[];
}
```

Each adapter:
- Implements `SyncAdapter`
- Uses MCP tools to fetch data
- Maps source-specific fields to `work_items` schema
- Handles pagination internally
- Returns a `SyncResult` summary

## Orchestrator

**File**: `src/lib/sync/orchestrator.ts`

Responsibilities:
- Determine watermark per source from `sync_log`
- Phase 1: Run jira, slack, meetings adapters in parallel
- Phase 2: Run notion, gmail adapters (can use Jira keys from Phase 1 for cross-matching)
- Phase 3: Run `reclassifyAll()`, `createLinksForAll()`, `computeAllMetrics()`
- Log each adapter run to `sync_log` with status, counts, and errors

### Error Handling

- Each adapter is independent — failure in one does not block others
- Failed adapters: logged to `sync_log` with `status: 'error'` and error message
- Next run retries from last *successful* watermark for that source
- Phase 2 runs even if some Phase 1 adapters fail (uses whatever anchors are available)
- Phase 3 always runs (processes whatever data exists)

## File Structure

```
src/lib/sync/
├── orchestrator.ts       -- pipeline coordinator
├── versioning.ts         -- diff, snapshot, upsert logic
├── adapters/
│   ├── types.ts          -- SyncAdapter, SyncResult interfaces
│   ├── jira.ts           -- Jira adapter
│   ├── slack.ts          -- Slack adapter
│   ├── meetings.ts       -- Granola + meetings.json adapter
│   ├── notion.ts         -- Notion adapter
│   └── gmail.ts          -- Gmail adapter
```

## Schema Changes

Add to existing `src/lib/schema.ts`:
- `work_item_versions` table (versioning)
- Index on `work_item_versions(item_id)` and `work_item_versions(changed_at)`

No changes to existing tables — the `work_items`, `sync_log`, and other tables already support this design.

## Scheduled Agent

- **Tool**: Claude Code `/schedule` command
- **Frequency**: Once daily (morning)
- **Agent prompt**: Execute the sync pipeline — run Phase 1, Phase 2, Phase 3 in order, report results
- **Output**: Summary of items synced/updated/skipped per source, any errors
