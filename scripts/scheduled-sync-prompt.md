# WorkGraph Daily Sync

You are running the daily WorkGraph sync pipeline. Your job is to pull data from all connected sources, enrich items, and update the database.

Working directory: /Users/ottimate/Documents/Tracker/workgraph

## Step 1: Check sync status

Run: `bunx tsx scripts/sync-status.ts`

Note the last sync dates and current item counts.

## Step 2: Read sync config

Run: `bunx tsx -e "const Database = require('better-sqlite3'); const path = require('path'); const db = new Database(path.join(process.cwd(), '..', 'workgraph.db')); const row = db.prepare(\"SELECT config FROM sync_config WHERE id = 'default'\").get(); console.log(row.config);"`

This tells you which sources are enabled and which Jira projects to sync.

## Step 3: Pull data from sources (Phase 1 — parallel)

### Jira
Use `mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql` with:
- cloudId: `plateiq.atlassian.net`
- JQL: `project IN ("INT", PEX, OA) AND updated >= "<last_sync_date_or_2026-01-01>" AND (assignee in ("arunv@plateiq.com", "arun.venkataramanan@ottimate.com") OR reporter in ("arunv@plateiq.com", "arun.venkataramanan@ottimate.com") OR watcher in ("arunv@plateiq.com", "arun.venkataramanan@ottimate.com"))` 
- This ensures only tickets the user is involved in are synced (assigned, reported, or watching)
- Get up to 100 results
- Extract the issues array from the response
- Write to /tmp/jira-issues.json
- Run: `cat /tmp/jira-issues.json | bunx tsx scripts/sync-jira.ts`

### Slack
Use `mcp__plugin_slack_slack__slack_search_public_and_private` with:
- query: `from:me after:<last_sync_date_or_2026-01-01>`
- Get messages from the user's channels
- Format as JSON array with fields: channel, channel_id, ts, text, user_name, user, channel_name, permalink
- Write to /tmp/slack-messages.json
- Run: `cat /tmp/slack-messages.json | bunx tsx scripts/sync-slack.ts`

### Meetings
Use `mcp__claude_ai_Granola__list_meetings` with:
- time_range: custom, from last sync date to today
- Format as JSON array with: id, title, date, participants, summary, url
- Write to /tmp/granola-meetings.json
- Run: `cat /tmp/granola-meetings.json | bunx tsx scripts/sync-meetings.ts`

### GitHub
Run directly (uses `gh` CLI, already authenticated):
```
bunx tsx scripts/sync-github.ts --since=<last_sync_date_or_2026-01-01>
```
This pulls PRs (authored + reviewed) and commits from plateiq repos for user `alwynchimp`.

## Step 4: Pull enrichment sources (Phase 2)

### Notion
Use `mcp__claude_ai_Notion__notion-search` with:
- query: engineering product roadmap (or relevant terms)
- Get pages created since last sync
- Format as JSON array
- Run: `cat /tmp/notion-pages.json | bunx tsx scripts/sync-notion.ts`

### Gmail
Use `mcp__claude_ai_Gmail__search_threads` with:
- query: `after:<last_sync_date_or_2026/01/01>`
- Format as JSON array
- Run: `cat /tmp/gmail-threads.json | bunx tsx scripts/sync-gmail.ts`

## Step 5: Enrich un-enriched items

Run: `bunx tsx scripts/list-unenriched.ts --limit=50`

For each un-enriched item, generate a JSON object with:
- item_id: the item's ID
- summary: 1-2 sentence summary
- item_type: one of decision, action-item, blocker, update, question, spec, discussion, meeting-note, bug, feature
- topics: 2-5 topic tags (lowercase, hyphenated)
- entities: people, teams, Jira keys, channels
- goals: goal IDs that apply (from the goals list in the output)

Collect all enrichments into a JSON array and pipe to:
`echo '<json>' | bunx tsx scripts/store-enrichment.ts`

## Step 6: Process

Run: `bunx tsx scripts/process.ts`

This creates cross-references and computes metrics.

## Step 7: Report

Run: `bunx tsx scripts/sync-status.ts`

Report the final counts and any errors encountered.
