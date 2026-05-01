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
      scope TEXT NOT NULL,                  -- 'project:PEX' | 'item:PEX-123'
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
    -- in source data. Resolves "Arun" / "arunv@…" / "@arun" to the same logged
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
  `);

  migrateWorkItems();
  migrateWorkspaceConfig();
  migrateConnectorConfigs();
  migrateGoals();
  createVectorTables();
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
}

function migrateWorkItems() {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(work_items)").all() as { name: string }[];
  const have = new Set(cols.map(c => c.name));
  if (!have.has('trace_role'))      db.exec("ALTER TABLE work_items ADD COLUMN trace_role TEXT");
  if (!have.has('substance'))       db.exec("ALTER TABLE work_items ADD COLUMN substance TEXT");
  if (!have.has('trace_event_at'))  db.exec("ALTER TABLE work_items ADD COLUMN trace_event_at TEXT");
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
    { id: 'ai-copilot', name: 'AI / Copilot Leadership', description: 'Agent pipeline, LLM models, accuracy metrics, Otti Copilot', keywords: JSON.stringify(['copilot','agent','pipeline','llm','gpt','gemini','accuracy','ai','otti copilot','mcp','claude','otti assistant','ml','model','prediction','data science','struct']), sort_order: 1 },
    { id: 'platform', name: 'Platform', description: 'Django→microservices, Celery→Lambda, bundle size, infra', keywords: JSON.stringify(['django','microservice','celery','lambda','bundle','infra','migration','platform','ottiapi','api gateway','terraform','devops','ci','deploy','docker','ecs','architecture','tdd process','paas','openapi']), sort_order: 2 },
    { id: 'integrations', name: 'Integration Excellence', description: 'Data Dash, ERP connectors, Acumatica, partner experience', keywords: JSON.stringify(['data dash','erp','acumatica','connector','partner','integration','pex','ftp','export','import','account build','onboarding project']), sort_order: 3 },
    { id: 'ops', name: 'Unclassified', description: 'Items not yet classified to a specific strategic area', keywords: JSON.stringify(['r2','stabilization','qa','bug','burndown','on-call','release','sprint','hotfix','incident','fix','security','approval','appa']), sort_order: 4 },
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
      projects: ['INT', 'PEX', 'OA'],
      cloudId: 'plateiq.atlassian.net',
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
  if (!cols.find(c => c.name === 'summary_generated_at')) {
    db.exec("ALTER TABLE project_summaries ADD COLUMN summary_generated_at TEXT");
  }
}
