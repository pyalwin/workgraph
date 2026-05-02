/**
 * GitHub trails Inngest functions.
 *
 *   - githubTrailsRefreshWorkspace: per-workspace sync of PR trails
 *   - issuePrSummaryRefresh: per-ticket AI summary + decisions + anomalies
 *   - unmatchedPrAiMatcher: weekly cron, attaches unmatched PRs by similarity
 */
import { inngest } from '../client';
import { runGithubTrailsSync } from '@/lib/sync/github-trails';
import { generateIssuePrSummary } from '@/lib/sync/issue-pr-summary';
import { runUnmatchedPrMatcher } from '@/lib/sync/unmatched-pr-matcher';
import { enrichOrphanPrIntents } from '@/lib/sync/orphan-pr-enrich';
import { getLibsqlDb } from '@/lib/db/libsql';

export const githubTrailsRefreshWorkspace = inngest.createFunction(
  {
    id: 'github-trails-refresh-workspace',
    name: 'GitHub · refresh PR trails for one workspace',
    triggers: [{ event: 'workgraph/github.trails.refresh' }],
    concurrency: {
      key: 'event.data.workspaceId + "::" + event.data.slot',
      limit: 1,
    },
    retries: 2,
  },
  async ({ event, step }) => {
    const data = event.data as {
      workspaceId: string;
      slot: string;
      since?: string | null;
    };
    const workspaceId = data.workspaceId;
    const slot = data.slot;
    const since = data.since ?? null;

    // 1. Run the full pipeline. runGithubTrailsSync owns markSyncStarted/Finished
    //    and try/catch so a worker death leaves the row at status=error rather
    //    than running forever (matches the runConnectorSync pattern).
    const result = await step.run('run-trails-sync', async () => {
      return runGithubTrailsSync(workspaceId, slot, { since });
    });

    if (!result.ok) {
      console.warn(
        `[github-trails] ${workspaceId}/${slot} completed with ${result.errors.length} error(s):`,
        result.errors.slice(0, 5),
      );
    }

    // 2. Fan out per-ticket summary refresh for any Jira issue whose trail
    //    moved this run. The summary function is concurrency-keyed on issue
    //    id, so back-to-back trail updates collapse cleanly.
    if (result.movedIssueIds.length > 0) {
      await step.sendEvent(
        'fan-out-issue-pr-summary',
        result.movedIssueIds.map((issueItemId) => ({
          name: 'workgraph/issue.pr-summary.refresh',
          data: { issueItemId, workspaceId },
        })),
      );
    }

    return {
      workspaceId,
      slot,
      ...result,
    };
  },
);

// ─── issue.pr-summary.refresh — per-ticket AI summary ─────────────────────

export const issuePrSummaryRefresh = inngest.createFunction(
  {
    id: 'issue-pr-summary-refresh',
    name: 'Issue · refresh PR delivery summary + decisions + anomalies',
    triggers: [{ event: 'workgraph/issue.pr-summary.refresh' }],
    concurrency: { key: 'event.data.issueItemId', limit: 1 },
    retries: 1,
  },
  async ({ event, step }) => {
    const data = event.data as { issueItemId: string; workspaceId: string };
    const result = await step.run('generate', async () => {
      return generateIssuePrSummary(data.workspaceId, data.issueItemId);
    });
    if (!result.ok) {
      console.warn(`[issue-pr-summary] ${data.issueItemId}: ${result.reason}`);
    }
    return result;
  },
);

// ─── github.trails.match-unmatched — weekly AI matcher ────────────────────
//
// Tries to attach unmatched PR trail rows (no Jira key in title/branch/body)
// to a likely Jira ticket via embedding similarity + structural signals.
// Runs Monday 04:00 — before the anomaly scan (06:00) so newly-promoted
// items get fresh anomaly evaluation in the same cycle.

export const unmatchedPrAiMatcher = inngest.createFunction(
  {
    id: 'unmatched-pr-ai-matcher',
    name: 'GitHub · attach unmatched PRs by AI similarity',
    triggers: [
      { cron: '0 4 * * 1' },
      { event: 'workgraph/github.trails.match-unmatched' },
    ],
    retries: 1,
  },
  async ({ step }) => {
    // Step 1: enrich orphan PRs with a plain-English functional_summary
    // derived from their diff. Without this the matcher's query text is
    // just title+body, which is sparse for most orphans. Bounded — only
    // touches PRs that have diff_text and lack functional_summary.
    const enriched = await step.run('enrich-orphan-intents', () =>
      enrichOrphanPrIntents({ limit: 100, concurrency: 4 }),
    );

    // Step 2: run the matcher with the now-enriched query text.
    const result = await step.run('run-matcher', async () => runUnmatchedPrMatcher());

    // Fan out per-ticket summary refresh for newly-matched tickets so the
    // delivery narrative + decisions + anomalies pick up the AI-attached PRs.
    if (result.movedIssueIds.length > 0) {
      // Look up workspace_ids for these tickets — anomaly persistence needs
      // the workspace id and an item can technically belong to multiple
      // workspaces in the future. For now, take the first workspace from
      // workspace_user_aliases as the canonical owner.
      const workspaceIds = await step.run('resolve-workspace-ids', async () => {
        const db = getLibsqlDb();
        const row = await db
          .prepare(`SELECT DISTINCT workspace_id FROM workspace_user_aliases LIMIT 1`)
          .get<{ workspace_id: string }>();
        return row?.workspace_id ?? null;
      });
      if (workspaceIds) {
        await step.sendEvent(
          'fan-out-summary-after-ai-match',
          result.movedIssueIds.map((issueItemId) => ({
            name: 'workgraph/issue.pr-summary.refresh',
            data: { issueItemId, workspaceId: workspaceIds },
          })),
        );
      }
    }

    return { enriched, ...result };
  },
);
