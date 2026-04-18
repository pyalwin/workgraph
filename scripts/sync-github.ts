/**
 * GitHub sync adapter — pulls PRs and commits where the user is author or reviewer.
 * Uses `gh` CLI (must be authenticated).
 *
 * Usage: bunx tsx scripts/sync-github.ts [--repos=plateiq/server,plateiq/datadash] [--since=2026-01-01]
 */
import { ingestItems } from '../src/lib/sync/ingest';
import type { WorkItemInput } from '../src/lib/sync/types';
import { execSync } from 'child_process';

const DEFAULT_REPOS = ['plateiq/server', 'plateiq/datadash', 'plateiq/fastfood', 'plateiq/periscope', 'plateiq/reports', 'plateiq/data', 'plateiq/atlas', 'plateiq/spices'];
const GITHUB_USER = 'alwynchimp';

function gh(args: string): string {
  try {
    return execSync(`gh ${args}`, { encoding: 'utf-8', timeout: 30000 });
  } catch (err: any) {
    console.error(`  gh error: ${err.message?.slice(0, 100)}`);
    return '[]';
  }
}

function fetchPRs(repo: string, since: string): WorkItemInput[] {
  console.log(`  PRs from ${repo}...`);

  // PRs authored by user
  const authoredRaw = gh(`pr list --repo ${repo} --author ${GITHUB_USER} --state all --json number,title,body,state,createdAt,updatedAt,url,headRefName,reviews,labels,additions,deletions,mergedAt --limit 50`);
  const authored = JSON.parse(authoredRaw || '[]');

  // PRs where user is reviewer
  const reviewedRaw = gh(`api repos/${repo}/pulls?state=all\\&per_page=50 --jq '[.[] | select(.requested_reviewers[]?.login == "${GITHUB_USER}" or .user.login != "${GITHUB_USER}")]'`);
  // Fallback: search for PRs reviewed by user
  const reviewSearchRaw = gh(`api "search/issues?q=repo:${repo}+is:pr+reviewed-by:${GITHUB_USER}+created:>=${since}&per_page=50" --jq '.items'`);
  const reviewed = JSON.parse(reviewSearchRaw || '[]');

  const items: WorkItemInput[] = [];
  const seenPRs = new Set<string>();

  // Process authored PRs
  for (const pr of authored) {
    const key = `${repo}#${pr.number}`;
    if (seenPRs.has(key)) continue;
    seenPRs.add(key);

    // Extract Jira key from branch name or title
    const jiraKeyMatch = (pr.headRefName || pr.title || '').match(/([A-Z][A-Z0-9]+-\d+)/);

    items.push({
      source: 'github',
      source_id: key,
      item_type: 'pull_request',
      title: `PR #${pr.number}: ${pr.title}`,
      body: pr.body || null,
      author: GITHUB_USER,
      status: pr.state === 'MERGED' || pr.mergedAt ? 'merged' : pr.state?.toLowerCase() || 'open',
      priority: null,
      url: pr.url || `https://github.com/${repo}/pull/${pr.number}`,
      metadata: {
        repo,
        pr_number: pr.number,
        branch: pr.headRefName || null,
        jira_key: jiraKeyMatch?.[1] || null,
        labels: pr.labels?.map((l: any) => l.name) || [],
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        role: 'author',
      },
      created_at: pr.createdAt || new Date().toISOString(),
      updated_at: pr.updatedAt || pr.mergedAt || null,
    });
  }

  // Process reviewed PRs
  for (const pr of reviewed) {
    const number = pr.number || pr.pull_request?.url?.split('/').pop();
    const key = `${repo}#${number}`;
    if (seenPRs.has(key)) continue;
    seenPRs.add(key);

    const jiraKeyMatch = (pr.title || '').match(/([A-Z][A-Z0-9]+-\d+)/);

    items.push({
      source: 'github',
      source_id: key,
      item_type: 'pr_review',
      title: `Review: ${pr.title}`,
      body: pr.body || null,
      author: pr.user?.login || null,
      status: pr.state === 'closed' ? (pr.pull_request?.merged_at ? 'merged' : 'closed') : 'open',
      priority: null,
      url: pr.html_url || pr.url || `https://github.com/${repo}/pull/${number}`,
      metadata: {
        repo,
        pr_number: number,
        jira_key: jiraKeyMatch?.[1] || null,
        pr_author: pr.user?.login || null,
        role: 'reviewer',
      },
      created_at: pr.created_at || new Date().toISOString(),
      updated_at: pr.updated_at || null,
    });
  }

  return items;
}

function fetchCommits(repo: string, since: string): WorkItemInput[] {
  console.log(`  Commits from ${repo}...`);

  const raw = gh(`api "repos/${repo}/commits?author=${GITHUB_USER}&since=${since}T00:00:00Z&per_page=50" --jq '[.[] | {sha: .sha, message: .commit.message, date: .commit.author.date, url: .html_url, author: .commit.author.name}]'`);
  const commits = JSON.parse(raw || '[]');

  return commits.map((c: any) => {
    const jiraKeyMatch = (c.message || '').match(/([A-Z][A-Z0-9]+-\d+)/);
    const firstLine = (c.message || '').split('\n')[0];

    return {
      source: 'github',
      source_id: `${repo}@${c.sha?.slice(0, 7)}`,
      item_type: 'commit',
      title: `${repo.split('/')[1]}: ${firstLine.slice(0, 120)}`,
      body: c.message || null,
      author: c.author || GITHUB_USER,
      status: 'committed',
      priority: null,
      url: c.url || `https://github.com/${repo}/commit/${c.sha}`,
      metadata: {
        repo,
        sha: c.sha,
        jira_key: jiraKeyMatch?.[1] || null,
      },
      created_at: c.date || new Date().toISOString(),
      updated_at: null,
    } as WorkItemInput;
  });
}

async function main() {
  const reposArg = process.argv.find(a => a.startsWith('--repos='));
  const sinceArg = process.argv.find(a => a.startsWith('--since='));

  const repos = reposArg ? reposArg.split('=')[1].split(',') : DEFAULT_REPOS;
  const since = sinceArg ? sinceArg.split('=')[1] : '2026-01-01';

  console.log(`GitHub sync: ${repos.length} repos, since ${since}, user ${GITHUB_USER}`);

  const allItems: WorkItemInput[] = [];

  for (const repo of repos) {
    const prs = fetchPRs(repo, since);
    const commits = fetchCommits(repo, since);
    allItems.push(...prs, ...commits);
    console.log(`  ${repo}: ${prs.length} PRs, ${commits.length} commits`);
  }

  if (allItems.length === 0) {
    console.log(JSON.stringify({ source: 'github', itemsSynced: 0, itemsUpdated: 0, itemsSkipped: 0, errors: [] }));
    return;
  }

  const result = ingestItems(allItems);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('GitHub sync failed:', err.message);
  process.exit(1);
});
