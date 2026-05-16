import { getLibsqlDb } from './libsql';

/**
 * Async schema bootstrap for the libSQL path. Mirrors the full set of CREATE
 * TABLE / INDEX statements from the legacy sync src/lib/schema.ts so that
 * code running on Turso has every table available.
 *
 * Vector tables (item_chunks_text using sqlite-vec) are NOT in here — they're
 * incompatible with Turso. Vector search is migrated to libSQL native vector
 * functions in a separate wave; the local-mode path in src/lib/db.ts still
 * loads sqlite-vec for self-hosted dev installs.
 *
 * Idempotent — safe to re-run. Uses CREATE IF NOT EXISTS throughout.
 */

let _initPromise: Promise<void> | null = null;

const DDL = `
  -- Core entities
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    keywords TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    origin TEXT NOT NULL DEFAULT 'manual',
    sort_order INTEGER,
    item_count INTEGER DEFAULT 0,
    source_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    owner_user_id TEXT,
    target_metric TEXT,
    target_value REAL,
    target_at TEXT,
    ai_confidence REAL,
    derived_from TEXT NOT NULL DEFAULT 'manual',
    kind TEXT NOT NULL DEFAULT 'goal',
    parent_id TEXT,
    project_key TEXT,
    workspace_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_goals_kind ON goals(kind);
  CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_id);
  CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project_key);
  CREATE INDEX IF NOT EXISTS idx_goals_workspace ON goals(workspace_id);

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    goal_id TEXT REFERENCES goals(id),
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT,
    status TEXT DEFAULT 'active',
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    summary TEXT,
    author TEXT,
    status TEXT,
    priority TEXT,
    url TEXT,
    metadata TEXT,
    enriched_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    synced_at TEXT DEFAULT (datetime('now')),
    trace_role TEXT,
    substance TEXT,
    trace_event_at TEXT,
    pr_summary TEXT,
    pr_summary_generated_at TEXT,
    gap_analysis TEXT,
    gap_analysis_generated_at TEXT,
    UNIQUE(source, source_id)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    workspace_id TEXT,
    UNIQUE(name, category)
  );
  CREATE INDEX IF NOT EXISTS idx_tags_workspace ON tags(workspace_id);

  CREATE TABLE IF NOT EXISTS item_tags (
    item_id TEXT REFERENCES work_items(id),
    tag_id TEXT REFERENCES tags(id),
    confidence REAL DEFAULT 1.0,
    PRIMARY KEY (item_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    source_item_id TEXT REFERENCES work_items(id),
    target_item_id TEXT REFERENCES work_items(id),
    link_type TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS metrics_snapshots (
    id TEXT PRIMARY KEY,
    goal_id TEXT REFERENCES goals(id),
    snapshot_date TEXT NOT NULL,
    total_items INTEGER,
    done_items INTEGER,
    active_items INTEGER,
    stale_items INTEGER,
    velocity_7d REAL,
    avg_cycle_time_days REAL,
    cross_ref_count INTEGER,
    metadata TEXT,
    UNIQUE(goal_id, snapshot_date)
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    items_synced INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running',
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS work_item_versions (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES work_items(id),
    changed_fields TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    config TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workspace_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    auth_user_id TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_config_auth_user ON workspace_config(auth_user_id);

  CREATE TABLE IF NOT EXISTS workspace_connector_configs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    source TEXT NOT NULL,
    server_id TEXT NOT NULL,
    transport TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'configured',
    last_tested_at TEXT,
    last_error TEXT,
    last_sync_started_at TEXT,
    last_sync_completed_at TEXT,
    last_sync_status TEXT,
    last_sync_items INTEGER,
    last_sync_error TEXT,
    last_sync_log TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(workspace_id, slot)
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source TEXT NOT NULL,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT,
    metadata_enc TEXT,
    token_type TEXT NOT NULL DEFAULT 'Bearer',
    scope TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(workspace_id, source)
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_workspace ON oauth_tokens(workspace_id);

  CREATE TABLE IF NOT EXISTS oauth_state (
    state TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source TEXT NOT NULL,
    slot TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    return_to TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_state_created ON oauth_state(created_at);

  CREATE TABLE IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    client_id_enc TEXT NOT NULL,
    client_secret_enc TEXT,
    registration_response_enc TEXT,
    authorization_endpoint TEXT,
    token_endpoint TEXT,
    registered_at TEXT DEFAULT (datetime('now')),
    UNIQUE(source, redirect_uri)
  );

  CREATE TABLE IF NOT EXISTS project_summaries (
    project_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    recap TEXT,
    item_count INTEGER DEFAULT 0,
    done_count INTEGER DEFAULT 0,
    active_count INTEGER DEFAULT 0,
    blocker_count INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    summary_generated_at TEXT,
    readme TEXT,
    readme_generated_at TEXT,
    created_via TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_items_source ON work_items(source);
  CREATE INDEX IF NOT EXISTS idx_items_status ON work_items(status);
  CREATE INDEX IF NOT EXISTS idx_items_created ON work_items(created_at);
  CREATE INDEX IF NOT EXISTS idx_item_tags_item ON item_tags(item_id);
  CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);
  CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_item_id);
  CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_item_id);
  CREATE INDEX IF NOT EXISTS idx_metrics_goal_date ON metrics_snapshots(goal_id, snapshot_date);
  CREATE INDEX IF NOT EXISTS idx_sync_source ON sync_log(source, completed_at);
  CREATE INDEX IF NOT EXISTS idx_connector_configs_workspace ON workspace_connector_configs(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_versions_item ON work_item_versions(item_id);
  CREATE INDEX IF NOT EXISTS idx_versions_changed ON work_item_versions(changed_at);

  CREATE TABLE IF NOT EXISTS item_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES work_items(id),
    chunk_type TEXT NOT NULL,
    chunk_text TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_item_chunks_item ON item_chunks(item_id);
  CREATE INDEX IF NOT EXISTS idx_item_chunks_type ON item_chunks(chunk_type);

  CREATE TABLE IF NOT EXISTS chunk_embeddings_meta (
    chunk_id INTEGER NOT NULL REFERENCES item_chunks(id),
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chunk_id, model)
  );
  CREATE INDEX IF NOT EXISTS idx_chunk_emb_meta_model ON chunk_embeddings_meta(model);

  -- libSQL native vector storage. Replaces the local-only sqlite-vec
  -- vec_chunks_text virtual table. The blob holds a packed Float32 array;
  -- libSQL's vector() function inserts from a JSON-array literal and
  -- vector_distance_cos() reads the same blob for ORDER BY queries.
  CREATE TABLE IF NOT EXISTS chunk_vectors (
    chunk_id INTEGER PRIMARY KEY REFERENCES item_chunks(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL,
    dim INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workstreams (
    id TEXT PRIMARY KEY,
    narrative TEXT,
    timeline_events TEXT,
    earliest_at TEXT,
    latest_at TEXT,
    generated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS workstream_items (
    workstream_id TEXT NOT NULL REFERENCES workstreams(id),
    item_id TEXT NOT NULL REFERENCES work_items(id),
    is_seed INTEGER NOT NULL DEFAULT 0,
    is_terminal INTEGER NOT NULL DEFAULT 0,
    role_in_workstream TEXT,
    event_at TEXT,
    PRIMARY KEY (workstream_id, item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_workstream_items_item ON workstream_items(item_id);
  CREATE INDEX IF NOT EXISTS idx_workstream_items_ws ON workstream_items(workstream_id);

  CREATE TABLE IF NOT EXISTS ai_provider_configs (
    provider_id TEXT PRIMARY KEY,
    api_key_enc TEXT,
    base_url TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_dismissals (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workspace_ai_usage (
    workspace_id TEXT NOT NULL,
    period TEXT NOT NULL,
    task TEXT NOT NULL,
    call_count INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd_micros INTEGER NOT NULL DEFAULT 0,
    last_at TEXT,
    PRIMARY KEY (workspace_id, period, task)
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_period ON workspace_ai_usage(period);

  CREATE TABLE IF NOT EXISTS workspace_agents (
    agent_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    pairing_token_enc TEXT NOT NULL,
    hostname TEXT,
    platform TEXT,
    version TEXT,
    status TEXT NOT NULL DEFAULT 'offline',
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_agents_user ON workspace_agents(user_id);
  CREATE INDEX IF NOT EXISTS idx_agents_workspace ON workspace_agents(workspace_id);

  CREATE TABLE IF NOT EXISTS system_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    detail TEXT,
    ran_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_system_health_ran ON system_health(ran_at);

  CREATE TABLE IF NOT EXISTS action_items (
    id TEXT PRIMARY KEY,
    source_item_id TEXT NOT NULL REFERENCES work_items(id),
    text TEXT NOT NULL,
    assignee TEXT,
    due_at TEXT,
    user_priority TEXT,
    ai_priority TEXT,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_action_items_source ON action_items(source_item_id);
  CREATE INDEX IF NOT EXISTS idx_action_items_assignee ON action_items(assignee);
  CREATE INDEX IF NOT EXISTS idx_action_items_state ON action_items(state);

  CREATE TABLE IF NOT EXISTS anomalies (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity REAL NOT NULL,
    evidence_item_ids TEXT NOT NULL,
    explanation TEXT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    dismissed_by_user INTEGER NOT NULL DEFAULT 0,
    action_item_id TEXT,
    jira_issue_key TEXT,
    handled_at TEXT,
    handled_note TEXT,
    UNIQUE(workspace_id, scope, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_anomalies_workspace ON anomalies(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_anomalies_open ON anomalies(workspace_id, resolved_at, dismissed_by_user);

  CREATE TABLE IF NOT EXISTS workspace_user_aliases (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    auth_user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    alias TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(workspace_id, source, alias)
  );
  CREATE INDEX IF NOT EXISTS idx_aliases_user ON workspace_user_aliases(workspace_id, auth_user_id);

  CREATE TABLE IF NOT EXISTS item_links_chunks (
    link_id TEXT NOT NULL REFERENCES links(id),
    source_chunk_id INTEGER REFERENCES item_chunks(id),
    target_chunk_id INTEGER REFERENCES item_chunks(id),
    signal TEXT NOT NULL,
    score REAL NOT NULL,
    PRIMARY KEY (link_id, source_chunk_id, target_chunk_id, signal)
  );
  CREATE INDEX IF NOT EXISTS idx_item_links_chunks_link ON item_links_chunks(link_id);

  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES work_items(id),
    workstream_id TEXT REFERENCES workstreams(id),
    title TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    decided_by TEXT,
    status TEXT DEFAULT 'active',
    summary TEXT,
    generated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    UNIQUE(item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_decisions_decided_at ON decisions(decided_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_workstream ON decisions(workstream_id);

  CREATE TABLE IF NOT EXISTS decision_items (
    decision_id TEXT NOT NULL REFERENCES decisions(id),
    item_id TEXT NOT NULL REFERENCES work_items(id),
    relation TEXT NOT NULL,
    event_at TEXT,
    PRIMARY KEY (decision_id, item_id, relation)
  );
  CREATE INDEX IF NOT EXISTS idx_decision_items_item ON decision_items(item_id);
  CREATE INDEX IF NOT EXISTS idx_decision_items_decision ON decision_items(decision_id);

  CREATE TABLE IF NOT EXISTS issue_trails (
    id TEXT PRIMARY KEY,
    issue_item_id TEXT REFERENCES work_items(id),
    pr_ref TEXT NOT NULL,
    pr_url TEXT,
    repo TEXT,
    kind TEXT NOT NULL,
    actor TEXT,
    title TEXT,
    body TEXT,
    state TEXT,
    diff_summary TEXT,
    occurred_at TEXT NOT NULL,
    match_status TEXT NOT NULL DEFAULT 'matched',
    match_confidence REAL,
    match_evidence TEXT,
    raw_metadata TEXT,
    functional_summary TEXT,
    functional_summary_generated_at TEXT,
    diff_text TEXT,
    diff_text_fetched_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pr_ref, kind, occurred_at)
  );
  CREATE INDEX IF NOT EXISTS idx_issue_trails_issue ON issue_trails(issue_item_id);
  CREATE INDEX IF NOT EXISTS idx_issue_trails_pr ON issue_trails(pr_ref);
  CREATE INDEX IF NOT EXISTS idx_issue_trails_occurred ON issue_trails(occurred_at);

  CREATE TABLE IF NOT EXISTS orphan_pr_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_ref TEXT NOT NULL,
    candidate_item_id TEXT NOT NULL REFERENCES work_items(id),
    score REAL NOT NULL,
    signals TEXT NOT NULL,
    computed_at TEXT NOT NULL DEFAULT (datetime('now')),
    dismissed_at TEXT,
    UNIQUE(pr_ref, candidate_item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_orphan_pr_candidates_ref ON orphan_pr_candidates(pr_ref);

  CREATE TABLE IF NOT EXISTS issue_decisions (
    id TEXT PRIMARY KEY,
    issue_item_id TEXT NOT NULL REFERENCES work_items(id),
    trail_id TEXT REFERENCES issue_trails(id),
    text TEXT NOT NULL,
    rationale TEXT,
    actor TEXT,
    decided_at TEXT,
    ai_confidence REAL,
    derived_from TEXT NOT NULL DEFAULT 'ai_pr_review',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_issue_decisions_issue ON issue_decisions(issue_item_id);

  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    canonical_form TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    workspace_id TEXT,
    UNIQUE(canonical_form, entity_type)
  );
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
  CREATE INDEX IF NOT EXISTS idx_entities_canonical ON entities(canonical_form);
  CREATE INDEX IF NOT EXISTS idx_entities_workspace ON entities(workspace_id);

  CREATE TABLE IF NOT EXISTS entity_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES work_items(id),
    entity_id TEXT NOT NULL REFERENCES entities(id),
    surface_form TEXT NOT NULL,
    start_offset INTEGER,
    end_offset INTEGER,
    confidence REAL NOT NULL DEFAULT 1.0,
    UNIQUE(item_id, entity_id, start_offset, surface_form)
  );
  CREATE INDEX IF NOT EXISTS idx_entity_mentions_item ON entity_mentions(item_id);
  CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id);

  CREATE TABLE IF NOT EXISTS ai_task_backends (
    task TEXT PRIMARY KEY,
    backend_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_threads (
    id TEXT PRIMARY KEY,
    title TEXT,
    workspace_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_threads_updated ON chat_threads(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_chat_threads_workspace ON chat_threads(workspace_id);

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    parts TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, sequence);

  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Almanac Local Agent ──────────────────────────────────────────────────
  -- agents: one row per paired local-agent install.
  -- Replaces/extends the older workspace_agents scaffold; that table remains
  -- for the legacy agent-status UI query until it is migrated.
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    hostname TEXT,
    platform TEXT,
    version TEXT,
    claude_available INTEGER,
    claude_version TEXT,
    paired_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agents_workspace_id ON agents(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);

  -- agent_pairing: transient rows used during the device-flow pairing dance.
  -- Deleted or expires; confirmed rows result in an agents row.
  CREATE TABLE IF NOT EXISTS agent_pairing (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    user_id TEXT,
    user_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    agent_id TEXT,
    agent_token_raw TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_agent_pairing_user_code ON agent_pairing(user_code);
  CREATE INDEX IF NOT EXISTS idx_agent_pairing_expires ON agent_pairing(expires_at);

  -- agent_jobs: the job queue.
  CREATE TABLE IF NOT EXISTS agent_jobs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    params TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    assigned_to TEXT REFERENCES agents(id),
    attempt INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_status_kind ON agent_jobs(status, kind, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_workspace ON agent_jobs(workspace_id);

  -- job_events: streaming events emitted by the agent during a job.
  CREATE TABLE IF NOT EXISTS job_events (
    job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (job_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_job_events_job_created ON job_events(job_id, created_at);

  -- almanac_docs: one row per generated document.
  CREATE TABLE IF NOT EXISTS almanac_docs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    repo_key TEXT NOT NULL,
    ref TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'outlining',
    outline TEXT,
    product_summary TEXT,
    title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_almanac_docs_workspace ON almanac_docs(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_almanac_docs_project ON almanac_docs(workspace_id, project_key);

  -- almanac_doc_sections: one row per section within a document.
  CREATE TABLE IF NOT EXISTS almanac_doc_sections (
    doc_id TEXT NOT NULL REFERENCES almanac_docs(id) ON DELETE CASCADE,
    section_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    title TEXT NOT NULL,
    markdown TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    job_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    regenerated_at TEXT,
    PRIMARY KEY (doc_id, section_id)
  );
  CREATE INDEX IF NOT EXISTS idx_almanac_sections_doc ON almanac_doc_sections(doc_id, ordinal);

  CREATE TABLE IF NOT EXISTS project_github_configs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    repo TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    path_prefixes TEXT NOT NULL DEFAULT '[]',
    ticket_prefixes TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_github_configs ON project_github_configs(workspace_id, project_key, repo);
  CREATE INDEX IF NOT EXISTS idx_project_github_configs_project ON project_github_configs(workspace_id, project_key);

  CREATE TABLE IF NOT EXISTS project_connectors (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_connectors ON project_connectors(workspace_id, project_key, kind, ref);
  CREATE INDEX IF NOT EXISTS idx_project_connectors_project ON project_connectors(workspace_id, project_key);
  CREATE INDEX IF NOT EXISTS idx_project_connectors_ref ON project_connectors(workspace_id, kind, ref);

  CREATE TABLE IF NOT EXISTS project_backlog_items (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    state TEXT NOT NULL DEFAULT 'open',
    ai_generated INTEGER NOT NULL DEFAULT 0,
    evidence TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    done_at TEXT,
    dismissed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_project_backlog_project ON project_backlog_items(workspace_id, project_key, state);
  CREATE INDEX IF NOT EXISTS idx_project_backlog_kind ON project_backlog_items(workspace_id, project_key, kind);

  -- pipeline_links: many-to-many between custom pipeline rows
  -- (deals / investors / candidates) and ingested work_items
  -- (gmail thread / gcal event / gdrive file). Auto-populated by the
  -- matching helper after each sync; manual pin/unpin overrides the
  -- automated reason. The unique index makes re-ingest idempotent.
  CREATE TABLE IF NOT EXISTS pipeline_links (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    pipeline_table TEXT NOT NULL,
    pipeline_row_id TEXT NOT NULL,
    item_source TEXT NOT NULL,
    item_source_id TEXT NOT NULL,
    match_reason TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.7,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_links_row ON pipeline_links(pipeline_table, pipeline_row_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_links_item ON pipeline_links(item_source, item_source_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_links ON pipeline_links(pipeline_table, pipeline_row_id, item_source, item_source_id);
`;

/**
 * Best-effort additive migrations. SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * so each ALTER is wrapped in a try/catch and the "duplicate column" failure
 * is swallowed.
 */
async function runAdditiveMigrations(db: ReturnType<typeof getLibsqlDb>): Promise<void> {
  // Legacy schema cleanup: the production agent_jobs table was originally
  // created with an `agent_id NOT NULL` column that the current code path
  // doesn't write (we use `assigned_to` instead). DROP COLUMN failed —
  // likely an index or other constraint on agent_id blocks it on Turso.
  // The safest fix in beta (no live job data worth keeping) is to detect
  // the legacy column and drop the table outright; the DDL block below
  // will recreate it cleanly.
  try {
    const cols = await db
      .prepare(`PRAGMA table_info(agent_jobs)`)
      .all<{ name: string }>();
    const hasLegacyAgentId = cols.some((c) => c.name === 'agent_id');
    if (hasLegacyAgentId) {
      // job_events references agent_jobs via FK ON DELETE CASCADE, so we
      // drop it first to keep the order explicit.
      await db.exec(`DROP TABLE IF EXISTS job_events`);
      await db.exec(`DROP TABLE IF EXISTS agent_jobs`);
      console.warn('[schema migration] dropped legacy agent_jobs (had agent_id NOT NULL); will be recreated by DDL.');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[schema migration] legacy agent_jobs check failed (continuing):', msg);
  }

  const migrations: string[] = [
    // Columns added to tables that already existed in older deploys. The
    // CREATE TABLE blocks below are no-ops once a table exists, so any
    // column we have grown since the original deploy needs an explicit
    // ALTER here. Each ALTER is wrapped in tolerant error handling so
    // running on a fresh DB ("no such table") or after the column is
    // already present ("duplicate column") is harmless.
    `ALTER TABLE agent_jobs ADD COLUMN workspace_id TEXT`,
    // Backoff + retry support: when a job hits a 429 / rate-limit, the
    // agent (or server) marks it 'queued' again with a deferred retry time
    // so subsequent polls skip it until the cooldown expires.
    `ALTER TABLE agent_jobs ADD COLUMN next_retry_at TEXT`,
    `ALTER TABLE agent_jobs ADD COLUMN last_error TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_agent_jobs_status_retry ON agent_jobs(status, next_retry_at, created_at)`,
    // Founder preset rename: candidates → people (broader scope: covers
    // team, advisors, contractors, alumni, etc. via a 'relationship' field
    // in addition to candidate-pipeline rows). Move data + adjust foreign
    // references in pipeline_links + synthetic work_items so the renamed
    // table inherits everything seamlessly.
    `ALTER TABLE candidates RENAME TO people`,
    `ALTER TABLE people ADD COLUMN relationship TEXT`,
    `UPDATE people SET relationship = 'candidate' WHERE relationship IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_people_relationship ON people(relationship)`,
    `UPDATE pipeline_links SET pipeline_table = 'people' WHERE pipeline_table = 'candidates'`,
    `UPDATE work_items SET source_id = REPLACE(source_id, 'candidates:', 'people:') WHERE source = 'pipeline' AND source_id LIKE 'candidates:%'`,
    `UPDATE work_items SET item_type = 'person' WHERE source = 'pipeline' AND item_type = 'candidate'`,
    `ALTER TABLE almanac_docs ADD COLUMN title TEXT`,
    `ALTER TABLE agents ADD COLUMN claude_available INTEGER`,
    `ALTER TABLE agents ADD COLUMN claude_version TEXT`,
    // Codex + Gemini CLI availability — reported by the agent's heartbeat
    // so listAvailableBackends can decide whether to enable those backends
    // for the workspace.
    `ALTER TABLE agents ADD COLUMN codex_available INTEGER`,
    `ALTER TABLE agents ADD COLUMN codex_version TEXT`,
    `ALTER TABLE agents ADD COLUMN gemini_available INTEGER`,
    `ALTER TABLE agents ADD COLUMN gemini_version TEXT`,
    `ALTER TABLE project_summaries ADD COLUMN created_via TEXT`,
    // Direct-API connector support: per-connector incremental sync cursor
    // (Drive startPageToken / Calendar nextSyncToken / Gmail historyId) and
    // the OAuth provider key the connector authenticates against (e.g.
    // 'google' shared across gmail/gdrive/gcal). Both nullable.
    `ALTER TABLE workspace_connector_configs ADD COLUMN sync_marker TEXT`,
    `ALTER TABLE workspace_connector_configs ADD COLUMN oauth_provider TEXT`,
    // Phase 3: workspace scoping for goals/chat_threads/tags/entities. Each
    // adds a nullable workspace_id; the DDL block above also includes the
    // column on a fresh CREATE TABLE so first-deploy installs are correct.
    // Existing rows are backfilled to 'default' by the backfill block.
    `ALTER TABLE goals ADD COLUMN workspace_id TEXT`,
    `ALTER TABLE chat_threads ADD COLUMN workspace_id TEXT`,
    `ALTER TABLE tags ADD COLUMN workspace_id TEXT`,
    `ALTER TABLE entities ADD COLUMN workspace_id TEXT`,
    // Phase 4: bind workspace_config to the authenticated user. Existing
    // rows stay NULL ("unclaimed") and get claimed by the first user who
    // logs in. The first-user claim is performed by getUserWorkspaceId().
    `ALTER TABLE workspace_config ADD COLUMN auth_user_id TEXT`,
  ];
  for (const sql of migrations) {
    try {
      await db.exec(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      // Accept any phrasing libsql/Turso/SQLite uses for "this column or
      // table is already there" — the migration is idempotent and a benign
      // re-application must never poison schema init.
      if (
        msg.includes('duplicate column') ||
        msg.includes('already exists') ||
        msg.includes('duplicate name') ||
        msg.includes('no such table') || // table will be created by the next deploy of the DDL block
        msg.includes('no such column') || // DROP COLUMN where column was already removed
        msg.includes("can't drop column") // some libsql variants for already-dropped column
      ) {
        continue;
      }
      // Non-blocking: log but don't poison schema init for the entire
      // process. Schema bugs caught here would otherwise 500 every request.
      console.warn(`[schema migration] non-fatal failure for "${sql}":`, msg);
    }
  }
}

/**
 * One-time backfill for project_connectors. Idempotent — uses INSERT OR
 * IGNORE against the unique (workspace_id, project_key, kind, ref) index so
 * re-running on an already-backfilled DB is a no-op.
 *
 * Sources:
 *   1. Every project_summaries row → kind='jira', ref=project_key.
 *      Workspace is inferred from project_github_configs when available,
 *      otherwise falls back to the first known workspace_id from
 *      workspace_connector_configs (single-tenant deploys).
 *   2. Every project_github_configs row → kind='github', ref=repo, with
 *      remaining columns folded into the config JSON.
 *   3. project_summaries.created_via set to 'jira-sync' for any row where
 *      the column is null (every row before this change came from JIRA).
 */
async function backfillProjectConnectors(db: ReturnType<typeof getLibsqlDb>): Promise<void> {
  try {
    // 2. GitHub configs → project_connectors. Done first because it carries
    // workspace_id explicitly per row, which we'll also use to resolve the
    // workspace for JIRA backfill below.
    await db.exec(`
      INSERT OR IGNORE INTO project_connectors
        (id, workspace_id, project_key, kind, ref, config, created_at, updated_at)
      SELECT
        'pc_gh_' || id,
        workspace_id,
        project_key,
        'github',
        repo,
        json_object(
          'defaultBranch', default_branch,
          'pathPrefixes', json(path_prefixes),
          'ticketPrefixes', json(ticket_prefixes),
          'enabled', enabled
        ),
        created_at,
        updated_at
      FROM project_github_configs
    `);

    // 1. JIRA backfill: one row per project_summaries entry. Use the
    // workspace_id we can infer from an existing GitHub binding for the same
    // project; if none, fall back to the first workspace in
    // workspace_connector_configs (single-tenant case).
    const fallbackRows = await db
      .prepare(`SELECT workspace_id FROM workspace_connector_configs LIMIT 1`)
      .all<{ workspace_id: string }>();
    const fallbackWorkspace = fallbackRows[0]?.workspace_id ?? null;

    if (fallbackWorkspace) {
      await db
        .prepare(`
          INSERT OR IGNORE INTO project_connectors
            (id, workspace_id, project_key, kind, ref, config, created_at, updated_at)
          SELECT
            'pc_jira_' || ps.project_key,
            COALESCE(
              (SELECT pgc.workspace_id FROM project_github_configs pgc
                WHERE pgc.project_key = ps.project_key LIMIT 1),
              ?
            ),
            ps.project_key,
            'jira',
            ps.project_key,
            '{}',
            COALESCE(ps.updated_at, datetime('now')),
            datetime('now')
          FROM project_summaries ps
        `)
        .run(fallbackWorkspace);
    } else {
      // No workspace_connector_configs rows yet — nothing to back JIRA
      // bindings to. Skip; the next sync that creates a workspace connector
      // will run this migration again on the next process start.
      console.warn(
        '[schema migration] skipping JIRA project_connectors backfill: no workspace_connector_configs rows yet',
      );
    }

    // 3. Mark provenance for legacy rows.
    await db.exec(`
      UPDATE project_summaries
      SET created_via = 'jira-sync'
      WHERE created_via IS NULL
    `);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[schema migration] project_connectors backfill non-fatal failure:', msg);
  }
}

/**
 * Phase 3 backfill: stamp legacy rows in goals/chat_threads/tags/entities
 * with workspace_id='default' so they remain visible to the default
 * workspace after Phase 3 enables workspace-scoped reads. Idempotent — the
 * WHERE clause skips rows already stamped, so re-running on an upgraded DB
 * is a no-op.
 */
async function backfillWorkspaceScopedTables(db: ReturnType<typeof getLibsqlDb>): Promise<void> {
  const statements = [
    `UPDATE goals SET workspace_id = 'default' WHERE workspace_id IS NULL`,
    `UPDATE chat_threads SET workspace_id = 'default' WHERE workspace_id IS NULL`,
    `UPDATE tags SET workspace_id = 'default' WHERE workspace_id IS NULL`,
    `UPDATE entities SET workspace_id = 'default' WHERE workspace_id IS NULL`,
  ];
  for (const sql of statements) {
    try {
      await db.exec(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[schema migration] workspace backfill non-fatal failure for "${sql}":`, msg);
    }
  }
}

export async function ensureSchemaAsync(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const db = getLibsqlDb();
    // Migrations run BEFORE the DDL so columns added since older deploys
    // are present on existing tables before any CREATE INDEX statement
    // tries to reference them. On a fresh install the migrations are
    // no-ops ("no such table") and the DDL creates the schema cleanly.
    await runAdditiveMigrations(db);
    await db.exec(DDL);
    await backfillProjectConnectors(db);
    await backfillWorkspaceScopedTables(db);
  })();
  // Don't cache a rejected promise — a transient DDL failure should not
  // permanently break every subsequent caller until the process restarts.
  _initPromise.catch(() => {
    _initPromise = null;
  });
  return _initPromise;
}

export function _resetSchemaInitForTests() {
  _initPromise = null;
}
