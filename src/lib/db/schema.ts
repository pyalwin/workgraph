/**
 * Drizzle schema — typed view over the existing SQLite tables.
 *
 * Phase 0.1: this file mirrors the tables created by `src/lib/schema.ts`
 * (raw SQL via better-sqlite3) so we can write type-safe queries against
 * them. Schema CREATE / ALTER is still handled by the legacy `initSchema()`
 * for now. They must stay in lock-step until Phase 0 follow-ups move
 * migrations to `drizzle-kit`.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ─────── core domain ───────────────────────────────────────────────────────

export const goals = sqliteTable(
  'goals',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    keywords: text('keywords').notNull().default('[]'),
    status: text('status').notNull().default('active'),
    origin: text('origin').notNull().default('manual'),
    sortOrder: integer('sort_order'),
    itemCount: integer('item_count').default(0),
    sourceCount: integer('source_count').default(0),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
    // Phase 2.2 — measurable goals
    ownerUserId: text('owner_user_id'),
    targetMetric: text('target_metric'),
    targetValue: real('target_value'),
    targetAt: text('target_at'),
    aiConfidence: real('ai_confidence'),
    derivedFrom: text('derived_from').notNull().default('manual'),
    // OKR support
    kind: text('kind').notNull().default('goal'),           // 'goal' | 'objective' | 'key_result'
    parentId: text('parent_id'),                            // key_result.parent_id → objective.id
    projectKey: text('project_key'),                        // anchors AI-generated OKRs to their project
    // Phase 3 — workspace scoping. Nullable for backward compat with rows
    // predating the migration; backfill stamps existing rows to 'default'.
    workspaceId: text('workspace_id'),
  },
  (t) => [index('idx_goals_workspace').on(t.workspaceId)],
);

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  goalId: text('goal_id').references(() => goals.id),
  name: text('name').notNull(),
  source: text('source').notNull(),
  sourceId: text('source_id'),
  status: text('status').default('active'),
  metadata: text('metadata'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});

export const workItems = sqliteTable(
  'work_items',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    itemType: text('item_type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    summary: text('summary'),
    author: text('author'),
    status: text('status'),
    priority: text('priority'),
    url: text('url'),
    metadata: text('metadata'),
    enrichedAt: text('enriched_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at'),
    syncedAt: text('synced_at').default(sql`(datetime('now'))`),
    // Added by migrateWorkItems()
    traceRole: text('trace_role'),
    substance: text('substance'),
    traceEventAt: text('trace_event_at'),
  },
  (t) => [
    uniqueIndex('uniq_work_items_source').on(t.source, t.sourceId),
    index('idx_items_source').on(t.source),
    index('idx_items_status').on(t.status),
    index('idx_items_created').on(t.createdAt),
  ],
);

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    category: text('category'),
    // Phase 3 — workspace scoping. New tag rows are workspace-prefixed in
    // their id so the legacy UNIQUE(name, category) constraint still holds
    // across workspaces.
    workspaceId: text('workspace_id'),
  },
  (t) => [
    uniqueIndex('uniq_tags_name_category').on(t.name, t.category),
    index('idx_tags_workspace').on(t.workspaceId),
  ],
);

export const itemTags = sqliteTable(
  'item_tags',
  {
    itemId: text('item_id').references(() => workItems.id),
    tagId: text('tag_id').references(() => tags.id),
    confidence: real('confidence').default(1.0),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.tagId] }),
    index('idx_item_tags_item').on(t.itemId),
    index('idx_item_tags_tag').on(t.tagId),
  ],
);

export const links = sqliteTable(
  'links',
  {
    id: text('id').primaryKey(),
    sourceItemId: text('source_item_id').references(() => workItems.id),
    targetItemId: text('target_item_id').references(() => workItems.id),
    linkType: text('link_type').notNull(),
    confidence: real('confidence').default(1.0),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
  },
  (t) => [
    index('idx_links_source').on(t.sourceItemId),
    index('idx_links_target').on(t.targetItemId),
  ],
);

// ─────── metrics + sync state ──────────────────────────────────────────────

export const metricsSnapshots = sqliteTable(
  'metrics_snapshots',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id').references(() => goals.id),
    snapshotDate: text('snapshot_date').notNull(),
    totalItems: integer('total_items'),
    doneItems: integer('done_items'),
    activeItems: integer('active_items'),
    staleItems: integer('stale_items'),
    velocity7d: real('velocity_7d'),
    avgCycleTimeDays: real('avg_cycle_time_days'),
    crossRefCount: integer('cross_ref_count'),
    metadata: text('metadata'),
  },
  (t) => [
    uniqueIndex('uniq_metrics_goal_date').on(t.goalId, t.snapshotDate),
    index('idx_metrics_goal_date').on(t.goalId, t.snapshotDate),
  ],
);

export const syncLog = sqliteTable(
  'sync_log',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    itemsSynced: integer('items_synced').default(0),
    status: text('status').default('running'),
    error: text('error'),
  },
  (t) => [index('idx_sync_source').on(t.source, t.completedAt)],
);

export const workItemVersions = sqliteTable(
  'work_item_versions',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => workItems.id),
    changedFields: text('changed_fields').notNull(),
    snapshot: text('snapshot').notNull(),
    changedAt: text('changed_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [
    index('idx_versions_item').on(t.itemId),
    index('idx_versions_changed').on(t.changedAt),
  ],
);

// ─────── config ────────────────────────────────────────────────────────────

export const syncConfig = sqliteTable('sync_config', {
  id: text('id').primaryKey().default('default'),
  config: text('config').notNull().default('{}'),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

export const workspaceConfig = sqliteTable('workspace_config', {
  id: text('id').primaryKey().default('default'),
  config: text('config').notNull().default('{}'),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  // Added by migrateWorkspaceConfig()
  enabled: integer('enabled').notNull().default(1),
  // Phase 4: binds the workspace to the WorkOS-authenticated user that owns
  // it. NULL means "unclaimed" — the first user who reads workspaces will
  // claim the alphabetically-first unclaimed row.
  authUserId: text('auth_user_id'),
});

export const workspaceConnectorConfigs = sqliteTable(
  'workspace_connector_configs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    slot: text('slot').notNull(),
    source: text('source').notNull(),
    serverId: text('server_id').notNull(),
    transport: text('transport').notNull(),
    config: text('config').notNull().default('{}'),
    status: text('status').notNull().default('configured'),
    lastTestedAt: text('last_tested_at'),
    lastError: text('last_error'),
    lastSyncStartedAt: text('last_sync_started_at'),
    lastSyncCompletedAt: text('last_sync_completed_at'),
    lastSyncStatus: text('last_sync_status'),
    lastSyncItems: integer('last_sync_items'),
    lastSyncError: text('last_sync_error'),
    lastSyncLog: text('last_sync_log'),
    // Direct-API connector support (added by additive migration in
    // init-schema-async.ts). syncMarker is the per-connector cursor for
    // incremental sync (Drive startPageToken / Calendar nextSyncToken /
    // Gmail historyId). oauthProvider keys into the shared OAuth provider
    // table (e.g. 'google' for gmail+gdrive+gcal). Both nullable.
    syncMarker: text('sync_marker'),
    oauthProvider: text('oauth_provider'),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (t) => [
    uniqueIndex('uniq_connector_workspace_slot').on(t.workspaceId, t.slot),
    index('idx_connector_configs_workspace').on(t.workspaceId),
  ],
);

// ─────── OAuth ─────────────────────────────────────────────────────────────

export const oauthTokens = sqliteTable(
  'oauth_tokens',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    source: text('source').notNull(),
    accessTokenEnc: text('access_token_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc'),
    metadataEnc: text('metadata_enc'),
    tokenType: text('token_type').notNull().default('Bearer'),
    scope: text('scope'),
    expiresAt: text('expires_at'),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (t) => [
    uniqueIndex('uniq_oauth_workspace_source').on(t.workspaceId, t.source),
    index('idx_oauth_tokens_workspace').on(t.workspaceId),
  ],
);

export const oauthState = sqliteTable(
  'oauth_state',
  {
    state: text('state').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    source: text('source').notNull(),
    slot: text('slot').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    returnTo: text('return_to'),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
  },
  (t) => [index('idx_oauth_state_created').on(t.createdAt)],
);

export const oauthClients = sqliteTable(
  'oauth_clients',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    clientIdEnc: text('client_id_enc').notNull(),
    clientSecretEnc: text('client_secret_enc'),
    registrationResponseEnc: text('registration_response_enc'),
    authorizationEndpoint: text('authorization_endpoint'),
    tokenEndpoint: text('token_endpoint'),
    registeredAt: text('registered_at').default(sql`(datetime('now'))`),
  },
  (t) => [uniqueIndex('uniq_oauth_clients_source_redirect').on(t.source, t.redirectUri)],
);

// ─────── project summaries ────────────────────────────────────────────────

export const projectSummaries = sqliteTable('project_summaries', {
  projectKey: text('project_key').primaryKey(),
  name: text('name').notNull(),
  recap: text('recap'),
  itemCount: integer('item_count').default(0),
  doneCount: integer('done_count').default(0),
  activeCount: integer('active_count').default(0),
  blockerCount: integer('blocker_count').default(0),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  // Added by migrateProjectSummaries()
  summaryGeneratedAt: text('summary_generated_at'),
  // README — stable, descriptive document, separate from `recap` (status-y)
  readme: text('readme'),
  readmeGeneratedAt: text('readme_generated_at'),
  // 'manual' | 'jira-sync' | 'connector-attach' — diagnostic provenance
  createdVia: text('created_via'),
});

// ─────── chunks + embeddings ──────────────────────────────────────────────

export const itemChunks = sqliteTable(
  'item_chunks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: text('item_id')
      .notNull()
      .references(() => workItems.id),
    chunkType: text('chunk_type').notNull(),
    chunkText: text('chunk_text').notNull(),
    position: integer('position').notNull().default(0),
    tokenCount: integer('token_count'),
    metadata: text('metadata'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [
    index('idx_item_chunks_item').on(t.itemId),
    index('idx_item_chunks_type').on(t.chunkType),
  ],
);

export const chunkEmbeddingsMeta = sqliteTable(
  'chunk_embeddings_meta',
  {
    chunkId: integer('chunk_id')
      .notNull()
      .references(() => itemChunks.id),
    model: text('model').notNull(),
    dim: integer('dim').notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [
    primaryKey({ columns: [t.chunkId, t.model] }),
    index('idx_chunk_emb_meta_model').on(t.model),
  ],
);

// NB: vec_chunks_text is a sqlite-vec virtual table; it's managed by raw
// SQL in src/lib/schema.ts (createVectorTables) and isn't represented here.
// Drizzle doesn't have a clean abstraction for `CREATE VIRTUAL TABLE … USING vec0`.

// ─────── workstreams + decisions ──────────────────────────────────────────

export const workstreams = sqliteTable('workstreams', {
  id: text('id').primaryKey(),
  narrative: text('narrative'),
  timelineEvents: text('timeline_events'),
  earliestAt: text('earliest_at'),
  latestAt: text('latest_at'),
  generatedAt: text('generated_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at'),
});

export const workstreamItems = sqliteTable(
  'workstream_items',
  {
    workstreamId: text('workstream_id')
      .notNull()
      .references(() => workstreams.id),
    itemId: text('item_id')
      .notNull()
      .references(() => workItems.id),
    isSeed: integer('is_seed').notNull().default(0),
    isTerminal: integer('is_terminal').notNull().default(0),
    roleInWorkstream: text('role_in_workstream'),
    eventAt: text('event_at'),
  },
  (t) => [
    primaryKey({ columns: [t.workstreamId, t.itemId] }),
    index('idx_workstream_items_item').on(t.itemId),
    index('idx_workstream_items_ws').on(t.workstreamId),
  ],
);

export const decisions = sqliteTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => workItems.id),
    workstreamId: text('workstream_id').references(() => workstreams.id),
    title: text('title').notNull(),
    decidedAt: text('decided_at').notNull(),
    decidedBy: text('decided_by'),
    status: text('status').default('active'),
    summary: text('summary'),
    generatedAt: text('generated_at'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at'),
  },
  (t) => [
    uniqueIndex('uniq_decisions_item').on(t.itemId),
    index('idx_decisions_decided_at').on(t.decidedAt),
    index('idx_decisions_workstream').on(t.workstreamId),
  ],
);

export const decisionItems = sqliteTable(
  'decision_items',
  {
    decisionId: text('decision_id')
      .notNull()
      .references(() => decisions.id),
    itemId: text('item_id')
      .notNull()
      .references(() => workItems.id),
    relation: text('relation').notNull(),
    eventAt: text('event_at'),
  },
  (t) => [
    primaryKey({ columns: [t.decisionId, t.itemId, t.relation] }),
    index('idx_decision_items_item').on(t.itemId),
    index('idx_decision_items_decision').on(t.decisionId),
  ],
);

// ─────── entities (configurable ontology) ─────────────────────────────────

export const entities = sqliteTable(
  'entities',
  {
    id: text('id').primaryKey(),
    canonicalForm: text('canonical_form').notNull(),
    entityType: text('entity_type').notNull(),
    aliases: text('aliases').notNull().default('[]'),
    metadata: text('metadata'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at'),
    // Phase 3 — workspace scoping. New entity rows are workspace-prefixed
    // in their id so the legacy UNIQUE(canonical_form, entity_type)
    // constraint still holds across workspaces.
    workspaceId: text('workspace_id'),
  },
  (t) => [
    uniqueIndex('uniq_entities_canonical_type').on(t.canonicalForm, t.entityType),
    index('idx_entities_type').on(t.entityType),
    index('idx_entities_canonical').on(t.canonicalForm),
    index('idx_entities_workspace').on(t.workspaceId),
  ],
);

export const entityMentions = sqliteTable(
  'entity_mentions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: text('item_id')
      .notNull()
      .references(() => workItems.id),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id),
    surfaceForm: text('surface_form').notNull(),
    startOffset: integer('start_offset'),
    endOffset: integer('end_offset'),
    confidence: real('confidence').notNull().default(1.0),
  },
  (t) => [
    uniqueIndex('uniq_entity_mentions_item_entity_offset').on(
      t.itemId,
      t.entityId,
      t.startOffset,
      t.surfaceForm,
    ),
    index('idx_entity_mentions_item').on(t.itemId),
    index('idx_entity_mentions_entity').on(t.entityId),
  ],
);

// ─────── link evidence ────────────────────────────────────────────────────

export const itemLinksChunks = sqliteTable(
  'item_links_chunks',
  {
    linkId: text('link_id')
      .notNull()
      .references(() => links.id),
    sourceChunkId: integer('source_chunk_id').references(() => itemChunks.id),
    targetChunkId: integer('target_chunk_id').references(() => itemChunks.id),
    signal: text('signal').notNull(),
    score: real('score').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.linkId, t.sourceChunkId, t.targetChunkId, t.signal] }),
    index('idx_item_links_chunks_link').on(t.linkId),
  ],
);

// ─────── AI provider config ───────────────────────────────────────────────

export const aiProviderConfigs = sqliteTable('ai_provider_configs', {
  providerId: text('provider_id').primaryKey(),
  apiKeyEnc: text('api_key_enc'),
  baseUrl: text('base_url'),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ─────── system / Inngest heartbeat ───────────────────────────────────────

export const systemHealth = sqliteTable(
  'system_health',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    detail: text('detail'),
    ranAt: text('ran_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [index('idx_system_health_ran').on(t.ranAt)],
);

// ─────── action items + anomalies + identity mapping ──────────────────────

export const actionItems = sqliteTable(
  'action_items',
  {
    id: text('id').primaryKey(),
    sourceItemId: text('source_item_id')
      .notNull()
      .references(() => workItems.id),
    text: text('text').notNull(),
    assignee: text('assignee'),
    dueAt: text('due_at'),
    userPriority: text('user_priority'),
    aiPriority: text('ai_priority'),
    state: text('state').notNull().default('open'),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (t) => [
    index('idx_action_items_source').on(t.sourceItemId),
    index('idx_action_items_assignee').on(t.assignee),
    index('idx_action_items_state').on(t.state),
  ],
);

export const anomalies = sqliteTable(
  'anomalies',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    scope: text('scope').notNull(),
    kind: text('kind').notNull(),
    severity: real('severity').notNull(),
    evidenceItemIds: text('evidence_item_ids').notNull(),
    explanation: text('explanation'),
    detectedAt: text('detected_at').notNull().default(sql`(datetime('now'))`),
    resolvedAt: text('resolved_at'),
    dismissedByUser: integer('dismissed_by_user').notNull().default(0),
  },
  (t) => [
    uniqueIndex('uniq_anomalies_workspace_scope_kind').on(t.workspaceId, t.scope, t.kind),
    index('idx_anomalies_workspace').on(t.workspaceId),
    index('idx_anomalies_open').on(t.workspaceId, t.resolvedAt, t.dismissedByUser),
  ],
);

export const workspaceUserAliases = sqliteTable(
  'workspace_user_aliases',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    authUserId: text('auth_user_id').notNull(),
    source: text('source').notNull(),
    alias: text('alias').notNull(),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
  },
  (t) => [
    uniqueIndex('uniq_aliases_workspace_source_alias').on(t.workspaceId, t.source, t.alias),
    index('idx_aliases_user').on(t.workspaceId, t.authUserId),
  ],
);

// ─────── Almanac Local Agent ──────────────────────────────────────────────

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    hostname: text('hostname'),
    platform: text('platform'),
    version: text('version'),
    claudeAvailable: integer('claude_available'),
    claudeVersion: text('claude_version'),
    pairedAt: text('paired_at').notNull().default(sql`(datetime('now'))`),
    lastSeenAt: text('last_seen_at'),
  },
  (t) => [
    index('idx_agents_workspace_id').on(t.workspaceId),
    index('idx_agents_user_id').on(t.userId),
  ],
);

export const agentPairing = sqliteTable(
  'agent_pairing',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id'),
    userId: text('user_id'),
    userCode: text('user_code').notNull(),
    status: text('status').notNull().default('pending'),
    agentId: text('agent_id'),
    agentTokenRaw: text('agent_token_raw'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [
    index('idx_agent_pairing_user_code').on(t.userCode),
    index('idx_agent_pairing_expires').on(t.expiresAt),
  ],
);

export const agentJobs = sqliteTable(
  'agent_jobs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('queued'),
    params: text('params').notNull().default('{}'),
    result: text('result'),
    assignedTo: text('assigned_to'),
    attempt: integer('attempt').notNull().default(0),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('idx_agent_jobs_status_kind').on(t.status, t.kind, t.createdAt),
    index('idx_agent_jobs_workspace').on(t.workspaceId),
  ],
);

export const jobEvents = sqliteTable(
  'job_events',
  {
    jobId: text('job_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: text('payload').notNull().default('{}'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.seq] }),
    index('idx_job_events_job_created').on(t.jobId, t.createdAt),
  ],
);

export const almanacDocs = sqliteTable(
  'almanac_docs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    projectKey: text('project_key').notNull(),
    repoKey: text('repo_key').notNull(),
    ref: text('ref').notNull(),
    status: text('status').notNull().default('outlining'),
    outline: text('outline'),
    productSummary: text('product_summary'),
    title: text('title'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    completedAt: text('completed_at'),
  },
  (t) => [
    index('idx_almanac_docs_workspace').on(t.workspaceId),
    index('idx_almanac_docs_project').on(t.workspaceId, t.projectKey),
  ],
);

export const almanacDocSections = sqliteTable(
  'almanac_doc_sections',
  {
    docId: text('doc_id').notNull(),
    sectionId: text('section_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    title: text('title').notNull(),
    markdown: text('markdown'),
    status: text('status').notNull().default('queued'),
    jobId: text('job_id'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
    regeneratedAt: text('regenerated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.docId, t.sectionId] }),
    index('idx_almanac_sections_doc').on(t.docId, t.ordinal),
  ],
);

export const projectGithubConfigs = sqliteTable(
  'project_github_configs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    projectKey: text('project_key').notNull(),
    repo: text('repo').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    pathPrefixes: text('path_prefixes').notNull().default('[]'),
    ticketPrefixes: text('ticket_prefixes').notNull().default('[]'),
    enabled: integer('enabled').notNull().default(1),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [
    uniqueIndex('uniq_project_github_configs').on(t.workspaceId, t.projectKey, t.repo),
    index('idx_project_github_configs_project').on(t.workspaceId, t.projectKey),
  ],
);

// Per-project backlog: AI-suggested + user-managed todos and feature ideas.
// Stable id (sha1 of project_key|kind|normalized title) makes regen idempotent —
// `INSERT OR IGNORE` on regen never overwrites user state.
export const projectBacklogItems = sqliteTable(
  'project_backlog_items',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    projectKey: text('project_key').notNull(),
    kind: text('kind').notNull(),                            // 'todo' | 'feature'
    title: text('title').notNull(),
    description: text('description'),
    source: text('source').notNull().default('manual'),      // 'almanac' | 'manual'
    state: text('state').notNull().default('open'),          // 'open' | 'in_progress' | 'done' | 'dismissed'
    aiGenerated: integer('ai_generated').notNull().default(0),
    evidence: text('evidence'),                              // JSON: {paths, refs, commits}
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
    doneAt: text('done_at'),
    dismissedAt: text('dismissed_at'),
  },
  (t) => [
    index('idx_project_backlog_project').on(t.workspaceId, t.projectKey, t.state),
    index('idx_project_backlog_kind').on(t.workspaceId, t.projectKey, t.kind),
  ],
);

// Generic project↔connector bindings. Each row binds a project to a slice of a
// workspace-level connector (JIRA project / GitHub repo / Slack channel /
// Notion DB). See docs/superpowers/specs/2026-05-07-decouple-project-from-jira-design.md.
export const projectConnectors = sqliteTable(
  'project_connectors',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    projectKey: text('project_key').notNull(),
    kind: text('kind').notNull(),                            // 'jira' | 'github' | 'slack' | 'notion'
    ref: text('ref').notNull(),                              // external slice id, kind-specific
    config: text('config').notNull().default('{}'),          // kind-specific JSON
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [
    uniqueIndex('uniq_project_connectors').on(t.workspaceId, t.projectKey, t.kind, t.ref),
    index('idx_project_connectors_project').on(t.workspaceId, t.projectKey),
    index('idx_project_connectors_ref').on(t.workspaceId, t.kind, t.ref),
  ],
);

// pipeline_links: many-to-many between custom pipeline rows
// (deals/investors/candidates) and ingested work_items (gmail thread,
// gcal event, gdrive file). Auto-populated by the post-ingest matching
// helper; manual pin/unpin overrides via match_reason='manual'. The
// unique index over (pipeline_table, pipeline_row_id, item_source,
// item_source_id) makes re-ingest idempotent. See
// docs/superpowers/specs/2026-05-10-founder-workspace-and-direct-api-gsuite-design.md
// section 4.1.
export const pipelineLinks = sqliteTable(
  'pipeline_links',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    pipelineTable: text('pipeline_table').notNull(),         // 'deals' | 'investors' | 'candidates'
    pipelineRowId: text('pipeline_row_id').notNull(),
    itemSource: text('item_source').notNull(),               // 'gmail' | 'gcal' | 'gdrive' (extensible)
    itemSourceId: text('item_source_id').notNull(),
    matchReason: text('match_reason').notNull(),             // 'domain_match' | 'email_match' | 'title_match' | 'manual'
    confidence: real('confidence').notNull().default(0.7),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
  },
  (t) => [
    index('idx_pipeline_links_row').on(t.pipelineTable, t.pipelineRowId),
    index('idx_pipeline_links_item').on(t.itemSource, t.itemSourceId),
    uniqueIndex('uq_pipeline_links').on(
      t.pipelineTable,
      t.pipelineRowId,
      t.itemSource,
      t.itemSourceId,
    ),
  ],
);

// Phase 3 — chat threads/messages now mirrored in Drizzle so workspace-
// scoped queries can be type-checked. Schema CREATE remains in
// init-schema-async.ts (raw SQL).
export const chatThreads = sqliteTable(
  'chat_threads',
  {
    id: text('id').primaryKey(),
    title: text('title'),
    workspaceId: text('workspace_id'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [
    index('idx_chat_threads_updated').on(t.updatedAt),
    index('idx_chat_threads_workspace').on(t.workspaceId),
  ],
);

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    parts: text('parts').notNull(),
    sequence: integer('sequence').notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [index('idx_chat_messages_thread').on(t.threadId, t.sequence)],
);

// Convenience: every table re-exported as `schema` for `drizzle({ schema })`.
export const schema = {
  goals,
  projects,
  workItems,
  tags,
  itemTags,
  links,
  metricsSnapshots,
  syncLog,
  workItemVersions,
  syncConfig,
  workspaceConfig,
  workspaceConnectorConfigs,
  oauthTokens,
  oauthState,
  oauthClients,
  projectSummaries,
  itemChunks,
  chunkEmbeddingsMeta,
  workstreams,
  workstreamItems,
  decisions,
  decisionItems,
  entities,
  entityMentions,
  itemLinksChunks,
  aiProviderConfigs,
  systemHealth,
  actionItems,
  anomalies,
  workspaceUserAliases,
  agents,
  agentPairing,
  agentJobs,
  jobEvents,
  almanacDocs,
  almanacDocSections,
  projectGithubConfigs,
  projectConnectors,
  projectBacklogItems,
  pipelineLinks,
  chatThreads,
  chatMessages,
};
