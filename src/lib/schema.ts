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
      author TEXT,
      status TEXT,
      priority TEXT,
      url TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      synced_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source, source_id)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      category TEXT
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

    CREATE INDEX IF NOT EXISTS idx_items_source ON work_items(source);
    CREATE INDEX IF NOT EXISTS idx_items_status ON work_items(status);
    CREATE INDEX IF NOT EXISTS idx_items_created ON work_items(created_at);
    CREATE INDEX IF NOT EXISTS idx_item_tags_item ON item_tags(item_id);
    CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_item_id);
    CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_item_id);
    CREATE INDEX IF NOT EXISTS idx_metrics_goal_date ON metrics_snapshots(goal_id, snapshot_date);
    CREATE INDEX IF NOT EXISTS idx_sync_source ON sync_log(source, completed_at);
    CREATE INDEX IF NOT EXISTS idx_versions_item ON work_item_versions(item_id);
    CREATE INDEX IF NOT EXISTS idx_versions_changed ON work_item_versions(changed_at);
  `);
}

export function seedGoals() {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) as c FROM goals').get() as { c: number };
  if (existing.c > 0) return;

  const goals = [
    { id: 'ai-copilot', name: 'AI / Copilot Leadership', description: 'Agent pipeline, LLM models, accuracy metrics, Otti Copilot', keywords: JSON.stringify(['copilot','agent','pipeline','llm','gpt','gemini','accuracy','ai','otti copilot','mcp','claude','otti assistant','ml','model','prediction','data science','struct']), sort_order: 1 },
    { id: 'platform', name: 'Platform Modernization', description: 'Django→microservices, Celery→Lambda, bundle size, infra', keywords: JSON.stringify(['django','microservice','celery','lambda','bundle','infra','migration','platform','ottiapi','api gateway','terraform','devops','ci','deploy','docker','ecs','architecture','tdd process','paas','openapi']), sort_order: 2 },
    { id: 'revenue', name: 'Revenue & Retention', description: 'VendorPay, activation, gross retention, churn, upsell', keywords: JSON.stringify(['vendorpay','activation','retention','churn','upsell','revenue','gross retention','pay','payment','billing','ach','bank','dwolla']), sort_order: 3 },
    { id: 'integrations', name: 'Integration Excellence', description: 'Data Dash, ERP connectors, Acumatica, partner experience', keywords: JSON.stringify(['data dash','erp','acumatica','connector','partner','integration','pex','ftp','export','import','account build','onboarding project']), sort_order: 4 },
    { id: 'ops', name: 'Operational Excellence', description: 'R2 release, stabilization marathon, QA, bug burndown', keywords: JSON.stringify(['r2','stabilization','qa','bug','burndown','on-call','release','sprint','hotfix','incident','fix','security','approval','appa']), sort_order: 5 },
    { id: 'onboarding', name: 'Fast Onboarding', description: 'Login revamp, passkeys, onboarding flow, time-to-value', keywords: JSON.stringify(['login','passkey','onboarding','time-to-value','signup','totp','welcome','implementation','account setup']), sort_order: 6 },
  ];

  const insert = db.prepare('INSERT INTO goals (id, name, description, keywords, status, origin, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const g of goals) {
    insert.run(g.id, g.name, g.description, g.keywords, 'active', 'inferred', g.sort_order);
  }
}
