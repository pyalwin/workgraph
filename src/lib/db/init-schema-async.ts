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

  -- Almanac Phase 0: device-code style pair flow.
  -- /api/agent/pair/start mints (pairing_id, code_hash). The user runs
  -- "workgraph login" on their laptop, sees a short user code, opens it in
  -- the web app, and confirms while authed. The agent polls /pair/poll until
  -- status flips from 'pending' to 'confirmed'; at that point /pair/poll
  -- returns the agent_id + agent_token to write to the local config.
  CREATE TABLE IF NOT EXISTS agent_pairings (
    pairing_id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,            -- sha256(user_code), never store the code itself
    user_id TEXT,                       -- filled at confirm time
    agent_id TEXT,                      -- filled at confirm time, references workspace_agents
    agent_token_enc TEXT,               -- agent token (encrypted) returned to the agent on next poll
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'confirmed' | 'consumed' | 'expired'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_pairings_code ON agent_pairings(code_hash);
  CREATE INDEX IF NOT EXISTS idx_agent_pairings_status ON agent_pairings(status);

  -- Almanac Phase 0: server-side job queue the local agent drains.
  -- agent picks up rows where status='queued' AND agent_id matches its id,
  -- moves them to 'running' on poll, and posts back result/error -> 'done'/'failed'.
  CREATE TABLE IF NOT EXISTS agent_jobs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,                 -- e.g. 'noop', 'almanac.code_events.extract'
    params TEXT NOT NULL DEFAULT '{}',  -- JSON
    status TEXT NOT NULL DEFAULT 'queued',  -- 'queued'|'running'|'done'|'failed'|'cancelled'
    idempotency_key TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    result TEXT,                        -- JSON
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    UNIQUE(agent_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_agent_status ON agent_jobs(agent_id, status);
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs(status);

  -- Almanac Phase 1: one row per merged PR + direct-to-main commit per repo.
  -- Populated by the local agent's 'almanac.code-events.extract' job; this is
  -- the substrate the rest of the Almanac pipeline (lifecycle, clustering,
  -- narrative) operates on. Many fields are nullable on extract and filled in
  -- later phases (module_id, functional_unit_id, classified_as).
  CREATE TABLE IF NOT EXISTS code_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    repo TEXT NOT NULL,                 -- "owner/name"
    sha TEXT NOT NULL,
    pr_number INTEGER,
    kind TEXT NOT NULL,                 -- 'pr_merged' | 'direct_commit' | 'release'
    author_login TEXT,
    author_email TEXT,
    occurred_at TEXT NOT NULL,
    message TEXT,
    files_touched TEXT NOT NULL DEFAULT '[]',  -- JSON array of paths (signal-only, skip patterns applied)
    additions INTEGER NOT NULL DEFAULT 0,
    deletions INTEGER NOT NULL DEFAULT 0,
    module_id TEXT,                     -- nullable until Phase 2
    functional_unit_id TEXT,            -- nullable until Phase 2
    classified_as TEXT,                 -- (kept for now; Phase 1.6 added richer fields below)
    -- Phase 1.6 noise classifier columns
    noise_class TEXT,                   -- 'dependency_bump'|'tooling'|'docs_only'|'test_only'|'ci_only'|'tiny_change'|'revert'|'signal'
    intent TEXT,                        -- 'introduce'|'extend'|'refactor'|'fix'|'revert'|'mixed'
    architectural_significance TEXT,    -- 'low'|'medium'|'high'
    is_feature_evolution INTEGER NOT NULL DEFAULT 0,  -- gate to dossier
    evolution_override INTEGER,         -- nullable: human-set 1=force-include, 0=force-exclude (never overwritten by classifier)
    classifier_run_at TEXT,
    ticket_link_status TEXT NOT NULL DEFAULT 'unlinked',
    linked_item_id TEXT,
    link_confidence REAL,
    link_evidence TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(repo, sha)
  );
  CREATE INDEX IF NOT EXISTS idx_code_events_workspace ON code_events(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_code_events_repo_occurred ON code_events(repo, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_code_events_pr ON code_events(pr_number);
  -- noise/signal indexes are created in the Phase 1.6 migration after ALTER TABLE
  -- adds the columns; for fresh installs the columns exist on the CREATE TABLE
  -- above and the migration is a no-op except for the index creation.

  -- Per-repo backfill state — last_sha is the resume cursor for incremental
  -- re-runs. Re-running the extract is idempotent (INSERT OR IGNORE on
  -- (repo, sha)) but the state row lets us short-circuit at the cursor
  -- instead of streaming the full history every week.
  CREATE TABLE IF NOT EXISTS code_events_backfill_state (
    repo TEXT PRIMARY KEY,
    last_sha TEXT,
    last_occurred_at TEXT,
    total_events INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT,
    last_status TEXT,                   -- 'ok' | 'error' | 'partial'
    last_error TEXT
  );

  -- Almanac Phase 1.5: birth -> rename -> deletion timeline for every path
  -- that has ever existed in a repo. Without this, evolution narratives are
  -- blind to deleted/renamed code (which is exactly the interesting cases).
  -- Populated by the local agent's 'almanac.file-lifecycle.extract' job.
  CREATE TABLE IF NOT EXISTS file_lifecycle (
    repo TEXT NOT NULL,
    path TEXT NOT NULL,                 -- current path (or last path before deletion)
    first_sha TEXT,
    first_at TEXT,
    last_sha TEXT,
    last_at TEXT,
    status TEXT NOT NULL,               -- 'extant' | 'deleted'
    rename_chain TEXT NOT NULL DEFAULT '[]',  -- JSON array of prior paths, oldest -> most-recent
    churn INTEGER NOT NULL DEFAULT 0,   -- count of code_events that touched this path or any prior name
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (repo, path)
  );
  CREATE INDEX IF NOT EXISTS idx_file_lifecycle_status ON file_lifecycle(repo, status);
  CREATE INDEX IF NOT EXISTS idx_file_lifecycle_last_at ON file_lifecycle(repo, last_at DESC);

  -- Almanac Phase 2: modules = file-path architecture axis. Auto-detected
  -- by 2-level path grouping weighted by churn. User-editable.
  CREATE TABLE IF NOT EXISTS modules (
    id TEXT PRIMARY KEY,                -- workspace_id:repo:slug
    workspace_id TEXT NOT NULL,
    repo TEXT NOT NULL,                 -- module is per-repo
    name TEXT NOT NULL,                 -- e.g. "src/lib/sync"
    path_patterns TEXT NOT NULL DEFAULT '[]',  -- JSON: ['src/lib/sync/**']
    detected_from TEXT NOT NULL,        -- 'auto' | 'manual'
    status TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'archived'
    churn INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_modules_workspace_repo ON modules(workspace_id, repo);

  -- Almanac Phase 2: functional units = product-capability axis. The row
  -- in the Almanac. Each cluster of co-evolving signal events becomes
  -- a unit; Jira epics in scope are seeded as units up-front.
  CREATE TABLE IF NOT EXISTS functional_units (
    id TEXT PRIMARY KEY,                -- deterministic: sha1 of sorted file set OR 'epic:<key>'
    workspace_id TEXT NOT NULL,
    project_key TEXT,                   -- Jira project for unit's home project
    name TEXT,                          -- nullable until CLI naming pass completes
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'archived' | 'merged'
    detected_from TEXT NOT NULL,        -- 'co_change' | 'jira_epic_alias' | 'manual'
    jira_epic_key TEXT,                 -- nullable; set when detected_from='jira_epic_alias'
    keywords TEXT NOT NULL DEFAULT '[]',         -- JSON array
    file_path_patterns TEXT NOT NULL DEFAULT '[]',  -- JSON array of glob-like patterns
    file_set_hash TEXT,                 -- sha1 of the canonical file set (for cache invalidation)
    first_seen_at TEXT,                 -- min(occurred_at) of member events
    last_active_at TEXT,                -- max(occurred_at) of member events
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_funits_workspace_project ON functional_units(workspace_id, project_key);
  CREATE INDEX IF NOT EXISTS idx_funits_detected ON functional_units(detected_from);
  CREATE INDEX IF NOT EXISTS idx_funits_active ON functional_units(workspace_id, last_active_at DESC);

  -- Almanac Phase 2: rename / merge / split history for functional units.
  -- When two units merge, the surviving unit accumulates aliases pointing
  -- at the absorbed ones, so historic citations don't break.
  CREATE TABLE IF NOT EXISTS functional_unit_aliases (
    unit_id TEXT NOT NULL,
    alias TEXT NOT NULL,                -- a previous name OR an absorbed unit_id
    source TEXT NOT NULL,               -- 'rename' | 'merge' | 'split'
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (unit_id, alias)
  );

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

  -- Almanac Phase 3: inverse of orphan_pr_candidates. For Jira tickets
  -- without an issue_trails row, the ticket-first matcher proposes code
  -- evidence (PR/branch/commit). Tier A (PR) auto-attaches at >= 0.75;
  -- Tier B (branch) and Tier C (commit) always queue for human review.
  CREATE TABLE IF NOT EXISTS orphan_ticket_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_item_id TEXT NOT NULL REFERENCES work_items(id),
    evidence_kind TEXT NOT NULL,                 -- 'pr' | 'branch' | 'commit'
    tier_reached TEXT NOT NULL,                  -- 'A' | 'B' | 'C'
    candidate_ref TEXT NOT NULL,                 -- e.g. 'owner/repo#123' or 'owner/repo@sha'
    score REAL NOT NULL,
    signals TEXT NOT NULL DEFAULT '{}',          -- JSON: which evidence contributed
    computed_at TEXT NOT NULL DEFAULT (datetime('now')),
    dismissed_at TEXT,
    accepted_at TEXT,
    UNIQUE(issue_item_id, candidate_ref)
  );
  CREATE INDEX IF NOT EXISTS idx_orphan_ticket_cand_issue ON orphan_ticket_candidates(issue_item_id);
  CREATE INDEX IF NOT EXISTS idx_orphan_ticket_cand_open ON orphan_ticket_candidates(issue_item_id, dismissed_at, accepted_at);

  -- Almanac Phase 4: per-section markdown content. One row per section per
  -- project. anchor is a stable, human-friendly slug (e.g. 'cover',
  -- 'summary', 'unit-<unit_id>', 'drift-unticketed'). source_hash is sha1
  -- of the deterministic dossier inputs; matching hash on regen = no-op.
  -- diagram_blocks is a JSON array of { kind, params, position } records
  -- the renderer expands; markdown still embeds :::diagram::: fences inline.
  CREATE TABLE IF NOT EXISTS almanac_sections (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    unit_id TEXT,                       -- nullable for cross-cutting sections
    kind TEXT NOT NULL,                 -- 'cover'|'summary'|'unit'|'drift_unticketed'|'drift_unbuilt'|'decisions'|'appendix'
    anchor TEXT NOT NULL,               -- stable slug, unique per project
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    markdown TEXT NOT NULL,
    diagram_blocks TEXT NOT NULL DEFAULT '[]',
    source_hash TEXT NOT NULL,
    generated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_key, anchor)
  );
  CREATE INDEX IF NOT EXISTS idx_almanac_sections_project ON almanac_sections(workspace_id, project_key, position);
  CREATE INDEX IF NOT EXISTS idx_almanac_sections_unit ON almanac_sections(unit_id);

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

/**
 * Sentinel-keyed migrations for libSQL. Each entry is a one-shot ALTER
 * statement (or set of them) keyed by an id; we record the id in
 * `schema_migrations` after running so re-runs skip. Idempotent.
 *
 * Use this for ALTER TABLE ADD COLUMN — SQLite's CREATE TABLE IF NOT
 * EXISTS doesn't add columns to existing tables.
 */
const MIGRATIONS: { id: string; statements: string[] }[] = [
  {
    id: 'almanac_phase_1_6_code_events_classifier_columns',
    statements: [
      `ALTER TABLE code_events ADD COLUMN noise_class TEXT`,
      `ALTER TABLE code_events ADD COLUMN intent TEXT`,
      `ALTER TABLE code_events ADD COLUMN architectural_significance TEXT`,
      `ALTER TABLE code_events ADD COLUMN is_feature_evolution INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE code_events ADD COLUMN evolution_override INTEGER`,
      `ALTER TABLE code_events ADD COLUMN classifier_run_at TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_code_events_noise ON code_events(repo, noise_class)`,
      `CREATE INDEX IF NOT EXISTS idx_code_events_signal ON code_events(repo, is_feature_evolution)`,
    ],
  },
];

async function runMigrations(): Promise<void> {
  const db = getLibsqlDb();
  for (const m of MIGRATIONS) {
    const seen = await db
      .prepare(`SELECT 1 as ok FROM schema_migrations WHERE id = ?`)
      .get<{ ok: number }>(m.id);
    if (seen) continue;
    for (const stmt of m.statements) {
      try {
        await db.exec(stmt);
      } catch (err) {
        // Tolerate "duplicate column" if a previous partial run added some
        // columns — the sentinel only records once everything succeeded.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column/i.test(msg)) throw err;
      }
    }
    await db.prepare(`INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)`).run(m.id);
  }
}

export async function ensureSchemaAsync(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const db = getLibsqlDb();
    await db.exec(DDL);
    await runMigrations();
  })();
  return _initPromise;
}

export function _resetSchemaInitForTests() {
  _initPromise = null;
}
