import type { MCPConnector, LinkInput } from '../types';
import type { WorkItemInput } from '../../sync/types';

const STATUS_MAP: Record<string, string> = {
  done: 'done', completed: 'done', cancelled: 'done', duplicate: 'done',
  started: 'active', in_progress: 'active', in_review: 'active',
  unstarted: 'open', todo: 'open', triage: 'open',
  backlog: 'backlog',
};

function normalizeStatus(stateType: string | null | undefined, name: string | null | undefined): string {
  const key = (stateType || name || '').toLowerCase().replace(/\s+/g, '_');
  return STATUS_MAP[key] || 'open';
}

export const linearConnector: MCPConnector = {
  source: 'linear',
  label: 'Linear',
  serverId: 'linear',
  itemType: 'task',

  // Linear identifiers: TEAM-NUMBER (e.g. ENG-123). Same shape as Jira.
  idDetection: {
    findReferences: (text) => {
      return [...new Set(text.match(/\b[A-Z]{2,8}-\d+\b/g) || [])];
    },
  },
  requiredEnv: ['MCP_LINEAR_URL'],

  list: {
    tool: 'list_issues',
    args: (ctx) => ({
      first: ctx.limit,
      after: ctx.cursor ?? undefined,
      filter: ctx.since ? { updatedAt: { gte: ctx.since } } : undefined,
      orderBy: 'updatedAt',
    }),
    extractItems: (resp: any) => resp?.nodes ?? resp?.issues ?? [],
    extractCursor: (resp: any) => resp?.pageInfo?.endCursor ?? null,
  },

  toItem: (raw: any): WorkItemInput | null => {
    if (!raw?.id) return null;
    return {
      source: 'linear',
      source_id: raw.identifier || raw.id,
      item_type: raw.type || 'task',
      title: raw.title || 'Untitled',
      body: raw.description || null,
      author: raw.assignee?.name || raw.assignee?.email || raw.creator?.name || null,
      status: normalizeStatus(raw.state?.type, raw.state?.name),
      priority: raw.priorityLabel?.toLowerCase() || (raw.priority != null ? String(raw.priority) : null),
      url: raw.url || null,
      metadata: {
        team: raw.team?.key || raw.team?.name || null,
        project: raw.project?.name || null,
        labels: raw.labels?.nodes?.map((l: any) => l.name) || raw.labels || [],
        cycle: raw.cycle?.name || null,
        estimate: raw.estimate ?? null,
      },
      created_at: raw.createdAt || new Date().toISOString(),
      updated_at: raw.updatedAt || null,
    };
  },

  derivedItems: (raw: any): WorkItemInput[] => {
    const out: WorkItemInput[] = [];
    if (raw?.project?.id) {
      out.push({
        source: 'linear',
        source_id: `project:${raw.project.id}`,
        item_type: 'project',
        title: raw.project.name || 'Untitled project',
        body: raw.project.description || null,
        author: null,
        status: raw.project.state || 'active',
        priority: null,
        url: raw.project.url || null,
        metadata: { team: raw.team?.key || null },
        created_at: raw.project.createdAt || new Date().toISOString(),
        updated_at: raw.project.updatedAt || null,
      });
    }
    if (raw?.team?.id) {
      out.push({
        source: 'linear',
        source_id: `team:${raw.team.id}`,
        item_type: 'team',
        title: raw.team.name || raw.team.key || 'Untitled team',
        body: null,
        author: null,
        status: 'active',
        priority: null,
        url: null,
        metadata: { key: raw.team.key },
        created_at: new Date().toISOString(),
        updated_at: null,
      });
    }
    return out;
  },

  links: (raw: any, primary): LinkInput[] => {
    if (!primary) return [];
    const out: LinkInput[] = [];
    if (raw?.project?.id) {
      out.push({
        from: { source: 'linear', source_id: primary.source_id },
        to: { source: 'linear', source_id: `project:${raw.project.id}` },
        link_type: 'in_project',
      });
    }
    if (raw?.team?.id) {
      out.push({
        from: { source: 'linear', source_id: primary.source_id },
        to: { source: 'linear', source_id: `team:${raw.team.id}` },
        link_type: 'in_team',
      });
    }
    return out;
  },
};
