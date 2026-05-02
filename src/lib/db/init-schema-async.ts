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
    project_key TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_goals_kind ON goals(kind);
  CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_id);
  CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project_key);

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
    UNIQUE(name, category)
  );

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
    updated_at TEXT DEFAULT (datetime('now'))
  );

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
    readme_generated_at TEXT
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
    UNIQUE(canonical_form, entity_type)
  );
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
  CREATE INDEX IF NOT EXISTS idx_entities_canonical ON entities(canonical_form);

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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_threads_updated ON chat_threads(updated_at DESC);

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
`;

export async function ensureSchemaAsync(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const db = getLibsqlDb();
    await db.exec(DDL);
  })();
  return _initPromise;
}

export function _resetSchemaInitForTests() {
  _initPromise = null;
}
