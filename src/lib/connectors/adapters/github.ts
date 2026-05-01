import type { MCPConnector, LinkInput } from '../types';
import type { WorkItemInput } from '../../sync/types';
import { resolveSince, BACKFILL_DEFAULT_DATE } from '../defaults';

const STATUS_MAP: Record<string, string> = {
  open: 'open', closed: 'done', merged: 'done',
};

function repoFullName(raw: any): string | null {
  return raw?.repository_url?.split('/repos/')[1]
    || raw?.repository?.full_name
    || (raw?.html_url ? extractRepoFromHtmlUrl(raw.html_url) : null)
    || null;
}

function extractRepoFromHtmlUrl(url: string): string | null {
  // https://github.com/owner/repo/pull/123 or .../issues/123
  const m = url.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\//);
  return m ? m[1] : null;
}

function repoSourceId(fullName: string): string {
  return `repo:${fullName}`;
}

function repoToWorkItem(fullName: string): WorkItemInput {
  return {
    source: 'github',
    source_id: repoSourceId(fullName),
    item_type: 'repository',
    title: fullName,
    body: null,
    author: null,
    status: 'active',
    priority: null,
    url: `https://github.com/${fullName}`,
    metadata: { repo_full_name: fullName },
    created_at: new Date().toISOString(),
    updated_at: null,
  };
}

export const githubConnector: MCPConnector = {
  source: 'github',
  label: 'GitHub',
  serverId: 'github',
  itemType: 'issue',

  // Detect references to GitHub items in two forms:
  //   - "owner/repo#123"     → matches our source_id directly
  //   - "github.com/.../pull/123" or "github.com/.../issues/123" URLs
  // Bare "#123" is too ambiguous (could mean anything) — skip.
  idDetection: {
    findReferences: (text) => {
      const refs = new Set<string>();
      for (const m of text.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g)) {
        refs.add(`${m[1]}#${m[2]}`);
      }
      for (const m of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/g)) {
        refs.add(`${m[1]}#${m[2]}`);
      }
      return [...refs];
    },
  },

  list: {
    tool: 'search_issues',
    args: (ctx) => {
      const username = (ctx.options.username as string) || process.env.MCP_GITHUB_USERNAME || '';
      const owner = (ctx.options.owner as string) || process.env.MCP_GITHUB_OWNER || '';
      const r = resolveSince(ctx.options, ctx.since ?? undefined, BACKFILL_DEFAULT_DATE);

      let q = process.env.MCP_GITHUB_QUERY;
      if (!q) {
        const filters: string[] = [];
        if (!r.allTime) filters.push(`updated:>=${r.date}`);
        if (username) filters.push(`involves:${username}`);
        if (owner) filters.push(`org:${owner}`);
        // Always include at least one filter — bare GitHub search rejects empty queries.
        if (filters.length === 0) filters.push(`is:issue is:open`);
        q = filters.join(' ');
      }
      return {
        q,
        per_page: ctx.limit,
        page: ctx.cursor ? Number(ctx.cursor) : 1,
      };
    },
    extractItems: (resp: any) => resp?.items ?? resp?.results ?? [],
    extractCursor: (resp: any) => {
      const items = resp?.items ?? [];
      if (items.length === 0) return null;
      const next = Number(resp?._page ?? 1) + 1;
      return String(next);
    },
  },

  // PRs only — fetch the full PR object for commits/additions/deletions.
  // Issues skip this entirely (search_issues already has everything we need).
  detail: {
    tool: 'get_pull_request',
    skip: (raw: any) => !raw?.pull_request,
    args: (raw: any) => {
      const fullName = repoFullName(raw)!;
      const [owner, repo] = fullName.split('/');
      return { owner, repo, pull_number: raw.number };
    },
    merge: (raw: any, detail: any) => ({
      ...raw,
      commits_count: detail?.commits ?? detail?.commits_count ?? null,
      additions: detail?.additions ?? null,
      deletions: detail?.deletions ?? null,
      changed_files: detail?.changed_files ?? null,
      merged: detail?.merged ?? raw.pull_request?.merged_at != null,
    }),
  },

  toItem: (raw: any): WorkItemInput | null => {
    if (!raw?.id) return null;
    const isPR = Boolean(raw.pull_request);
    const repo = repoFullName(raw);
    return {
      source: 'github',
      source_id: `${repo || 'unknown'}#${raw.number}`,
      item_type: isPR ? 'pull_request' : 'issue',
      title: raw.title || `#${raw.number}`,
      body: raw.body || null,
      author: raw.user?.login || null,
      status: STATUS_MAP[raw.state] || 'open',
      priority: null,
      url: raw.html_url || null,
      metadata: {
        repo,
        labels: (raw.labels || []).map((l: any) => (typeof l === 'string' ? l : l.name)),
        assignees: (raw.assignees || []).map((a: any) => a.login),
        comments: raw.comments ?? 0,
        merged: raw.pull_request?.merged_at ?? raw.merged ?? null,
        commits_count: raw.commits_count ?? null,
        additions: raw.additions ?? null,
        deletions: raw.deletions ?? null,
        changed_files: raw.changed_files ?? null,
      },
      created_at: raw.created_at || new Date().toISOString(),
      updated_at: raw.updated_at || null,
    };
  },

  derivedItems: (raw: any) => {
    const repo = repoFullName(raw);
    return repo ? [repoToWorkItem(repo)] : [];
  },

  links: (raw: any, primary): LinkInput[] => {
    if (!primary) return [];
    const repo = repoFullName(raw);
    if (!repo) return [];
    return [{
      from: { source: 'github', source_id: primary.source_id },
      to: { source: 'github', source_id: repoSourceId(repo) },
      link_type: 'in_repo',
    }];
  },

  // After processing all PRs/issues, fetch releases for each unique repo we saw.
  postPass: async (client, primaries) => {
    const repos = new Set<string>();
    for (const p of primaries) {
      if (p.item_type === 'repository') repos.add(p.title);
    }

    const items: WorkItemInput[] = [];
    const links: LinkInput[] = [];
    for (const fullName of repos) {
      const [owner, repo] = fullName.split('/');
      try {
        const resp: any = await client.callTool('list_releases', { owner, repo, per_page: 30 });
        const releases: any[] = Array.isArray(resp) ? resp : (resp?.releases ?? resp?.items ?? []);
        for (const r of releases) {
          if (!r?.id) continue;
          const sourceId = `release:${fullName}:${r.tag_name || r.id}`;
          items.push({
            source: 'github',
            source_id: sourceId,
            item_type: 'release',
            title: r.name || r.tag_name || `Release ${r.id}`,
            body: r.body || null,
            author: r.author?.login || null,
            status: r.draft ? 'open' : (r.prerelease ? 'active' : 'done'),
            priority: null,
            url: r.html_url || null,
            metadata: {
              repo: fullName,
              tag_name: r.tag_name,
              draft: r.draft ?? false,
              prerelease: r.prerelease ?? false,
              published_at: r.published_at,
            },
            created_at: r.created_at || r.published_at || new Date().toISOString(),
            updated_at: r.published_at || null,
          });
          links.push({
            from: { source: 'github', source_id: sourceId },
            to: { source: 'github', source_id: repoSourceId(fullName) },
            link_type: 'has_release',
          });
        }
      } catch {
        // Releases tool unavailable or repo has no releases — non-fatal.
      }
    }
    return { items, links };
  },
};
