import { getDb } from './db';

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
    otti: false,
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
      {
        id: 'actor',
        label: 'Actor',
        description: 'A person, role, account, or named participant involved in work.',
        examples: ['Alex Morgan', 'approver', 'requester'],
        aliases: true,
        linkWeight: 0.15,
        normalization: 'title',
      },
      {
        id: 'group',
        label: 'Group',
        description: 'A team, department, function, committee, or working group.',
        examples: ['Support Ops', 'Legal Review', 'Platform Team'],
        aliases: true,
        linkWeight: 0.25,
        normalization: 'preserve',
      },
      {
        id: 'organization',
        label: 'Organization',
        description: 'A company, customer, vendor, partner, agency, or external institution.',
        examples: ['Acme Corp', 'Vendor A', 'State Health Agency'],
        aliases: true,
        linkWeight: 0.3,
        normalization: 'preserve',
      },
      {
        id: 'communication_space',
        label: 'Communication Space',
        description: 'A channel, room, thread, inbox, group chat, or other shared conversation space.',
        examples: ['#platform', 'legal-review', 'case escalations'],
        aliases: true,
        linkWeight: 0.2,
        normalization: 'lower',
      },
      {
        id: 'tracker_project',
        label: 'Tracker Project',
        description: 'A project, queue, board, case collection, matter group, or work-tracking bucket.',
        examples: ['INT', 'Operations Board', 'Matter 2026-Q2'],
        aliases: true,
        linkWeight: 0.35,
        normalization: 'upper',
      },
      {
        id: 'capability',
        label: 'Capability',
        description: 'A reusable functional area, process, workflow, service area, product capability, or business domain.',
        examples: ['invoice approval', 'contract renewal', 'patient intake', 'budget forecasting'],
        aliases: true,
        linkWeight: 0.85,
        normalization: 'lower',
      },
      {
        id: 'system',
        label: 'System',
        description: 'A named tool, platform, product, application, database, service, repository, or operational system.',
        examples: ['Salesforce', 'Billing API', 'SharePoint', 'codebase/server'],
        aliases: true,
        linkWeight: 0.7,
        normalization: 'preserve',
      },
      {
        id: 'artifact',
        label: 'Artifact',
        description: 'A named document, file, contract, report, ticket, pull request, case, or durable work artifact.',
        examples: ['Q2 board deck', 'MSA draft', 'PEX-123'],
        aliases: true,
        linkWeight: 0.55,
        normalization: 'preserve',
      },
    ],
  },
  lifecycle: {
    stages: [
      {
        id: 'seed',
        label: 'Signal',
        description: 'The first observed signal: a request, problem, idea, incident, customer need, or triggering event.',
        relation: 'origin',
      },
      {
        id: 'discussion',
        label: 'Discussion',
        description: 'Exploration, debate, clarification, feedback, triage, or alignment.',
        relation: 'discussion',
      },
      {
        id: 'decision',
        label: 'Decision',
        description: 'A concrete choice, direction, approval, rejection, or policy/action decision.',
        relation: 'self',
      },
      {
        id: 'specification',
        label: 'Plan',
        description: 'The selected approach becomes a plan, requirement, specification, scope, draft, or execution brief.',
        relation: 'specification',
      },
      {
        id: 'execution',
        label: 'Execution',
        description: 'Work is carried out: implementation, drafting, fulfillment, remediation, delivery, or operational action.',
        relation: 'execution',
        legacyIds: ['implementation'],
      },
      {
        id: 'review',
        label: 'Review',
        description: 'Evaluation, peer review, approval, QA, compliance review, or stakeholder sign-off.',
        relation: 'review',
      },
      {
        id: 'completion',
        label: 'Completion',
        description: 'The work is shipped, resolved, signed, closed, published, merged, completed, or otherwise finalized.',
        relation: 'completion',
        terminal: true,
        legacyIds: ['integration'],
      },
      {
        id: 'follow_up',
        label: 'Follow-up',
        description: 'Post-completion feedback, issue, audit finding, amendment, regression, retrospective, or next action.',
        relation: 'follow_up',
      },
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
  },
  sourceMappings: {
    jira: {
      project: 'tracker_project',
      component: 'capability',
      label: 'capability',
      assignee: 'actor',
      reporter: 'actor',
    },
    linear: {
      team: 'tracker_project',
      label: 'capability',
      assignee: 'actor',
    },
    slack: {
      channel: 'communication_space',
      user: 'actor',
    },
    teams: {
      channel: 'communication_space',
      team: 'group',
      user: 'actor',
    },
    github: {
      repo: 'system',
      author: 'actor',
      pull_request: 'artifact',
      commit: 'artifact',
    },
    meeting: {
      organizer: 'actor',
      participant: 'actor',
    },
    notion: {
      workspace: 'organization',
      page: 'artifact',
    },
    gmail: {
      sender: 'actor',
      thread: 'communication_space',
    },
    gdrive: {
      owner: 'actor',
      folder: 'communication_space',
      file: 'artifact',
    },
  },
  linking: {
    entityWeights: {
      actor: 0.15,
      group: 0.25,
      organization: 0.3,
      communication_space: 0.2,
      tracker_project: 0.35,
      capability: 0.85,
      system: 0.7,
      artifact: 0.55,
      // Legacy entity types from the pre-configurable extractor.
      person: 0.15,
      team: 0.25,
      org: 0.3,
      slack_channel: 0.2,
      jira_project: 0.35,
      repo: 0.7,
      product: 0.65,
      technology: 0.55,
    },
    defaultEntityWeight: 0.25,
    sourceKindWeights: {
      tracker: 0.8,
      code: 0.7,
      communication: 0.35,
      meeting: 0.35,
      document: 0.45,
    },
    supportingSourceKinds: ['communication', 'meeting', 'document'],
  },
};

export const OTTI_WORKSPACE_CONFIG: WorkspaceConfig = {
  ...DEFAULT_WORKSPACE_CONFIG,
  id: 'otti',
  name: 'Otti Assistant',
  preset: 'custom-workspace',
  enabled: true,
  modules: {
    overview: true,
    projects: false,
    knowledge: true,
    goals: true,
    otti: true,
  },
  customTables: [
    {
      id: 'otti_sessions',
      label: 'Otti Sessions',
      module: 'otti',
      description: 'Assistant conversation/session telemetry for the Otti custom workspace.',
      columns: [
        { name: 'id', type: 'text', primaryKey: true, required: true },
        { name: 'ts_start', type: 'datetime', required: true, indexed: true },
        { name: 'ts_end', type: 'datetime', required: true },
        { name: 'user_id', type: 'text', required: true, indexed: true },
        { name: 'channel_id', type: 'text', required: true },
        { name: 'persona', type: 'text', required: true, indexed: true },
        { name: 'intent', type: 'text', required: true, indexed: true },
        { name: 'agent_type', type: 'text', required: true },
        { name: 'model', type: 'text', required: true, indexed: true },
        { name: 'repo_name', type: 'text' },
        { name: 'num_events', type: 'integer', required: true },
        { name: 'duration_s', type: 'real', required: true },
      ],
    },
    {
      id: 'otti_users',
      label: 'Otti Users',
      module: 'otti',
      description: 'Display metadata for assistant users.',
      columns: [
        { name: 'user_id', type: 'text', primaryKey: true, required: true },
        { name: 'display_name', type: 'text', required: true },
        { name: 'title', type: 'text' },
      ],
    },
    {
      id: 'otti_deployments',
      label: 'Otti Deployments',
      module: 'otti',
      description: 'Deployment markers used for adoption/performance comparisons.',
      columns: [
        { name: 'id', type: 'text', primaryKey: true, required: true },
        { name: 'name', type: 'text', required: true },
        { name: 'deploy_date', type: 'datetime', required: true },
        { name: 'created_at', type: 'datetime' },
      ],
    },
  ],
  ui: {
    menu: [
      { id: 'otti', label: 'Otti', href: '/otti', module: 'otti' },
    ],
    roles: [
      { id: 'owner', label: 'Workspace Owner', description: 'Owns assistant adoption and performance', primarySource: 'Otti' },
    ],
    terminology: {
      goal: 'Metric',
      goals: 'Metrics',
      project: 'Deployment',
      projects: 'Deployments',
      decision: 'Change',
      decisions: 'Changes',
      artifact: 'Session',
      artifacts: 'Sessions',
      source: 'Telemetry Source',
      sources: 'Telemetry Sources',
      searchPlaceholder: 'Search sessions, users, intents...',
    },
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
    goal: 'Goal',
    goals: 'Goals',
    project: 'Project',
    projects: 'Projects',
    decision: 'Decision',
    decisions: 'Decisions',
    artifact: 'Artifact',
    artifacts: 'Artifacts',
    source: 'Source',
    sources: 'Sources',
    searchPlaceholder: 'Search projects, tickets, PRs, decisions...',
  },
};

function mergeWorkspaceConfig(raw: Partial<WorkspaceConfig> | null | undefined): WorkspaceConfig {
  if (!raw) return DEFAULT_WORKSPACE_CONFIG;
  return {
    ...DEFAULT_WORKSPACE_CONFIG,
    ...raw,
    enabled: raw.enabled ?? DEFAULT_WORKSPACE_CONFIG.enabled,
    modules: {
      ...DEFAULT_WORKSPACE_CONFIG.modules,
      ...(raw.modules ?? {}),
    },
    customTables: raw.customTables ?? DEFAULT_WORKSPACE_CONFIG.customTables,
    ui: {
      ...DEFAULT_WORKSPACE_CONFIG.ui,
      ...(raw.ui ?? {}),
      menu: raw.ui?.menu ?? DEFAULT_WORKSPACE_CONFIG.ui.menu,
      roles: raw.ui?.roles ?? DEFAULT_WORKSPACE_CONFIG.ui.roles,
      terminology: {
        ...DEFAULT_WORKSPACE_CONFIG.ui.terminology,
        ...(raw.ui?.terminology ?? {}),
      },
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
    sources: {
      ...DEFAULT_WORKSPACE_CONFIG.sources,
      ...(raw.sources ?? {}),
    },
    sourceMappings: {
      ...DEFAULT_WORKSPACE_CONFIG.sourceMappings,
      ...(raw.sourceMappings ?? {}),
    },
    linking: {
      ...DEFAULT_WORKSPACE_CONFIG.linking,
      ...(raw.linking ?? {}),
      entityWeights: {
        ...DEFAULT_WORKSPACE_CONFIG.linking.entityWeights,
        ...(raw.linking?.entityWeights ?? {}),
      },
      sourceKindWeights: {
        ...DEFAULT_WORKSPACE_CONFIG.linking.sourceKindWeights,
        ...(raw.linking?.sourceKindWeights ?? {}),
      },
      supportingSourceKinds:
        raw.linking?.supportingSourceKinds ?? DEFAULT_WORKSPACE_CONFIG.linking.supportingSourceKinds,
    },
  };
}

export function getWorkspaceConfig(id: string = 'default'): WorkspaceConfig {
  const db = getDb();
  const row = db
    .prepare('SELECT config FROM workspace_config WHERE id = ?')
    .get(id) as { config: string } | undefined;

  if (!row) return id === 'otti' ? OTTI_WORKSPACE_CONFIG : DEFAULT_WORKSPACE_CONFIG;

  try {
    return mergeWorkspaceConfig(JSON.parse(row.config));
  } catch {
    return DEFAULT_WORKSPACE_CONFIG;
  }
}

export function seedWorkspaceConfig() {
  const db = getDb();
  const insert = db.prepare('INSERT OR IGNORE INTO workspace_config (id, config, enabled) VALUES (?, ?, ?)');
  const update = db.prepare('UPDATE workspace_config SET config = ?, updated_at = datetime(\'now\') WHERE id = ?');

  insert.run(
    'default',
    JSON.stringify(DEFAULT_WORKSPACE_CONFIG),
    0,
  );
  // Otti remains available as a module preset, but is not inserted as an
  // enabled workspace by default. Existing Otti workspace rows are preserved.

  const rows = db.prepare('SELECT id, config FROM workspace_config WHERE id IN (?, ?)').all('default', 'otti') as { id: string; config: string }[];
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
      const missingModules = !parsed.modules;
      if (isLegacyDefault) {
        update.run(JSON.stringify({
          ...DEFAULT_WORKSPACE_CONFIG,
          ...parsed,
          name: 'Default Workspace',
          preset: 'bare',
          enabled: false,
          modules: DEFAULT_WORKSPACE_CONFIG.modules,
          ui: DEFAULT_WORKSPACE_CONFIG.ui,
        }), row.id);
        db.prepare('UPDATE workspace_config SET enabled = 0 WHERE id = ?').run(row.id);
      } else if (row.id === 'otti' && missingModules) {
        update.run(JSON.stringify({ ...OTTI_WORKSPACE_CONFIG, ...parsed, enabled: false, modules: OTTI_WORKSPACE_CONFIG.modules, ui: OTTI_WORKSPACE_CONFIG.ui }), row.id);
        db.prepare('UPDATE workspace_config SET enabled = 0 WHERE id = ?').run(row.id);
      } else if (row.id === 'otti' && parsed.ui?.menu?.length !== 1) {
        update.run(JSON.stringify({ ...OTTI_WORKSPACE_CONFIG, ...parsed, enabled: false, modules: OTTI_WORKSPACE_CONFIG.modules, ui: OTTI_WORKSPACE_CONFIG.ui }), row.id);
        db.prepare('UPDATE workspace_config SET enabled = 0 WHERE id = ?').run(row.id);
      } else if (row.id === 'otti') {
        const currentlyEnabled = db.prepare('SELECT enabled FROM workspace_config WHERE id = ?').get(row.id) as { enabled: number } | undefined;
        if (currentlyEnabled?.enabled === 1) {
          update.run(JSON.stringify({ ...OTTI_WORKSPACE_CONFIG, ...parsed, enabled: false, modules: OTTI_WORKSPACE_CONFIG.modules, ui: OTTI_WORKSPACE_CONFIG.ui }), row.id);
          db.prepare('UPDATE workspace_config SET enabled = 0 WHERE id = ?').run(row.id);
        }
      }
    } catch {
      update.run(JSON.stringify(row.id === 'otti' ? OTTI_WORKSPACE_CONFIG : DEFAULT_WORKSPACE_CONFIG), row.id);
    }
  }
}

export function listWorkspaceConfigs(): WorkspaceConfig[] {
  const db = getDb();
  const rows = db.prepare('SELECT id, config, enabled FROM workspace_config ORDER BY id').all() as { id: string; config: string; enabled: number }[];
  return rows.map((row) => {
    try {
      const parsed = JSON.parse(row.config) as Partial<WorkspaceConfig>;
      return mergeWorkspaceConfig({ ...parsed, enabled: row.enabled === 1 });
    } catch {
      return row.id === 'otti' ? OTTI_WORKSPACE_CONFIG : DEFAULT_WORKSPACE_CONFIG;
    }
  });
}

export function createWorkspaceConfig(input: { name: string; preset?: string; modules?: Record<string, boolean> }): WorkspaceConfig {
  const db = getDb();
  const idBase = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'workspace';
  let id = idBase;
  let i = 2;
  while (db.prepare('SELECT 1 FROM workspace_config WHERE id = ?').get(id)) {
    id = `${idBase}-${i++}`;
  }

  const preset = input.preset || 'custom-workspace';
  const presetUi = uiForPreset(preset);
  const presetModules = modulesForPreset(preset);
  const config = mergeWorkspaceConfig({
    ...DEFAULT_WORKSPACE_CONFIG,
    id,
    name: input.name.trim(),
    preset,
    enabled: true,
    customTables: preset === 'otti' ? OTTI_WORKSPACE_CONFIG.customTables : DEFAULT_WORKSPACE_CONFIG.customTables,
    modules: {
      ...presetModules,
      ...(input.modules ?? {}),
    },
    ui: presetUi,
  });

  db.prepare('INSERT INTO workspace_config (id, config, enabled) VALUES (?, ?, 1)').run(id, JSON.stringify(config));
  return config;
}

function modulesForPreset(preset: string): Record<string, boolean> {
  if (preset === 'engineering') {
    return { overview: true, projects: true, knowledge: true, goals: true, otti: false };
  }
  if (preset === 'custom-workspace') {
    return { overview: true, projects: false, knowledge: true, goals: true, otti: false };
  }
  if (preset === 'otti') {
    return OTTI_WORKSPACE_CONFIG.modules;
  }
  if (preset === 'sales') {
    return { overview: true, projects: false, knowledge: true, goals: true, otti: false };
  }
  if (preset === 'legal' || preset === 'finance' || preset === 'operations') {
    return { overview: true, projects: false, knowledge: true, goals: true, otti: false };
  }
  return DEFAULT_WORKSPACE_CONFIG.modules;
}

function uiForPreset(preset: string): WorkspaceUiConfig {
  if (preset === 'otti') {
    return OTTI_WORKSPACE_CONFIG.ui;
  }

  if (preset === 'engineering') {
    return ENGINEERING_UI;
  }

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
        goal: 'Target',
        goals: 'Targets',
        project: 'Opportunity',
        projects: 'Opportunities',
        decision: 'Commitment',
        decisions: 'Commitments',
        artifact: 'Deal Artifact',
        artifacts: 'Deal Artifacts',
        source: 'CRM',
        sources: 'Sources',
        searchPlaceholder: 'Search accounts, opportunities, commitments...',
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
        goal: 'Risk Area',
        goals: 'Risk Areas',
        project: 'Matter',
        projects: 'Matters',
        decision: 'Legal Position',
        decisions: 'Legal Positions',
        artifact: 'Document',
        artifacts: 'Documents',
        source: 'System',
        sources: 'Sources',
        searchPlaceholder: 'Search matters, documents, legal positions...',
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
        goal: 'KPI',
        goals: 'KPIs',
        project: 'Process',
        projects: 'Processes',
        decision: 'Operational Decision',
        decisions: 'Operational Decisions',
        artifact: 'Work Item',
        artifacts: 'Work Items',
        source: 'System',
        sources: 'Systems',
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
        goal: 'Control',
        goals: 'Controls',
        project: 'Close Area',
        projects: 'Close Areas',
        decision: 'Finance Decision',
        decisions: 'Finance Decisions',
        artifact: 'Analysis',
        artifacts: 'Analyses',
        source: 'System',
        sources: 'Systems',
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

export function saveWorkspaceConfig(config: WorkspaceConfig) {
  getDb().prepare(`
    INSERT INTO workspace_config (id, config, enabled, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET config = excluded.config, enabled = excluded.enabled, updated_at = datetime('now')
  `).run(config.id, JSON.stringify(config), config.enabled ? 1 : 0);
}

export function setWorkspaceEnabled(id: string, enabled: boolean): WorkspaceConfig {
  const db = getDb();
  const row = db.prepare('SELECT config FROM workspace_config WHERE id = ?').get(id) as { config: string } | undefined;
  if (!row) throw new Error(`Workspace not found: ${id}`);

  const parsed = JSON.parse(row.config) as Partial<WorkspaceConfig>;
  const config = mergeWorkspaceConfig({ ...parsed, enabled });
  saveWorkspaceConfig(config);
  return config;
}

export function deleteWorkspaceConfig(id: string) {
  if (id === 'default') {
    throw new Error('The default workspace cannot be deleted');
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM workspace_config WHERE id = ?').get(id);
  if (!existing) throw new Error(`Workspace not found: ${id}`);

  db.prepare('DELETE FROM workspace_config WHERE id = ?').run(id);
}

export function addCustomTableToWorkspace(workspaceId: string, table: CustomTableConfig): WorkspaceConfig {
  const config = getWorkspaceConfig(workspaceId);
  const existing = config.customTables ?? [];
  if (existing.some((t) => t.id === table.id)) {
    throw new Error(`Table already exists in workspace config: ${table.id}`);
  }
  const updated: WorkspaceConfig = {
    ...config,
    customTables: [...existing, table],
  };
  saveWorkspaceConfig(updated);
  return updated;
}

export function getEntityTypeConfig(type: string): OntologyEntityType | undefined {
  return getWorkspaceConfig().ontology.entityTypes.find((t) => t.id === type);
}

export function normalizeLifecycleStage(stage: string | null | undefined): string | null {
  if (!stage) return null;
  const config = getWorkspaceConfig();
  const direct = config.lifecycle.stages.find((s) => s.id === stage);
  if (direct) return direct.id;
  const legacy = config.lifecycle.stages.find((s) => s.legacyIds?.includes(stage));
  return legacy?.id ?? stage;
}

export function isTerminalLifecycleStage(stage: string | null | undefined): boolean {
  const normalized = normalizeLifecycleStage(stage);
  if (!normalized) return false;
  const config = getWorkspaceConfig();
  return config.lifecycle.stages.some((s) => s.id === normalized && s.terminal);
}

export function relationForLifecycleStage(stage: string | null | undefined): string | null {
  const normalized = normalizeLifecycleStage(stage);
  if (!normalized) return null;
  const config = getWorkspaceConfig();
  const hit = config.lifecycle.stages.find((s) => s.id === normalized);
  return hit?.relation ?? normalized;
}
