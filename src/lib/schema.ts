import { getDb } from './db';

export function initSchema() {
  const db = getDb();

  db.exec(`
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
      updated_at TEXT DEFAULT (datetime('now'))
    );

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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(workspace_id, slot)
    );

    -- Add sync columns for existing installs (idempotent)
    -- (SQLite ignores duplicate ADD COLUMN errors via the catch wrapper below.)

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source TEXT NOT NULL,
      -- Encrypted with AES-256-GCM via src/lib/crypto.ts (base64 payload).
      access_token_enc TEXT NOT NULL,
      refresh_token_enc TEXT,
      metadata_enc TEXT,
      -- Cleartext — these aren't secrets and we want to query/sort by them.
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

    -- Cached results of OAuth Dynamic Client Registration (RFC 7591) per
    -- provider. Keyed on (source, redirect_uri) so changing the redirect
    -- triggers a fresh registration. Secrets stored encrypted.
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
      updated_at TEXT DEFAULT (datetime('now'))
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
      -- Encrypted with AES-256-GCM via src/lib/crypto.ts (base64 payload).
      api_key_enc TEXT,
      base_url TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-user "I've seen this nudge / banner / hint" record. Keyed by an
    -- opaque string so adding a new banner doesn't require a schema change.
    -- Used by the agent-install banner today; expand for future onboarding hints.
    CREATE TABLE IF NOT EXISTS user_dismissals (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, key)
    );

    -- Tiny key-value store for app-wide settings that don't deserve their own
    -- table (active AI provider preference, feature flags, etc.). Keep keys
    -- short and namespaced (e.g. 'ai.active_provider').
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Free-tier metering. One row per (workspace, period, task) tracking
    -- call count + token consumption + estimated cost. Period is 'YYYY-MM'
    -- so old rows naturally fall off the budget window each month without
    -- needing a cleanup job.
    CREATE TABLE IF NOT EXISTS workspace_ai_usage (
      workspace_id TEXT NOT NULL,
      period TEXT NOT NULL,                    -- 'YYYY-MM'
      task TEXT NOT NULL,                      -- AITask values
      call_count INTEGER NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd_micros INTEGER NOT NULL DEFAULT 0,
      last_at TEXT,
      PRIMARY KEY (workspace_id, period, task)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_period ON workspace_ai_usage(period);

    -- Per-user record of paired local Agent installs. The agent ships as
    -- @workgraph/agent (npm) and connects out via WebSocket; this table holds
    -- the pairing token + last-seen heartbeat. Empty until the agent ships.
    CREATE TABLE IF NOT EXISTS workspace_agents (
      agent_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      pairing_token_enc TEXT NOT NULL,
      hostname TEXT,
      platform TEXT,
      version TEXT,
      status TEXT NOT NULL DEFAULT 'offline',  -- 'online' | 'offline'
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agents_user ON workspace_agents(user_id);
    CREATE INDEX IF NOT EXISTS idx_agents_workspace ON workspace_agents(workspace_id);

    -- Almanac Phase 0: device-code style pair flow.
    CREATE TABLE IF NOT EXISTS agent_pairings (
      pairing_id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      user_id TEXT,
      agent_id TEXT,
      agent_token_enc TEXT,
      status TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'confirmed'|'consumed'|'expired'
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_pairings_code ON agent_pairings(code_hash);
    CREATE INDEX IF NOT EXISTS idx_agent_pairings_status ON agent_pairings(status);

    -- Almanac Phase 0: server-side job queue the local agent drains.
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued',  -- 'queued'|'running'|'done'|'failed'|'cancelled'
      idempotency_key TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(agent_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_agent_status ON agent_jobs(agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs(status);

    -- Almanac Phase 1: code_events extracted from git by the local agent.
    CREATE TABLE IF NOT EXISTS code_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      sha TEXT NOT NULL,
      pr_number INTEGER,
      kind TEXT NOT NULL,
      author_login TEXT,
      author_email TEXT,
      occurred_at TEXT NOT NULL,
      message TEXT,
      files_touched TEXT NOT NULL DEFAULT '[]',
      additions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      module_id TEXT,
      functional_unit_id TEXT,
      classified_as TEXT,
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

    CREATE TABLE IF NOT EXISTS code_events_backfill_state (
      repo TEXT PRIMARY KEY,
      last_sha TEXT,
      last_occurred_at TEXT,
      total_events INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      last_status TEXT,
      last_error TEXT
    );

    -- Inngest heartbeat / pulse log. One row per scheduled tick. Trims
    -- itself to the last 1000 rows on each insert to bound disk use.
    CREATE TABLE IF NOT EXISTS system_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,            -- 'heartbeat' | 'jira.sync.tick' | …
      detail TEXT,                   -- short JSON payload for debugging
      ran_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_system_health_ran ON system_health(ran_at);

    -- Action items extracted by AI from issue body / comments / threads.
    -- Surfaced on the per-user tracker.
    CREATE TABLE IF NOT EXISTS action_items (
      id TEXT PRIMARY KEY,
      source_item_id TEXT NOT NULL REFERENCES work_items(id),
      text TEXT NOT NULL,
      assignee TEXT,
      due_at TEXT,
      user_priority TEXT,                  -- 'p0'..'p3', set by user
      ai_priority TEXT,                    -- 'p0'..'p3', set by AI
      state TEXT NOT NULL DEFAULT 'open',  -- open / done / dismissed
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_action_items_source ON action_items(source_item_id);
    CREATE INDEX IF NOT EXISTS idx_action_items_assignee ON action_items(assignee);
    CREATE INDEX IF NOT EXISTS idx_action_items_state ON action_items(state);

    -- Anomalies detected on a weekly cadence. Auto-resolves if the
    -- triggering condition no longer holds.
    CREATE TABLE IF NOT EXISTS anomalies (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope TEXT NOT NULL,                  -- 'project:ALPHA' | 'item:ALPHA-123'
      kind TEXT NOT NULL,                   -- stale | churning | scope_creep | priority_inversion | deadline_risk | owner_gap | goal_drift
      severity REAL NOT NULL,               -- 0..1
      evidence_item_ids TEXT NOT NULL,      -- JSON array of item ids
      explanation TEXT,                     -- one-sentence AI explanation
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,                     -- nullable; set when condition no longer holds
      dismissed_by_user INTEGER NOT NULL DEFAULT 0,
      UNIQUE(workspace_id, scope, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_anomalies_workspace ON anomalies(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_anomalies_open ON anomalies(workspace_id, resolved_at, dismissed_by_user);

    -- Per-workspace mapping from auth user → display names / emails / handles
    -- in source data. Resolves "Alex" / "alex@…" / "@alex" to the same logged
    -- in user. Required for is_mine, per-user tracker, and assignee matching.
    CREATE TABLE IF NOT EXISTS workspace_user_aliases (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      auth_user_id TEXT NOT NULL,           -- WorkOS user.id
      source TEXT NOT NULL,                 -- 'jira' | 'slack' | 'github' | …
      alias TEXT NOT NULL,                  -- normalized lowercase
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

    -- Every PR + review event for an issue, in order. PRs are NOT work_items
    -- — they're trail entries anchored to the Jira ticket they address. Rows
    -- with issue_item_id = NULL are PRs that didn't carry a Jira key in
    -- title/branch/body; the unmatched-PR AI matcher reattaches them later
    -- by code-change similarity.
    CREATE TABLE IF NOT EXISTS issue_trails (
      id TEXT PRIMARY KEY,
      issue_item_id TEXT REFERENCES work_items(id),    -- Jira ticket; NULL when unmatched
      pr_ref TEXT NOT NULL,                            -- "owner/repo#NN"
      pr_url TEXT,
      repo TEXT,                                       -- "owner/repo"
      kind TEXT NOT NULL,                              -- 'pr_opened' | 'pr_review' | 'pr_merged' | 'pr_closed'
      actor TEXT,                                      -- GitHub login
      title TEXT,                                      -- PR title or review summary
      body TEXT,                                       -- PR description or review body (capped 4KB by writer)
      state TEXT,                                      -- 'approved' | 'changes_requested' | 'commented' | 'open' | 'merged' | 'closed'
      diff_summary TEXT,                               -- JSON: { additions, deletions, files, branch }
      occurred_at TEXT NOT NULL,
      match_status TEXT NOT NULL DEFAULT 'matched',    -- 'matched' | 'unmatched' | 'ai_matched'
      match_confidence REAL,                           -- for ai_matched: 0..1
      match_evidence TEXT,                             -- JSON: which signal fired
      raw_metadata TEXT,                               -- JSON
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(pr_ref, kind, occurred_at)
    );
    CREATE INDEX IF NOT EXISTS idx_issue_trails_issue ON issue_trails(issue_item_id);
    CREATE INDEX IF NOT EXISTS idx_issue_trails_pr ON issue_trails(pr_ref);
    CREATE INDEX IF NOT EXISTS idx_issue_trails_occurred ON issue_trails(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_issue_trails_unmatched
      ON issue_trails(match_status) WHERE match_status = 'unmatched';

    -- Top-K Jira ticket candidates for an orphan PR. Populated by the
    -- unmatched-pr matcher when no candidate clears the auto-attach
    -- threshold but at least one is plausible. Drives the user review UI.
    -- Cleared when the user attaches a PR (via 'user_matched') or
    -- explicitly dismisses the candidates.
    CREATE TABLE IF NOT EXISTS orphan_pr_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_ref TEXT NOT NULL,                        -- "owner/repo#NN"
      candidate_item_id TEXT NOT NULL REFERENCES work_items(id),
      score REAL NOT NULL,                         -- 0..1, normalized aggregate
      signals TEXT NOT NULL,                       -- JSON: { embedding, author, repo, temporal }
      computed_at TEXT NOT NULL DEFAULT (datetime('now')),
      dismissed_at TEXT,                           -- non-null = user said "none of these"
      UNIQUE(pr_ref, candidate_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_orphan_pr_candidates_ref ON orphan_pr_candidates(pr_ref);
    CREATE INDEX IF NOT EXISTS idx_orphan_pr_candidates_open
      ON orphan_pr_candidates(pr_ref) WHERE dismissed_at IS NULL;

    -- AI-extracted decisions surfaced from PR review threads. Distinct from
    -- the existing decisions table (which has UNIQUE(item_id) — one per
    -- ticket). One Jira ticket can produce N decisions across its review
    -- discussion, so we keep this separate.
    CREATE TABLE IF NOT EXISTS issue_decisions (
      id TEXT PRIMARY KEY,
      issue_item_id TEXT NOT NULL REFERENCES work_items(id),
      trail_id TEXT REFERENCES issue_trails(id),       -- the source review (nullable)
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
  `);

  migrateWorkItems();
  migrateWorkspaceConfig();
  migrateConnectorConfigs();
  migrateGoals();
  migrateIssueTrails();
  migrateAnomalies();
  dedupeReverseLinks();
  createMetadataIndexes();
  createVectorTables();
}

/**
 * One-shot cleanup: the link writer used to only check (source,target)
 * orientation, so a single semantic edge (A↔B) ended up as two rows
 * (A→B and B→A) once crossref ran from each item's perspective. We
 * collapse each reverse-direction pair down to one row, keeping the
 * higher-confidence one and dropping its mirror. Any item_links_chunks
 * pointing at the dropped row are reattached to the survivor.
 *
 * Sentinel-keyed via schema_migrations so this runs once per DB.
 */
function dedupeReverseLinks() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const sentinel = 'dedupe_reverse_links_v1';
  if (db.prepare(`SELECT 1 FROM schema_migrations WHERE id = ?`).get(sentinel)) return;

  // Find every reverse pair where both directions share the same link_type.
  // Pick the survivor by (confidence DESC, rowid ASC) — deterministic and
  // prefers the row with stronger evidence.
  const pairs = db.prepare(`
    WITH ordered AS (
      SELECT id, source_item_id AS a, target_item_id AS b, link_type, confidence,
             MIN(source_item_id, target_item_id) AS lo,
             MAX(source_item_id, target_item_id) AS hi
      FROM links
    )
    SELECT survivor_id, dropped_id FROM (
      SELECT
        FIRST_VALUE(id) OVER (PARTITION BY lo, hi, link_type ORDER BY confidence DESC, id ASC) AS survivor_id,
        id AS dropped_id
      FROM ordered
    )
    WHERE survivor_id != dropped_id
  `).all() as { survivor_id: string; dropped_id: string }[];

  if (pairs.length === 0) {
    db.prepare(`INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)`).run(sentinel);
    return;
  }

  const reattach = db.prepare(`UPDATE item_links_chunks SET link_id = ? WHERE link_id = ?`);
  const drop = db.prepare(`DELETE FROM links WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const p of pairs) {
      // Reattach evidence rows first (UNIQUE constraints permitting); then
      // delete the loser. Best-effort on the reattach: a duplicate evidence
      // row from the survivor side already covers the signal, so a primary
      // key collision means the data was already there and we just drop.
      try {
        reattach.run(p.survivor_id, p.dropped_id);
      } catch {
        // existing chunk evidence on survivor — fine, just delete the loser's rows
        db.prepare(`DELETE FROM item_links_chunks WHERE link_id = ?`).run(p.dropped_id);
      }
      drop.run(p.dropped_id);
    }
    db.prepare(`INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)`).run(sentinel);
  });
  tx();
  console.log(`[schema] dedupe_reverse_links_v1 collapsed ${pairs.length} duplicate link rows`);
}

function migrateAnomalies() {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(anomalies)").all() as { name: string }[];
  const have = new Set(cols.map(c => c.name));
  // What the user did about this anomaly. Distinct from `dismissed_by_user`
  // (which is "ignore, no action") and `resolved_at` (which is "underlying
  // condition no longer holds"). handled_at + the *_id columns capture an
  // explicit user-driven follow-up.
  if (!have.has('action_item_id'))  db.exec("ALTER TABLE anomalies ADD COLUMN action_item_id TEXT");
  if (!have.has('jira_issue_key'))  db.exec("ALTER TABLE anomalies ADD COLUMN jira_issue_key TEXT");
  if (!have.has('handled_at'))      db.exec("ALTER TABLE anomalies ADD COLUMN handled_at TEXT");
  if (!have.has('handled_note'))    db.exec("ALTER TABLE anomalies ADD COLUMN handled_note TEXT");
}

function createMetadataIndexes() {
  const db = getDb();
  // Expression indexes on common JSON paths into work_items.metadata.
  // Hot-path queries on the project page filter by project / entity_key
  // and previously full-scanned the table.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_meta_project
      ON work_items(json_extract(metadata, '$.project'))
      WHERE source = 'jira';

    CREATE INDEX IF NOT EXISTS idx_work_items_meta_entity_key
      ON work_items(json_extract(metadata, '$.entity_key'));

    CREATE INDEX IF NOT EXISTS idx_work_items_meta_is_mine
      ON work_items(json_extract(metadata, '$.is_mine'))
      WHERE json_extract(metadata, '$.is_mine') = 1;
  `);
}

function migrateGoals() {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(goals)").all() as { name: string }[];
  const have = new Set(cols.map(c => c.name));
  if (!have.has('owner_user_id'))    db.exec("ALTER TABLE goals ADD COLUMN owner_user_id TEXT");
  if (!have.has('target_metric'))    db.exec("ALTER TABLE goals ADD COLUMN target_metric TEXT");
  if (!have.has('target_value'))     db.exec("ALTER TABLE goals ADD COLUMN target_value REAL");
  if (!have.has('target_at'))        db.exec("ALTER TABLE goals ADD COLUMN target_at TEXT");
  if (!have.has('ai_confidence'))    db.exec("ALTER TABLE goals ADD COLUMN ai_confidence REAL");
  if (!have.has('derived_from'))     db.exec("ALTER TABLE goals ADD COLUMN derived_from TEXT NOT NULL DEFAULT 'manual'");
  // OKR support — see docs/processes/jira-tracker.md Phase 6.
  if (!have.has('kind'))             db.exec("ALTER TABLE goals ADD COLUMN kind TEXT NOT NULL DEFAULT 'goal'");  // 'goal' | 'objective' | 'key_result'
  if (!have.has('parent_id'))        db.exec("ALTER TABLE goals ADD COLUMN parent_id TEXT");                     // key_result.parent_id → objective.id
  if (!have.has('project_key'))      db.exec("ALTER TABLE goals ADD COLUMN project_key TEXT");                   // anchors AI-generated OKRs to their project

  db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_kind ON goals(kind)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project_key)`);
}

function migrateWorkItems() {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(work_items)").all() as { name: string }[];
  const have = new Set(cols.map(c => c.name));
  if (!have.has('trace_role'))      db.exec("ALTER TABLE work_items ADD COLUMN trace_role TEXT");
  if (!have.has('substance'))       db.exec("ALTER TABLE work_items ADD COLUMN substance TEXT");
  if (!have.has('trace_event_at'))  db.exec("ALTER TABLE work_items ADD COLUMN trace_event_at TEXT");
  // Per-ticket "how was this addressed" narrative — generated by the
  // issue-pr-summary pipeline after PR trails are ingested.
  if (!have.has('pr_summary'))              db.exec("ALTER TABLE work_items ADD COLUMN pr_summary TEXT");
  if (!have.has('pr_summary_generated_at')) db.exec("ALTER TABLE work_items ADD COLUMN pr_summary_generated_at TEXT");
  // Structured fulfillment evaluation — what shipped, what's missing — produced
  // by the same generateIssuePrSummary pass alongside pr_summary. JSON shape:
  // { status: 'complete' | 'partial' | 'gap' | 'unknown', shipped: string[], missing: string[], notes: string }
  if (!have.has('gap_analysis'))            db.exec("ALTER TABLE work_items ADD COLUMN gap_analysis TEXT");
  if (!have.has('gap_analysis_generated_at')) db.exec("ALTER TABLE work_items ADD COLUMN gap_analysis_generated_at TEXT");

  cleanupGithubNonReleaseItems();
}

function migrateIssueTrails() {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(issue_trails)").all() as { name: string }[];
  const have = new Set(cols.map(c => c.name));
  // Plain-English description of what the PR does — generated from title+body
  // (and diff_text when available). Cached on the trail row so the per-ticket
  // synthesis sees natural-language PR descriptions next to Jira acceptance
  // criteria, and so vector search over PR semantics works without re-translating.
  if (!have.has('functional_summary'))           db.exec("ALTER TABLE issue_trails ADD COLUMN functional_summary TEXT");
  if (!have.has('functional_summary_generated_at')) db.exec("ALTER TABLE issue_trails ADD COLUMN functional_summary_generated_at TEXT");
  // Truncated, filtered patch text fetched on demand for sparse PR descriptions.
  // Lock files / generated content are dropped. Capped at ~3000 lines total.
  if (!have.has('diff_text'))                    db.exec("ALTER TABLE issue_trails ADD COLUMN diff_text TEXT");
  if (!have.has('diff_text_fetched_at'))         db.exec("ALTER TABLE issue_trails ADD COLUMN diff_text_fetched_at TEXT");
}

/**
 * One-shot migration: PRs / issues / repository synthetic items are no
 * longer stored as work_items — they live as trail entries on the Jira
 * ticket they address. Releases are preserved (still a useful node).
 *
 * Sentinel-keyed via schema_migrations so this only runs once per DB.
 * Safe to ship: cascading cleanup of links + entity_mentions + chunks
 * keeps referential integrity intact.
 */
function cleanupGithubNonReleaseItems() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const sentinel = 'cleanup_github_non_release_items_v1';
  const exists = db.prepare(`SELECT 1 FROM schema_migrations WHERE id = ?`).get(sentinel);
  if (exists) return;

  const ids = (db
    .prepare(
      `SELECT id FROM work_items
       WHERE source = 'github' AND item_type IN ('pull_request', 'issue', 'repository')`,
    )
    .all() as { id: string }[]).map((r) => r.id);

  if (ids.length === 0) {
    db.prepare(`INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)`).run(sentinel);
    return;
  }

  const placeholders = ids.map(() => '?').join(',');
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM links WHERE source_item_id IN (${placeholders}) OR target_item_id IN (${placeholders})`).run(...ids, ...ids);
    db.prepare(`DELETE FROM entity_mentions WHERE item_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM item_tags WHERE item_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM item_chunks WHERE item_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM work_item_versions WHERE item_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM anomalies WHERE scope IN (${ids.map(() => '?').join(',')})`).run(...ids.map((id) => `item:${id}`));
    db.prepare(`DELETE FROM action_items WHERE source_item_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM work_items WHERE id IN (${placeholders})`).run(...ids);
    db.prepare(`INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)`).run(sentinel);
    db.exec('COMMIT');
    console.log(`[schema] cleaned up ${ids.length} legacy GitHub PR/issue/repo work_items (releases preserved)`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function migrateWorkspaceConfig() {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(workspace_config)").all() as { name: string }[];
  const have = new Set(cols.map(c => c.name));
  if (!have.has('enabled')) {
    db.exec("ALTER TABLE workspace_config ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
  }
}

function migrateConnectorConfigs() {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(workspace_connector_configs)").all() as { name: string }[];
  const have = new Set(cols.map(c => c.name));
  if (!have.has('last_sync_started_at'))   db.exec("ALTER TABLE workspace_connector_configs ADD COLUMN last_sync_started_at TEXT");
  if (!have.has('last_sync_completed_at')) db.exec("ALTER TABLE workspace_connector_configs ADD COLUMN last_sync_completed_at TEXT");
  if (!have.has('last_sync_status'))       db.exec("ALTER TABLE workspace_connector_configs ADD COLUMN last_sync_status TEXT");
  if (!have.has('last_sync_items'))        db.exec("ALTER TABLE workspace_connector_configs ADD COLUMN last_sync_items INTEGER");
  if (!have.has('last_sync_error'))        db.exec("ALTER TABLE workspace_connector_configs ADD COLUMN last_sync_error TEXT");
  if (!have.has('last_sync_log'))          db.exec("ALTER TABLE workspace_connector_configs ADD COLUMN last_sync_log TEXT");
}

function createVectorTables() {
  const db = getDb();
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks_text USING vec0(
        chunk_id integer primary key,
        embedding float[768]
      );
    `);
  } catch (err: any) {
    console.warn(`Vector table creation skipped: ${err.message}`);
  }
}

export function seedGoals() {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) as c FROM goals').get() as { c: number };
  if (existing.c > 0) return;

  const goals = [
    { id: 'ai-copilot', name: 'AI / Copilot Leadership', description: 'Agent pipeline, LLM models, accuracy metrics', keywords: JSON.stringify(['copilot','agent','pipeline','llm','gpt','gemini','accuracy','ai','mcp','claude','ml','model','prediction','data science','struct']), sort_order: 1 },
    { id: 'platform', name: 'Platform', description: 'Django→microservices, Celery→Lambda, bundle size, infra', keywords: JSON.stringify(['django','microservice','celery','lambda','bundle','infra','migration','platform','api gateway','terraform','devops','ci','deploy','docker','ecs','architecture','tdd process','paas','openapi']), sort_order: 2 },
    { id: 'integrations', name: 'Integration Excellence', description: 'ERP connectors, partner integrations', keywords: JSON.stringify(['erp','connector','partner','integration','ftp','export','import','account build','onboarding project']), sort_order: 3 },
    { id: 'ops', name: 'Unclassified', description: 'Items not yet classified to a specific strategic area', keywords: JSON.stringify(['stabilization','qa','bug','burndown','on-call','release','sprint','hotfix','incident','fix','security','approval']), sort_order: 4 },
    { id: 'onboarding', name: 'Onboarding', description: 'Login revamp, passkeys, onboarding flow, time-to-value', keywords: JSON.stringify(['login','passkey','onboarding','time-to-value','signup','totp','welcome','implementation','account setup']), sort_order: 5 },
  ];

  const insert = db.prepare('INSERT INTO goals (id, name, description, keywords, status, origin, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const g of goals) {
    insert.run(g.id, g.name, g.description, g.keywords, 'active', 'inferred', g.sort_order);
  }
}

export function seedConfig() {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) as c FROM sync_config').get() as { c: number };
  if (existing.c > 0) return;

  const defaultConfig = {
    jira: {
      enabled: true,
      projects: ['ALPHA', 'BETA', 'GAMMA'],
      cloudId: 'example.atlassian.net',
    },
    slack: {
      enabled: true,
      mode: 'all',
      channels: [],
    },
    meetings: {
      enabled: true,
    },
    notion: {
      enabled: true,
    },
    gmail: {
      enabled: true,
    },
  };

  db.prepare("INSERT INTO sync_config (id, config) VALUES ('default', ?)").run(JSON.stringify(defaultConfig));
}

export function migrateProjectSummaries() {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(project_summaries)").all() as { name: string }[];
  const have = new Set(cols.map(c => c.name));
  if (!have.has('summary_generated_at')) {
    db.exec("ALTER TABLE project_summaries ADD COLUMN summary_generated_at TEXT");
  }
  // README — stable, descriptive document. Separate from `recap` (status-y).
  if (!have.has('readme'))                db.exec("ALTER TABLE project_summaries ADD COLUMN readme TEXT");
  if (!have.has('readme_generated_at'))   db.exec("ALTER TABLE project_summaries ADD COLUMN readme_generated_at TEXT");
}
