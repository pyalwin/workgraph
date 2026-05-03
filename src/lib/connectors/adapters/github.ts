import type { MCPConnector, DiscoveryOption, LinkInput } from '../types';
import type { WorkItemInput } from '../../sync/types';

/**
 * GitHub adapter — RELEASES ONLY.
 *
 * PRs and issues used to come through this adapter as work_items; that path
 * is gone. PRs now live as `issue_trails` rows anchored to Jira tickets
 * (see src/lib/sync/github-trails.ts), GitHub issues are dropped entirely
 * (Jira is the tracker). Releases stay as standalone work_items because
 * shipping cadence is a useful node-level concept independent of tickets.
 *
 * This adapter still exists for two reasons:
 *   1. The runner needs an MCPConnector to ingest releases on the regular tick.
 *   2. The Settings UI uses `discover` to populate the repo multi-select that
 *      the trails sync reads from `config.options.repos`.
 *
 * The list step is a no-op — releases are fetched via postPass so we can
 * iterate every configured repo even when some have zero releases (the
 * runner breaks the list loop on first empty page).
 */

const RELEASE_STATUS_FROM = (raw: any): string => {
  if (raw?.draft) return 'open';
  if (raw?.prerelease) return 'active';
  return 'done';
};

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

function releaseToWorkItem(raw: any, repo: string): WorkItemInput | null {
  if (!raw?.id || !raw?.tag_name) return null;
  return {
    source: 'github',
    source_id: `release:${repo}:${raw.tag_name}`,
    item_type: 'release',
    title: raw.name || raw.tag_name || `Release ${raw.id}`,
    body: raw.body || null,
    author: raw.author?.login || null,
    status: RELEASE_STATUS_FROM(raw),
    priority: null,
    url: raw.html_url || null,
    metadata: {
      repo,
      tag_name: raw.tag_name,
      draft: raw.draft ?? false,
      prerelease: raw.prerelease ?? false,
      published_at: raw.published_at,
    },
    created_at: raw.created_at || raw.published_at || new Date().toISOString(),
    updated_at: raw.published_at || null,
  };
}

export const githubConnector: MCPConnector = {
  source: 'github',
  label: 'GitHub',
  serverId: 'github',
  itemType: 'release',

  // Cross-source detection still useful for any text body that mentions a PR.
  // Even though PRs aren't work_items, callers (crossref) consume this to
  // surface PR refs in other sources' text.
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

  // Repo multi-select for the trails sync. The connector-runner only invokes
  // discover() during connector setup; it isn't called on every sync.
  supportedLists: [
    {
      id: 'repos',
      label: 'Repositories to sync',
      helpText:
        'PRs from these repos are pulled and attached as trails on the Jira tickets they reference. Leave empty to disable GitHub sync.',
      mapsToOption: 'repos',
    },
  ],

  discover: async (client, listName, _env, options): Promise<DiscoveryOption[]> => {
    if (listName !== 'repos') return [];

    const oauthAccessToken = (options?.__oauthAccessToken as string | undefined)?.trim();
    if (oauthAccessToken) {
      const seen = new Set<string>();
      const results: DiscoveryOption[] = [];
      const MAX = 500;

      for (let page = 1; page <= 5 && results.length < MAX; page++) {
        let resp: Response;
        try {
          resp = await fetch(
            `https://api.github.com/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=${page}`,
            {
              headers: {
                Authorization: `Bearer ${oauthAccessToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
              },
            },
          );
        } catch {
          break;
        }
        if (!resp.ok) break;

        const repos: any[] = await resp.json();
        if (repos.length === 0) break;

        for (const r of repos) {
          const fullName: string = r.full_name || `${r.owner?.login}/${r.name}`;
          if (!fullName || seen.has(fullName)) continue;
          seen.add(fullName);
          const visibility = r.private ? 'private' : 'public';
          const lang = r.language ? ` · ${r.language}` : '';
          const desc = r.description ? ` — ${String(r.description).slice(0, 80)}` : '';
          results.push({
            id: fullName,
            label: fullName,
            hint: `${visibility}${lang}${desc}`,
          });
          if (results.length >= MAX) break;
        }

        if (repos.length < 100) break;
      }

      if (results.length > 0) return results;
    }

    // The official @modelcontextprotocol/server-github only exposes
    // search_repositories — there's no list_user_orgs / list_user_repos.
    // So we explicitly iterate the user's own repos plus each org the
    // user listed in the connector setup. GitHub search supports
    // `user:<login>` and `org:<name>` qualifiers.
    const username = (options?.username as string | undefined)?.trim();
    const orgs = ((options?.orgs as string[] | undefined) ?? []).map((s) => s.trim()).filter(Boolean);

    const queries: string[] = [];
    if (username) queries.push(`user:${username} fork:true`);
    for (const org of orgs) queries.push(`org:${org} fork:true`);

    if (queries.length === 0) {
      // Without a username or any org, we can't enumerate. The UI's
      // discovery panel surfaces an empty list with the form's helpText,
      // which tells the user to fill in their login + orgs.
      return [];
    }

    const seen = new Set<string>();
    const results: DiscoveryOption[] = [];
    const MAX = 500;

    for (const q of queries) {
      let page = 1;
      const PER_PAGE = 100;
      while (results.length < MAX) {
        let resp: any;
        try {
          resp = await client.callTool('search_repositories', { query: q, perPage: PER_PAGE, page });
        } catch {
          break;
        }
        const items: any[] = resp?.items ?? resp?.results ?? (Array.isArray(resp) ? resp : []);
        if (items.length === 0) break;
        for (const r of items) {
          const fullName: string = r.full_name || `${r.owner?.login}/${r.name}`;
          if (!fullName || seen.has(fullName)) continue;
          seen.add(fullName);
          const visibility = r.private ? 'private' : 'public';
          const lang = r.language ? ` · ${r.language}` : '';
          const desc = r.description ? ` — ${String(r.description).slice(0, 80)}` : '';
          results.push({
            id: fullName,
            label: fullName,
            hint: `${visibility}${lang}${desc}`,
          });
          if (results.length >= MAX) break;
        }
        if (items.length < PER_PAGE) break;
        page++;
      }
    }
    return results;
  },

  // Releases are fetched in postPass so we can iterate every configured
  // repo regardless of which has releases (the per-page loop bails on the
  // first empty page). list.skip = true tells the runner to bypass the
  // page loop and go straight to postPass.
  list: {
    tool: '_skipped',
    args: () => ({}),
    extractItems: () => [],
    extractCursor: () => null,
    skip: true,
  },

  toItem: () => null,

  // Real work happens here. Iterate configured repos in parallel (cap 6),
  // fetch releases per repo via the GitHub REST API (the MCP server
  // doesn't expose list_releases), emit release work_items + repository
  // derived items + has_release links.
  postPass: async (_client, _primaries, ctx) => {
    const items: WorkItemInput[] = [];
    const links: LinkInput[] = [];

    const repos = ((ctx.options.repos as string[] | undefined) ?? [])
      .map((s) => String(s).trim())
      .filter(Boolean);

    if (repos.length === 0) return { items, links };

    const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    if (!token) return { items, links };

    const REPO_CONCURRENCY = 6;
    let cursor = 0;
    const seenRepos = new Set<string>();
    const fetchOne = async (fullName: string) => {
      const [owner, repo] = fullName.split('/');
      if (!owner || !repo) return;
      seenRepos.add(fullName);
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        );
        if (!resp.ok) return;
        const releases: any[] = await resp.json();
        for (const release of releases) {
          const item = releaseToWorkItem(release, fullName);
          if (!item) continue;
          items.push(item);
          links.push({
            from: { source: 'github', source_id: item.source_id },
            to: { source: 'github', source_id: repoSourceId(fullName) },
            link_type: 'has_release',
          });
        }
      } catch {
        // Per-repo failures are non-fatal — log silently and continue.
      }
    };

    const workers: Promise<void>[] = [];
    for (let w = 0; w < REPO_CONCURRENCY; w++) {
      workers.push((async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= repos.length) return;
          await fetchOne(repos[idx]);
        }
      })());
    }
    await Promise.all(workers);

    // Emit repo items for every repo we touched (even if it had no releases),
    // so the Settings UI / project queries see the configured set.
    for (const r of seenRepos) items.push(repoToWorkItem(r));

    return { items, links };
  },
};
