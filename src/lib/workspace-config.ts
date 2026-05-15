import { ensureSchemaAsync } from './db/init-schema-async';
import { getLibsqlDb } from './db/libsql';

export interface OntologyEntityType {
  id: string;
  label: string;
  description: string;
  examples?: string[];
  aliases?: boolean;
  linkWeight?: number;
  normalization?: 'lower' | 'upper' | 'title' | 'preserve';
}

export interface LifecycleStage {
  id: string;
  label: string;
  description: string;
  relation?: string;
  terminal?: boolean;
  legacyIds?: string[];
}

export interface SourceConfig {
  kind: string;
  label: string;
  supportsStructuredRefs?: boolean;
}

export type CustomTableColumnType = 'text' | 'integer' | 'real' | 'datetime' | 'json' | 'boolean';

export interface CustomTableColumn {
  name: string;
  type: CustomTableColumnType;
  required?: boolean;
  primaryKey?: boolean;
  indexed?: boolean;
}

export interface CustomTableConfig {
  id: string;
  label: string;
  module?: string;
  description?: string;
  columns: CustomTableColumn[];
}

export interface WorkspaceMenuItem {
  id: string;
  label: string;
  href: string;
  module?: string;
}

export interface WorkspaceRole {
  id: string;
  label: string;
  description?: string;
  primarySource?: string;
}

export interface WorkspaceTerminology {
  goal?: string;
  goals?: string;
  project?: string;
  projects?: string;
  decision?: string;
  decisions?: string;
  artifact?: string;
  artifacts?: string;
  source?: string;
  sources?: string;
  searchPlaceholder?: string;
}

export interface WorkspaceUiConfig {
  menu: WorkspaceMenuItem[];
  roles: WorkspaceRole[];
  terminology: WorkspaceTerminology;
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  preset: string;
  enabled: boolean;
  modules: Record<string, boolean>;
  customTables: CustomTableConfig[];
  ui: WorkspaceUiConfig;
  ontology: {
    entityTypes: OntologyEntityType[];
  };
  lifecycle: {
    stages: LifecycleStage[];
  };
  sources: Record<string, SourceConfig>;
  sourceMappings: Record<string, Record<string, string>>;
  linking: {
    entityWeights: Record<string, number>;
    defaultEntityWeight: number;
    sourceKindWeights: Record<string, number>;
    supportingSourceKinds: string[];
  };
}

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  id: 'default',
  name: 'Default Workspace',
  preset: 'bare',
  enabled: false,
  modules: {
    overview: true,
    projects: false,
    knowledge: true,
    goals: true,
  },
  customTables: [],
  ui: {
    menu: [
      { id: 'overview', label: 'Overview', href: '/dashboard', module: 'overview' },
      { id: 'knowledge', label: 'Knowledge', href: '/knowledge', module: 'knowledge' },
      { id: 'goals', label: 'Metrics', href: '/metrics', module: 'goals' },
    ],
    roles: [
      { id: 'owner', label: 'Workspace Owner', description: 'Owns this workspace', primarySource: 'Primary System' },
    ],
    terminology: {
      goal: 'Metric',
      goals: 'Metrics',
      project: 'Work Area',
      projects: 'Work Areas',
      decision: 'Decision',
      decisions: 'Decisions',
      artifact: 'Artifact',
      artifacts: 'Artifacts',
      source: 'Source',
      sources: 'Sources',
      searchPlaceholder: 'Search entities, artifacts, decisions...',
    },
  },
  ontology: {
    entityTypes: [
      { id: 'actor', label: 'Actor', description: 'A person, role, account, or named participant involved in work.', examples: ['Alex Morgan', 'approver', 'requester'], aliases: true, linkWeight: 0.15, normalization: 'title' },
      { id: 'group', label: 'Group', description: 'A team, department, function, committee, or working group.', examples: ['Support Ops', 'Legal Review', 'Platform Team'], aliases: true, linkWeight: 0.25, normalization: 'preserve' },
      { id: 'organization', label: 'Organization', description: 'A company, customer, vendor, partner, agency, or external institution.', examples: ['Acme Corp', 'Vendor A', 'State Health Agency'], aliases: true, linkWeight: 0.3, normalization: 'preserve' },
      { id: 'communication_space', label: 'Communication Space', description: 'A channel, room, thread, inbox, group chat, or other shared conversation space.', examples: ['#platform', 'legal-review', 'case escalations'], aliases: true, linkWeight: 0.2, normalization: 'lower' },
      { id: 'tracker_project', label: 'Tracker Project', description: 'A project, queue, board, case collection, matter group, or work-tracking bucket.', examples: ['ALPHA', 'Operations Board', 'Matter 2026-Q2'], aliases: true, linkWeight: 0.35, normalization: 'upper' },
      { id: 'capability', label: 'Capability', description: 'A reusable functional area, process, workflow, service area, product capability, or business domain.', examples: ['invoice approval', 'contract renewal', 'patient intake', 'budget forecasting'], aliases: true, linkWeight: 0.85, normalization: 'lower' },
      { id: 'system', label: 'System', description: 'A named tool, platform, product, application, database, service, repository, or operational system.', examples: ['Salesforce', 'Billing API', 'SharePoint', 'codebase/server'], aliases: true, linkWeight: 0.7, normalization: 'preserve' },
      { id: 'artifact', label: 'Artifact', description: 'A named document, file, contract, report, ticket, pull request, case, or durable work artifact.', examples: ['Q2 board deck', 'MSA draft', 'ALPHA-123'], aliases: true, linkWeight: 0.55, normalization: 'preserve' },
    ],
  },
  lifecycle: {
    stages: [
      { id: 'seed', label: 'Signal', description: 'The first observed signal: a request, problem, idea, incident, customer need, or triggering event.', relation: 'origin' },
      { id: 'discussion', label: 'Discussion', description: 'Exploration, debate, clarification, feedback, triage, or alignment.', relation: 'discussion' },
      { id: 'decision', label: 'Decision', description: 'A concrete choice, direction, approval, rejection, or policy/action decision.', relation: 'self' },
      { id: 'specification', label: 'Plan', description: 'The selected approach becomes a plan, requirement, specification, scope, draft, or execution brief.', relation: 'specification' },
      { id: 'execution', label: 'Execution', description: 'Work is carried out: implementation, drafting, fulfillment, remediation, delivery, or operational action.', relation: 'execution', legacyIds: ['implementation'] },
      { id: 'review', label: 'Review', description: 'Evaluation, peer review, approval, QA, compliance review, or stakeholder sign-off.', relation: 'review' },
      { id: 'completion', label: 'Completion', description: 'The work is shipped, resolved, signed, closed, published, merged, completed, or otherwise finalized.', relation: 'completion', terminal: true, legacyIds: ['integration'] },
      { id: 'follow_up', label: 'Follow-up', description: 'Post-completion feedback, issue, audit finding, amendment, regression, retrospective, or next action.', relation: 'follow_up' },
    ],
  },
  sources: {
    jira: { kind: 'tracker', label: 'Jira', supportsStructuredRefs: true },
    linear: { kind: 'tracker', label: 'Linear', supportsStructuredRefs: true },
    slack: { kind: 'communication', label: 'Slack' },
    teams: { kind: 'communication', label: 'Teams' },
    meeting: { kind: 'meeting', label: 'Meetings' },
    notion: { kind: 'document', label: 'Notion' },
    gmail: { kind: 'communication', label: 'Gmail' },
    github: { kind: 'code', label: 'GitHub', supportsStructuredRefs: true },
    gitlab: { kind: 'code', label: 'GitLab', supportsStructuredRefs: true },
    gdrive: { kind: 'document', label: 'Google Drive' },
    confluence: { kind: 'document', label: 'Confluence' },
    gcal: { kind: 'meeting', label: 'Google Calendar' },
    pipeline: { kind: 'pipeline', label: 'Pipeline' },
  },
  sourceMappings: {
    jira: { project: 'tracker_project', component: 'capability', label: 'capability', assignee: 'actor', reporter: 'actor' },
    linear: { team: 'tracker_project', label: 'capability', assignee: 'actor' },
    slack: { channel: 'communication_space', user: 'actor' },
    teams: { channel: 'communication_space', team: 'group', user: 'actor' },
    github: { repo: 'system', author: 'actor', pull_request: 'artifact', commit: 'artifact' },
    meeting: { organizer: 'actor', participant: 'actor' },
    notion: { workspace: 'organization', page: 'artifact' },
    gmail: { sender: 'actor', recipient: 'actor', thread: 'communication_space', attachment: 'artifact' },
    gdrive: { owner: 'actor', folder: 'communication_space', file: 'artifact' },
  },
  linking: {
    entityWeights: {
      actor: 0.15, group: 0.25, organization: 0.3, communication_space: 0.2,
      tracker_project: 0.35, capability: 0.85, system: 0.7, artifact: 0.55,
      person: 0.15, team: 0.25, org: 0.3, slack_channel: 0.2,
      jira_project: 0.35, repo: 0.7, product: 0.65, technology: 0.55,
    },
    defaultEntityWeight: 0.25,
    sourceKindWeights: { tracker: 0.8, code: 0.7, communication: 0.35, meeting: 0.35, document: 0.45 },
    supportingSourceKinds: ['communication', 'meeting', 'document'],
  },
};

const ENGINEERING_UI: WorkspaceUiConfig = {
  menu: [
    { id: 'overview', label: 'Overview', href: '/dashboard', module: 'overview' },
    { id: 'projects', label: 'Projects', href: '/projects', module: 'projects' },
    { id: 'knowledge', label: 'Knowledge', href: '/knowledge', module: 'knowledge' },
    { id: 'goals', label: 'Goals', href: '/metrics', module: 'goals' },
  ],
  roles: [
    { id: 'eng_ic', label: 'Engineer', description: 'Ships and reviews work', primarySource: 'Tracker' },
    { id: 'eng_mgr', label: 'Engineering Manager', description: 'Owns delivery and team health', primarySource: 'Tracker' },
    { id: 'pm', label: 'Product Manager', description: 'Owns scope and roadmap alignment', primarySource: 'Product System' },
  ],
  terminology: {
    goal: 'Goal', goals: 'Goals', project: 'Project', projects: 'Projects',
    decision: 'Decision', decisions: 'Decisions', artifact: 'Artifact', artifacts: 'Artifacts',
    source: 'Source', sources: 'Sources', searchPlaceholder: 'Search projects, tickets, PRs, decisions...',
  },
};

const FOUNDER_UI: WorkspaceUiConfig = {
  menu: [
    { id: 'overview', label: 'Today', href: '/dashboard', module: 'overview' },
    { id: 'deals', label: 'Deals', href: '/tables/deals', module: 'deals' },
    { id: 'investors', label: 'Investors', href: '/tables/investors', module: 'investors' },
    { id: 'people', label: 'People', href: '/tables/people', module: 'people' },
    { id: 'projects', label: 'Threads', href: '/projects', module: 'projects' },
    { id: 'knowledge', label: 'Knowledge', href: '/knowledge', module: 'knowledge' },
    { id: 'goals', label: 'Bets', href: '/metrics', module: 'goals' },
  ],
  roles: [
    { id: 'founder', label: 'Founder/CEO', description: 'Sets direction and runs the company', primarySource: 'Gmail' },
    { id: 'cofounder', label: 'Co-founder', description: 'Co-leads the company', primarySource: 'Gmail' },
    { id: 'ea', label: 'Chief of Staff / EA', description: 'Manages founder operations and inbox', primarySource: 'Gmail' },
  ],
  terminology: {
    goal: 'Bet', goals: 'Bets',
    project: 'Thread', projects: 'Threads',
    decision: 'Decision', decisions: 'Decisions',
    artifact: 'Document', artifacts: 'Documents',
    source: 'Source', sources: 'Sources',
    searchPlaceholder: 'Search emails, meetings, deals, investors, people...',
  },
};

const FOUNDER_CUSTOM_TABLES: CustomTableConfig[] = [
  {
    id: 'deals',
    label: 'Deals',
    module: 'deals',
    columns: [
      { name: 'id', type: 'text', required: true, primaryKey: true },
      { name: 'name', type: 'text', required: true },
      { name: 'domain', type: 'text', indexed: true },
      { name: 'stage', type: 'text' },
      { name: 'amount', type: 'real' },
      { name: 'owner', type: 'text' },
      { name: 'primary_contact', type: 'text' },
      { name: 'next_step', type: 'text' },
      { name: 'next_step_due', type: 'datetime' },
      { name: 'last_touch', type: 'datetime' },
      { name: 'created_at', type: 'datetime' },
      { name: 'notes', type: 'text' },
    ],
  },
  {
    id: 'investors',
    label: 'Investors',
    module: 'investors',
    columns: [
      { name: 'id', type: 'text', required: true, primaryKey: true },
      { name: 'firm', type: 'text', required: true },
      { name: 'partner', type: 'text' },
      { name: 'partner_email', type: 'text', indexed: true },
      { name: 'round', type: 'text' },
      { name: 'stage', type: 'text' },
      { name: 'check_size', type: 'real' },
      { name: 'lead', type: 'boolean' },
      { name: 'last_touch', type: 'datetime' },
      { name: 'next_step', type: 'text' },
      { name: 'created_at', type: 'datetime' },
      { name: 'notes', type: 'text' },
    ],
  },
  {
    id: 'people',
    label: 'People',
    module: 'people',
    // Broader than candidates — covers current team, candidates, advisors,
    // contractors, mentors, alumni, etc. The relationship column slices
    // the table into the founder's mental categories without forcing
    // multiple tables for what's structurally the same shape (a person
    // + email + history). Stage semantics shift with relationship:
    // candidates use the sourcing→offer pipeline, team uses active/leave,
    // advisors use active/inactive, etc.
    columns: [
      { name: 'id', type: 'text', required: true, primaryKey: true },
      { name: 'name', type: 'text', required: true },
      { name: 'email', type: 'text', indexed: true },
      { name: 'relationship', type: 'text', indexed: true },
      { name: 'role', type: 'text' },
      { name: 'stage', type: 'text' },
      { name: 'referrer', type: 'text' },
      { name: 'start_date', type: 'datetime' },
      { name: 'compensation', type: 'text' },
      { name: 'last_touch', type: 'datetime' },
      { name: 'created_at', type: 'datetime' },
      { name: 'notes', type: 'text' },
    ],
  },
];

function mergeWorkspaceConfig(raw: Partial<WorkspaceConfig> | null | undefined): WorkspaceConfig {
  if (!raw) return DEFAULT_WORKSPACE_CONFIG;
  return {
    ...DEFAULT_WORKSPACE_CONFIG,
    ...raw,
    enabled: raw.enabled ?? DEFAULT_WORKSPACE_CONFIG.enabled,
    modules: { ...DEFAULT_WORKSPACE_CONFIG.modules, ...(raw.modules ?? {}) },
    customTables: raw.customTables ?? DEFAULT_WORKSPACE_CONFIG.customTables,
    ui: {
      ...DEFAULT_WORKSPACE_CONFIG.ui,
      ...(raw.ui ?? {}),
      menu: raw.ui?.menu ?? DEFAULT_WORKSPACE_CONFIG.ui.menu,
      roles: raw.ui?.roles ?? DEFAULT_WORKSPACE_CONFIG.ui.roles,
      terminology: { ...DEFAULT_WORKSPACE_CONFIG.ui.terminology, ...(raw.ui?.terminology ?? {}) },
    },
    ontology: {
      ...DEFAULT_WORKSPACE_CONFIG.ontology,
      ...(raw.ontology ?? {}),
      entityTypes: raw.ontology?.entityTypes?.length
        ? raw.ontology.entityTypes
        : DEFAULT_WORKSPACE_CONFIG.ontology.entityTypes,
    },
    lifecycle: {
      ...DEFAULT_WORKSPACE_CONFIG.lifecycle,
      ...(raw.lifecycle ?? {}),
      stages: raw.lifecycle?.stages?.length
        ? raw.lifecycle.stages
        : DEFAULT_WORKSPACE_CONFIG.lifecycle.stages,
    },
    sources: { ...DEFAULT_WORKSPACE_CONFIG.sources, ...(raw.sources ?? {}) },
    sourceMappings: { ...DEFAULT_WORKSPACE_CONFIG.sourceMappings, ...(raw.sourceMappings ?? {}) },
    linking: {
      ...DEFAULT_WORKSPACE_CONFIG.linking,
      ...(raw.linking ?? {}),
      entityWeights: { ...DEFAULT_WORKSPACE_CONFIG.linking.entityWeights, ...(raw.linking?.entityWeights ?? {}) },
      sourceKindWeights: { ...DEFAULT_WORKSPACE_CONFIG.linking.sourceKindWeights, ...(raw.linking?.sourceKindWeights ?? {}) },
      supportingSourceKinds: raw.linking?.supportingSourceKinds ?? DEFAULT_WORKSPACE_CONFIG.linking.supportingSourceKinds,
    },
  };
}

// In-memory cache of workspace configs by id. Populated lazily on first
// async read; refreshed on every save/delete. Sync helpers below
// (normalizeLifecycleStage, etc.) read from this cache to avoid forcing
// every sync caller in the codebase to become async.
const cache = new Map<string, WorkspaceConfig>();
let _initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

export async function getWorkspaceConfig(id: string = 'default'): Promise<WorkspaceConfig> {
  await ensureInit();
  const row = await getLibsqlDb()
    .prepare('SELECT config FROM workspace_config WHERE id = ?')
    .get<{ config: string }>(id);

  if (!row) return DEFAULT_WORKSPACE_CONFIG;

  try {
    const cfg = mergeWorkspaceConfig(JSON.parse(row.config));
    cache.set(id, cfg);
    return cfg;
  } catch {
    return DEFAULT_WORKSPACE_CONFIG;
  }
}

/**
 * Sync getter for callers that can't go async — reads from in-memory cache.
 * Falls back to DEFAULT_WORKSPACE_CONFIG if the cache hasn't been warmed yet
 * for this id; fires a background refresh so subsequent calls return real data.
 */
export function getWorkspaceConfigCached(id: string = 'default'): WorkspaceConfig {
  const cached = cache.get(id);
  if (cached) return cached;
  void getWorkspaceConfig(id).catch(() => {
    // ignore — sync caller gets defaults until cache populates
  });
  return DEFAULT_WORKSPACE_CONFIG;
}

export async function seedWorkspaceConfig(): Promise<void> {
  await ensureInit();
  const db = getLibsqlDb();
  await db
    .prepare('INSERT OR IGNORE INTO workspace_config (id, config, enabled) VALUES (?, ?, ?)')
    .run('default', JSON.stringify(DEFAULT_WORKSPACE_CONFIG), 0);

  const rows = await db
    .prepare('SELECT id, config FROM workspace_config WHERE id = ?')
    .all<{ id: string; config: string }>('default');
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.config) as Partial<WorkspaceConfig>;
      const isLegacyDefault =
        row.id === 'default' &&
        (!parsed.modules ||
          parsed.name === 'Default Workspace' ||
          parsed.name === 'Engineering Workspace' ||
          parsed.preset === 'generic-work-trace' ||
          parsed.preset === 'engineering');
      if (isLegacyDefault) {
        await db
          .prepare("UPDATE workspace_config SET config = ?, updated_at = datetime('now') WHERE id = ?")
          .run(
            JSON.stringify({
              ...DEFAULT_WORKSPACE_CONFIG,
              ...parsed,
              name: 'Default Workspace',
              preset: 'bare',
              enabled: false,
              modules: DEFAULT_WORKSPACE_CONFIG.modules,
              ui: DEFAULT_WORKSPACE_CONFIG.ui,
            }),
            row.id,
          );
        await db.prepare('UPDATE workspace_config SET enabled = 0 WHERE id = ?').run(row.id);
      }
    } catch {
      await db
        .prepare("UPDATE workspace_config SET config = ?, updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(DEFAULT_WORKSPACE_CONFIG), row.id);
    }
  }
}

export async function listWorkspaceConfigs(): Promise<WorkspaceConfig[]> {
  await ensureInit();
  const rows = await getLibsqlDb()
    .prepare('SELECT id, config, enabled FROM workspace_config ORDER BY id')
    .all<{ id: string; config: string; enabled: number }>();
  return rows.map((row) => {
    try {
      const parsed = JSON.parse(row.config) as Partial<WorkspaceConfig>;
      const cfg = mergeWorkspaceConfig({ ...parsed, enabled: row.enabled === 1 });
      cache.set(row.id, cfg);
      return cfg;
    } catch {
      return DEFAULT_WORKSPACE_CONFIG;
    }
  });
}

/**
 * Lists workspaces visible to a given authenticated user. Returns
 * workspaces owned by the user (auth_user_id matches). Unclaimed
 * workspaces (auth_user_id IS NULL) are NOT included — they would
 * otherwise leak across users on shared deployments. Use
 * getUserWorkspaceId() if you need first-time claim semantics.
 */
export async function listWorkspaceConfigsForUser(authUserId: string): Promise<WorkspaceConfig[]> {
  await ensureInit();
  const rows = await getLibsqlDb()
    .prepare('SELECT id, config, enabled FROM workspace_config WHERE auth_user_id = ? ORDER BY id')
    .all<{ id: string; config: string; enabled: number }>(authUserId);
  return rows.map((row) => {
    try {
      const parsed = JSON.parse(row.config) as Partial<WorkspaceConfig>;
      const cfg = mergeWorkspaceConfig({ ...parsed, enabled: row.enabled === 1 });
      cache.set(row.id, cfg);
      return cfg;
    } catch {
      return DEFAULT_WORKSPACE_CONFIG;
    }
  });
}

export async function createWorkspaceConfig(input: {
  name: string;
  preset?: string;
  modules?: Record<string, boolean>;
  /**
   * WorkOS user id of the workspace owner. When provided, the workspace is
   * stamped with this id so it counts toward the user's "one workspace"
   * limit and is filtered to only this user in list endpoints.
   */
  authUserId?: string | null;
}): Promise<WorkspaceConfig> {
  await ensureInit();
  const db = getLibsqlDb();
  const idBase =
    input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'workspace';
  let id = idBase;
  let i = 2;
  while (await db.prepare('SELECT 1 as ok FROM workspace_config WHERE id = ?').get<{ ok: number }>(id)) {
    id = `${idBase}-${i++}`;
  }

  const preset = input.preset || 'custom-workspace';
  const presetUi = uiForPreset(preset);
  const presetModules = modulesForPreset(preset);
  const presetCustomTables = customTablesForPreset(preset);
  const config = mergeWorkspaceConfig({
    ...DEFAULT_WORKSPACE_CONFIG,
    id,
    name: input.name.trim(),
    preset,
    enabled: true,
    customTables: presetCustomTables,
    modules: { ...presetModules, ...(input.modules ?? {}) },
    ui: presetUi,
  });

  if (input.authUserId) {
    await db
      .prepare('INSERT INTO workspace_config (id, config, enabled, auth_user_id) VALUES (?, ?, 1, ?)')
      .run(id, JSON.stringify(config), input.authUserId);
  } else {
    await db
      .prepare('INSERT INTO workspace_config (id, config, enabled) VALUES (?, ?, 1)')
      .run(id, JSON.stringify(config));
  }
  cache.set(id, config);
  return config;
}

/**
 * Returns the auth_user_id stamped on a workspace, or null if it's
 * unclaimed. Used by API routes to verify the requesting user owns the
 * workspace they're touching. Library helpers below (saveWorkspaceConfig,
 * setWorkspaceEnabled, deleteWorkspaceConfig) intentionally do NOT call
 * this — they're invoked from non-request contexts (workers, sync
 * pipelines) where there is no auth user to compare against.
 */
export async function getWorkspaceOwner(id: string): Promise<string | null> {
  await ensureInit();
  const row = await getLibsqlDb()
    .prepare('SELECT auth_user_id FROM workspace_config WHERE id = ?')
    .get<{ auth_user_id: string | null }>(id);
  return row?.auth_user_id ?? null;
}

function modulesForPreset(preset: string): Record<string, boolean> {
  if (preset === 'engineering') return { overview: true, projects: true, knowledge: true, goals: true };
  if (preset === 'custom-workspace') return { overview: true, projects: false, knowledge: true, goals: true };
  if (preset === 'sales') return { overview: true, projects: false, knowledge: true, goals: true };
  if (preset === 'legal' || preset === 'finance' || preset === 'operations')
    return { overview: true, projects: false, knowledge: true, goals: true };
  if (preset === 'founder')
    return { overview: true, projects: true, knowledge: true, goals: true, deals: true, investors: true, people: true };
  return DEFAULT_WORKSPACE_CONFIG.modules;
}

function customTablesForPreset(preset: string): CustomTableConfig[] {
  if (preset === 'founder') return FOUNDER_CUSTOM_TABLES;
  return [];
}

function uiForPreset(preset: string): WorkspaceUiConfig {
  if (preset === 'engineering') return ENGINEERING_UI;
  if (preset === 'founder') return FOUNDER_UI;

  if (preset === 'sales') {
    return {
      menu: [
        { id: 'overview', label: 'Pipeline', href: '/dashboard', module: 'overview' },
        { id: 'knowledge', label: 'Accounts', href: '/knowledge', module: 'knowledge' },
        { id: 'goals', label: 'Targets', href: '/metrics', module: 'goals' },
      ],
      roles: [
        { id: 'ae', label: 'Account Executive', description: 'Owns opportunities and follow-ups', primarySource: 'Salesforce' },
        { id: 'sales_mgr', label: 'Sales Manager', description: 'Owns pipeline and forecast', primarySource: 'Salesforce' },
      ],
      terminology: {
        goal: 'Target', goals: 'Targets', project: 'Opportunity', projects: 'Opportunities',
        decision: 'Commitment', decisions: 'Commitments', artifact: 'Deal Artifact', artifacts: 'Deal Artifacts',
        source: 'CRM', sources: 'Sources', searchPlaceholder: 'Search accounts, opportunities, commitments...',
      },
    };
  }

  if (preset === 'legal') {
    return {
      menu: [
        { id: 'overview', label: 'Matters', href: '/dashboard', module: 'overview' },
        { id: 'knowledge', label: 'Knowledge', href: '/knowledge', module: 'knowledge' },
        { id: 'goals', label: 'Risks', href: '/metrics', module: 'goals' },
      ],
      roles: [
        { id: 'counsel', label: 'Counsel', description: 'Owns matters and legal review', primarySource: 'Matter System' },
        { id: 'legal_ops', label: 'Legal Ops', description: 'Owns process and reporting', primarySource: 'Matter System' },
      ],
      terminology: {
        goal: 'Risk Area', goals: 'Risk Areas', project: 'Matter', projects: 'Matters',
        decision: 'Legal Position', decisions: 'Legal Positions', artifact: 'Document', artifacts: 'Documents',
        source: 'System', sources: 'Sources', searchPlaceholder: 'Search matters, documents, legal positions...',
      },
    };
  }

  if (preset === 'operations') {
    return {
      menu: [
        { id: 'overview', label: 'Operations', href: '/dashboard', module: 'overview' },
        { id: 'knowledge', label: 'Processes', href: '/knowledge', module: 'knowledge' },
        { id: 'goals', label: 'KPIs', href: '/metrics', module: 'goals' },
      ],
      roles: [
        { id: 'ops_lead', label: 'Operations Lead', description: 'Owns process execution', primarySource: 'Tracker' },
        { id: 'ops_analyst', label: 'Operations Analyst', description: 'Analyzes signals and throughput', primarySource: 'Tracker' },
      ],
      terminology: {
        goal: 'KPI', goals: 'KPIs', project: 'Process', projects: 'Processes',
        decision: 'Operational Decision', decisions: 'Operational Decisions',
        artifact: 'Work Item', artifacts: 'Work Items', source: 'System', sources: 'Systems',
        searchPlaceholder: 'Search processes, work items, decisions...',
      },
    };
  }

  if (preset === 'finance') {
    return {
      menu: [
        { id: 'overview', label: 'Finance', href: '/dashboard', module: 'overview' },
        { id: 'knowledge', label: 'Analysis', href: '/knowledge', module: 'knowledge' },
        { id: 'goals', label: 'Controls', href: '/metrics', module: 'goals' },
      ],
      roles: [
        { id: 'finance_lead', label: 'Finance Lead', description: 'Owns forecast and controls', primarySource: 'ERP' },
        { id: 'analyst', label: 'Analyst', description: 'Owns analysis and variance traces', primarySource: 'ERP' },
      ],
      terminology: {
        goal: 'Control', goals: 'Controls', project: 'Close Area', projects: 'Close Areas',
        decision: 'Finance Decision', decisions: 'Finance Decisions',
        artifact: 'Analysis', artifacts: 'Analyses', source: 'System', sources: 'Systems',
        searchPlaceholder: 'Search controls, analyses, finance decisions...',
      },
    };
  }

  if (preset === 'custom-workspace') {
    return {
      menu: [
        { id: 'overview', label: 'Overview', href: '/dashboard', module: 'overview' },
        { id: 'knowledge', label: 'Knowledge', href: '/knowledge', module: 'knowledge' },
        { id: 'goals', label: 'Metrics', href: '/metrics', module: 'goals' },
      ],
      roles: [
        { id: 'owner', label: 'Workspace Owner', description: 'Owns this workspace', primarySource: 'Primary System' },
      ],
      terminology: DEFAULT_WORKSPACE_CONFIG.ui.terminology,
    };
  }

  return DEFAULT_WORKSPACE_CONFIG.ui;
}

export async function saveWorkspaceConfig(config: WorkspaceConfig): Promise<void> {
  await ensureInit();
  await getLibsqlDb()
    .prepare(
      `INSERT INTO workspace_config (id, config, enabled, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET config = excluded.config, enabled = excluded.enabled, updated_at = datetime('now')`,
    )
    .run(config.id, JSON.stringify(config), config.enabled ? 1 : 0);
  cache.set(config.id, config);
}

export async function setWorkspaceEnabled(id: string, enabled: boolean): Promise<WorkspaceConfig> {
  await ensureInit();
  const row = await getLibsqlDb()
    .prepare('SELECT config FROM workspace_config WHERE id = ?')
    .get<{ config: string }>(id);
  if (!row) throw new Error(`Workspace not found: ${id}`);

  const parsed = JSON.parse(row.config) as Partial<WorkspaceConfig>;
  const config = mergeWorkspaceConfig({ ...parsed, enabled });
  await saveWorkspaceConfig(config);
  return config;
}

export async function deleteWorkspaceConfig(id: string): Promise<void> {
  if (id === 'default') {
    throw new Error('The default workspace cannot be deleted');
  }
  await ensureInit();
  const db = getLibsqlDb();
  const existing = await db
    .prepare('SELECT id FROM workspace_config WHERE id = ?')
    .get<{ id: string }>(id);
  if (!existing) throw new Error(`Workspace not found: ${id}`);

  await db.prepare('DELETE FROM workspace_config WHERE id = ?').run(id);
  cache.delete(id);
}

export async function addCustomTableToWorkspace(
  workspaceId: string,
  table: CustomTableConfig,
): Promise<WorkspaceConfig> {
  const config = await getWorkspaceConfig(workspaceId);
  const existing = config.customTables ?? [];
  if (existing.some((t) => t.id === table.id)) {
    throw new Error(`Table already exists in workspace config: ${table.id}`);
  }
  const updated: WorkspaceConfig = { ...config, customTables: [...existing, table] };
  await saveWorkspaceConfig(updated);
  return updated;
}

export function getEntityTypeConfig(type: string): OntologyEntityType | undefined {
  return getWorkspaceConfigCached().ontology.entityTypes.find((t) => t.id === type);
}

export function normalizeLifecycleStage(stage: string | null | undefined): string | null {
  if (!stage) return null;
  const config = getWorkspaceConfigCached();
  const direct = config.lifecycle.stages.find((s) => s.id === stage);
  if (direct) return direct.id;
  const legacy = config.lifecycle.stages.find((s) => s.legacyIds?.includes(stage));
  return legacy?.id ?? stage;
}

export function isTerminalLifecycleStage(stage: string | null | undefined): boolean {
  const normalized = normalizeLifecycleStage(stage);
  if (!normalized) return false;
  const config = getWorkspaceConfigCached();
  return config.lifecycle.stages.some((s) => s.id === normalized && s.terminal);
}

export function relationForLifecycleStage(stage: string | null | undefined): string | null {
  const normalized = normalizeLifecycleStage(stage);
  if (!normalized) return null;
  const config = getWorkspaceConfigCached();
  const hit = config.lifecycle.stages.find((s) => s.id === normalized);
  return hit?.relation ?? normalized;
}
