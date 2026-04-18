#!/bin/bash
# WorkGraph Daily Sync — runs Claude Code CLI with the sync prompt
# Scheduled via macOS launchd to run daily at 9 AM

set -e

WORKDIR="/Users/ottimate/Documents/Tracker/workgraph"
PROMPT_FILE="$WORKDIR/scripts/scheduled-sync-prompt.md"
LOG_DIR="$WORKDIR/logs"
LOG_FILE="$LOG_DIR/sync-$(date +%Y-%m-%d).log"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

echo "=== WorkGraph Sync: $(date) ===" >> "$LOG_FILE"

cd "$WORKDIR"

# Run Claude Code with the sync prompt, non-interactively
/Users/ottimate/.local/bin/claude -p "$(cat $PROMPT_FILE)" \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql,mcp__claude_ai_Atlassian__getJiraIssue,mcp__plugin_slack_slack__slack_search_public_and_private,mcp__plugin_slack_slack__slack_read_channel,mcp__claude_ai_Granola__list_meetings,mcp__claude_ai_Granola__get_meeting_transcript,mcp__claude_ai_Notion__notion-search,mcp__claude_ai_Notion__notion-fetch,mcp__claude_ai_Gmail__search_threads,mcp__claude_ai_Gmail__get_thread" \
  >> "$LOG_FILE" 2>&1

echo "=== Sync complete: $(date) ===" >> "$LOG_FILE"
