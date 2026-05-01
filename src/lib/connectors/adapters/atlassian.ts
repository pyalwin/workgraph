import type { MCPConnector, DiscoveryOption, LinkInput } from '../types';
import type { WorkItemInput } from '../../sync/types';
import { resolveSince, BACKFILL_DEFAULT_DATE } from '../defaults';

const STATUS_MAP: Record<string, string> = {
  done: 'done', closed: 'done', resolved: 'done', production: 'done', merged: 'done',
  will_not_do: 'done', not_doing: 'done', cancelled: 'done', duplicate: 'done',
  in_progress: 'active', in_development: 'active', in_review: 'active', qa: 'active',
  testing: 'active', code_review: 'active',
  to_do: 'open', open: 'open', new: 'open',
  backlog: 'backlog', icebox: 'backlog',
};

function normalizeStatus(raw: string | null | undefined): string {
  if (!raw) return 'open';
  return STATUS_MAP[raw.toLowerCase().replace(/\s+/g, '_')] || 'open';
}

function resolveCloudId(opts: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
  return (opts.cloudId as string)
    || env.MCP_ATLASSIAN_CLOUD_ID
    || (opts.jiraUrl as string)?.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    || 'plateiq.atlassian.net';
}

function resolveBaseUrl(opts: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
  return (opts.jiraUrl as string)
    || env.MCP_ATLASSIAN_BASE_URL
    || `https://${resolveCloudId(opts, env)}`;
}

export const atlassianConnector: MCPConnector = {
  source: 'jira',
  label: 'Jira (Atlassian)',
  serverId: 'atlassian',
  itemType: 'task',

  incremental: {
    bucketField: 'project',
    getBuckets: (options) => {
      const arr = options.projects;
      return Array.isArray(arr) ? (arr as string[]) : [];
    },
  },

  // Jira keys are PROJECT-NUMBER (any uppercase project key). The regex is
  // intentionally permissive — false positives are filtered downstream by
  // requiring the candidate to match an actual source_id in the DB.
  idDetection: {
    findReferences: (text) => {
      return [...new Set(text.match(/\b[A-Z][A-Z0-9_]+-\d+\b/g) || [])];
    },
  },

  list: {
    tool: 'searchJiraIssuesUsingJql',
    args: (ctx) => {
      // Project scope: ctx.options.projects (UI multi-select) → env fallback.
      const selectedProjects = Array.isArray(ctx.options.projects)
        ? (ctx.options.projects as string[])
        : (process.env.MCP_ATLASSIAN_PROJECTS || '').split(',').map((s) => s.trim()).filter(Boolean);

      // User scope.
      const userEmail = (ctx.options.userEmail as string)
        || (ctx.options.username as string)
        || process.env.MCP_ATLASSIAN_USER_EMAIL
        || '';
      const userClause = userEmail
        ? ` AND (assignee = "${userEmail}" OR reporter = "${userEmail}" OR watcher = "${userEmail}")`
        : '';

      let jql: string;
      if (selectedProjects.length === 0) {
        const r = resolveSince(ctx.options, undefined, BACKFILL_DEFAULT_DATE);
        jql = r.allTime
          ? `created >= "1900-01-01"${userClause}`  // JQL needs at least one clause
          : `updated >= "${r.date}"${userClause}`;
      } else {
        // Per-project since: projects with existing items get their own MAX(updated_at);
        // projects without existing items honor options.backfillFrom (default 2026-01-01,
        // 'all' to disable the clamp).
        const clauses = selectedProjects.map((p) => {
          const r = resolveSince(ctx.options, ctx.bucketLastSynced[p], BACKFILL_DEFAULT_DATE);
          return r.allTime
            ? `project = "${p}"`
            : `(project = "${p}" AND updated >= "${r.date}")`;
        });
        jql = `(${clauses.join(' OR ')})${userClause}`;
      }

      return {
        cloudId: resolveCloudId(ctx.options, ctx.env),
        jql,
        nextPageToken: ctx.cursor ?? undefined,
        fields: ['summary', 'status', 'assignee', 'reporter', 'priority', 'labels', 'components', 'created', 'updated', 'description', 'comment', 'project', 'issuetype', 'resolution', 'parent'],
      };
    },
    extractItems: (resp: any) => resp?.issues ?? [],
    extractCursor: (resp: any) => resp?.nextPageToken ?? null,
  },

  supportedLists: [
    {
      id: 'projects',
      label: 'Projects to sync',
      helpText: 'Select which Jira projects feed this workspace. Leave empty to sync all accessible projects.',
      mapsToOption: 'projects',
    },
  ],

  discover: async (client, listName, env) => {
    if (listName !== 'projects') return [];
    const cloudId = env.MCP_ATLASSIAN_CLOUD_ID || 'plateiq.atlassian.net';

    // Atlassian project search returns { values, total, isLast, startAt, maxResults }.
    // Page through every batch — Atlassian caps maxResults at 50.
    const all: DiscoveryOption[] = [];
    let startAt = 0;
    const HARD_CAP = 2000;
    const seen = new Set<string>();

    for (let i = 0; i < 50 && all.length < HARD_CAP; i++) {
      const resp: any = await client.callTool('getVisibleJiraProjects', {
        cloudId,
        action: 'view',
        searchString: '',
        startAt,
        maxResults: 50,
      });
      const values: any[] = resp?.values ?? resp?.projects ?? (Array.isArray(resp) ? resp : []);
      if (values.length === 0) break;

      for (const p of values) {
        const id = p.key || p.id;
        if (!id || seen.has(String(id))) continue;
        seen.add(String(id));
        all.push({
          id: String(id),
          label: p.name || p.key || String(p.id),
          hint: p.projectTypeKey
            ? `${p.projectTypeKey}${p.lead ? ` · ${p.lead.displayName}` : ''}`
            : undefined,
        });
      }

      // Stop when isLast=true OR we've collected total OR page < requested size
      const total = resp?.total;
      const isLast = resp?.isLast === true;
      if (isLast) break;
      if (typeof total === 'number' && all.length >= total) break;
      if (values.length < 50) break;

      startAt += values.length;
    }
    return all;
  },

  toItem: (raw: any): WorkItemInput | null => {
    if (!raw?.key) return null;
    const f = raw.fields ?? {};
    const desc = typeof f.description === 'string' ? f.description : '';
    const comments: any[] = f.comment?.comments || f.comments || [];
    const commentText = comments.length
      ? '\n\n---\n**Comments:**\n\n' + comments.map((c) => {
          const author = c.author?.displayName || c.updateAuthor?.displayName || 'Unknown';
          return `**${author}** (${c.created || ''}):\n${typeof c.body === 'string' ? c.body : ''}\n`;
        }).join('\n')
      : '';

    return {
      source: 'jira',
      source_id: raw.key,
      item_type: f.issuetype?.name?.toLowerCase() || 'task',
      title: f.summary || raw.key,
      body: (desc + commentText) || null,
      author: f.assignee?.displayName || f.reporter?.displayName || null,
      status: normalizeStatus(f.status?.name),
      priority: f.priority?.name?.toLowerCase() || null,
      url: `${resolveBaseUrl({ jiraUrl: undefined }, process.env)}/browse/${raw.key}`,
      metadata: {
        labels: f.labels || [],
        components: f.components?.map((c: any) => c.name) || [],
        sprint: f.sprint?.name || null,
        reporter: f.reporter?.displayName || null,
        project: f.project?.key || null,
        parent_key: f.parent?.key || null,
        parent_type: f.parent?.fields?.issuetype?.name || null,
        resolution: f.resolution?.name || null,
        comment_count: comments.length,
      },
      created_at: f.created || new Date().toISOString(),
      updated_at: f.updated || null,
    };
  },

  derivedItems: (raw: any): WorkItemInput[] => {
    const out: WorkItemInput[] = [];
    const f = raw?.fields ?? {};

    // Project as a parent node
    if (f.project?.key) {
      out.push({
        source: 'jira',
        source_id: `project:${f.project.key}`,
        item_type: 'project',
        title: f.project.name || f.project.key,
        body: null,
        author: null,
        status: 'active',
        priority: null,
        url: `${resolveBaseUrl({ jiraUrl: undefined }, process.env)}/jira/software/projects/${f.project.key}`,
        metadata: { project_key: f.project.key, project_type: f.project.projectTypeKey || null },
        created_at: new Date().toISOString(),
        updated_at: null,
      });
    }

    // Parent epic / story / sub-task — emit a placeholder so the link resolves
    // even when the parent itself isn't in this sync window.
    if (f.parent?.key) {
      const parentType = f.parent.fields?.issuetype?.name?.toLowerCase() || 'epic';
      out.push({
        source: 'jira',
        source_id: f.parent.key,
        item_type: parentType,
        title: f.parent.fields?.summary || f.parent.key,
        body: null,
        author: null,
        status: normalizeStatus(f.parent.fields?.status?.name),
        priority: null,
        url: `${resolveBaseUrl({ jiraUrl: undefined }, process.env)}/browse/${f.parent.key}`,
        metadata: { project_key: f.parent.key.split('-')[0], placeholder: true },
        created_at: new Date().toISOString(),
        updated_at: null,
      });
    }

    return out;
  },

  links: (raw: any, primary): LinkInput[] => {
    if (!primary) return [];
    const f = raw?.fields ?? {};
    const out: LinkInput[] = [];
    if (f.project?.key) {
      out.push({
        from: { source: 'jira', source_id: primary.source_id },
        to: { source: 'jira', source_id: `project:${f.project.key}` },
        link_type: 'in_project',
      });
    }
    if (f.parent?.key) {
      out.push({
        from: { source: 'jira', source_id: primary.source_id },
        to: { source: 'jira', source_id: f.parent.key },
        link_type: 'child_of',
      });
      // Link the parent (often a placeholder epic we synthesized) into its
      // own project cluster too. Without this, placeholder epics float
      // alongside their children instead of inside the project hub.
      const parentProjectKey = f.parent.key.includes('-') ? f.parent.key.split('-')[0] : null;
      if (parentProjectKey) {
        out.push({
          from: { source: 'jira', source_id: f.parent.key },
          to: { source: 'jira', source_id: `project:${parentProjectKey}` },
          link_type: 'in_project',
        });
      }
    }
    return out;
  },
};
