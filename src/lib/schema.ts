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
    CREATE INDEX IF NOT EXISTS idx_versions_item ON work_item_versions(item_id);
    CREATE INDEX IF NOT EXISTS idx_versions_changed ON work_item_versions(changed_at);

    CREATE TABLE IF NOT EXISTS otti_sessions (
      id TEXT PRIMARY KEY,
      ts_start TEXT NOT NULL,
      ts_end TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      persona TEXT NOT NULL,
      intent TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      model TEXT NOT NULL,
      repo_name TEXT,
      num_events INTEGER NOT NULL,
      duration_s REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS otti_deployments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      deploy_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS otti_users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      title TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_otti_ts ON otti_sessions(ts_start);
    CREATE INDEX IF NOT EXISTS idx_otti_user ON otti_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_otti_intent ON otti_sessions(intent);
    CREATE INDEX IF NOT EXISTS idx_otti_persona ON otti_sessions(persona);
    CREATE INDEX IF NOT EXISTS idx_otti_model ON otti_sessions(model);
  `);
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

export function seedOttiUsers() {
  const db = getDb();
  const users: [string, string, string][] = [
    ['U03DRPJSAGL', 'Arun V', 'Engineering'],
    ['U0AB8NZGWGY', 'Salvador Gallo', 'Product Support'],
    ['U08E107596K', 'Brittany Leclerc', ''],
    ['U09DG4MNARJ', 'Cody Towstik', 'Sr. Software Engineer'],
    ['U06M91QHS0P', 'Hemalatha K', 'Sr. Software Engineer (QA)'],
    ['U09TTU07X9R', 'Josh Rupert', 'PM - Partners'],
    ['U07RD1MNQPJ', 'Abhishek Goyal', 'Product Manager'],
    ['U09U09ZCSHY', 'Oswald Ochoa', 'Product Support L1'],
    ['U04H4UV2PDM', 'Joe Lombardi', 'Dir, Solutions Engineers'],
    ['U08QWTQ5WPL', 'Benjamin Covarrubias', 'Product Support'],
    ['U0378A39BKM', 'Vivek Rajwar', 'Engineering Manager'],
    ['U0415JPSLRF', 'Pampapati Shetty', 'Sr. Software Engineer - FE'],
    ['U07UJCQSMRP', 'Paulina Soto', 'Product Support L2'],
    ['U0A1TFB784T', 'Xochitl Torres', 'Product Support I'],
    ['U0A3ZP1P1DH', 'Gus Fernandes', 'Sr. Backend Engineer'],
    ['U097S5L33BM', 'Ameer', ''],
    ['U09TXRU84SC', 'Nicolas Battisti', 'Sr. Backend Developer'],
    ['U06NFNF3ZPG', 'Luke Detering', 'Principal PM'],
    ['UK2U1Q64S', 'Lena', 'Team Lead, Product Support'],
    ['U0398FCA3LZ', 'Rohit Gupta', 'Sr. Software Engineer (QA)'],
    ['U038ASQFM9B', 'Melissa Joukema', 'Sr. Manager, Product Support'],
    ['U05NBM1V46L', 'Raja Ram', 'Sr. Software Engineer (QA)'],
    ['U08RURGJR1R', 'Mahesh', 'SSE [Core]'],
    ['U02SHJG8U1J', 'Sushma Yadav', ''],
    ['U09JTS8QQKG', 'Chirag Shah', 'Sr. Software Engineer'],
    ['U09MDPP34N4', 'Varun Mhatre', ''],
    ['U089ZDCFUJJ', 'Elyse Williams', 'Sr. Manager, Customer Marketing'],
    ['U097UQVD28Y', 'David Bobadilla', ''],
    ['U09H0SAJC9L', 'Nishant Agarwal', ''],
    ['U09PWMF2XA4', 'Sai Charan', ''],
    ['U05A05LM547', 'Sembiyan', 'Lead PM, SRM & Spend'],
    ['U01EN687GHF', 'Kit Zorsch', 'Sr. Onboarding Specialist'],
    ['U06HHJ2R4PK', 'Abul Niyaz', 'Product Support'],
    ['U06T7HA1G0G', 'Bhakti Bhikne', 'Sr. Product Designer'],
    ['U02PB501KFT', 'Ben Spiegel', 'Product Management'],
    ['U096X31HPB5', 'Jeevanandam', ''],
    ['U019WEFQCLU', 'Kevin Leduc', 'Dir of Engineering'],
    ['U06KL4570', 'Krishna J', 'Engineering'],
    ['U0AL5FFD1D3', 'Jerry Love', 'Sr. PM - Integrations'],
    ['U086CUZE1FB', 'Puru Tiwari', 'Sr. Software Engineer'],
    ['U0A0L23G5FX', 'Mitul Rawat', 'Backend Developer'],
    ['U0998ARB9K4', 'Fayez Nazir', 'Solutions Architect'],
    ['U06UGHHB2TE', 'Eduardo Leon', 'Integrations Engineer'],
    ['U050VFGV7GT', 'Jake Hirsch', 'Solutions Engineer'],
    ['U05FZFKJUMT', 'Michael MacCormack', 'Staff Engineer'],
    ['U08ENQAMZG8', 'Eashan Bajaj', 'Sr. PM - Reports & AI'],
    ['U02NDR7JT0F', 'Ivan Zlatev', 'Sr. EM - Integrations'],
    ['U08AG9R403F', 'Harshil Khant', ''],
    ['U024TUMAEE9', 'Oliver Smith', 'Data Analyst'],
    ['U02SCC25XAR', 'Sumit Tawal', 'Engineer - V3 & Core'],
    ['U07JA9ETX7B', 'Kori Bowling', 'Enterprise CSM'],
    ['U04797AMJ78', 'Jess Law', 'Sr. Onboarding Specialist'],
    ['U0493MY38FM', 'Badal Harplani', 'SSE - VendorPay'],
    ['U054K8BV2TU', 'Nitin Mishra', 'SSE [Payment & Spend]'],
    ['U05DFM8P7HV', 'Chandresh Singh', 'Sr. Software Engineer - Core'],
    ['U07MDHP2WKW', 'Kanhaya Yadav', 'Software Engineer'],
    ['U09QGV6UE93', 'Anunaya Srivastava', 'Staff Software Engineer'],
    ['UQA3TQK2N', 'Collette Wojdylo', 'Manager, Onboarding'],
    ['UUDFU5BC3', 'Rupesh Mishra', 'Engineer'],
    ['U02QFB7UFPE', 'AJ Lightfoot', 'Team Lead, Product Support'],
    ['U07U5N2HUQJ', 'Jono Bowles', 'Product Management'],
    ['U08SKB6U9B8', 'Olivia Ivory', ''],
    ['UTLJPMYP8', 'Gayathri Raikar', 'SDET - VendorPay'],
    ['U03CYV8LFHB', 'Lenny Gumm', 'Team Lead, CS'],
    ['U06KKUQQECC', 'Manigandan Ganesan', 'EM - PaaS & Integrations'],
    ['U075X11DBKN', 'Hannia Mojica', 'Manager, Vendor Ops'],
    ['U09183EDR08', 'Peter Niu', 'PM - APIs and SDK'],
    ['U09ESA9UCA3', 'Prateek Mishra', 'Staff Software Engineer'],
    ['U09SX53J99R', 'Jason Boyles', 'Sr. Dir, Product Mgmt'],
    ['U0AHKD0G42C', 'Kajal', ''],
    ['U0AN1HW18TW', 'Anna Lobacheva', 'Principal PM - Payments'],
    ['U1X3U4656', 'Leah', 'Team Lead, Product Support'],
    ['U033SFRL45R', 'Kristopher Tapper', 'Integration Specialist'],
    ['U04478QTL7P', 'Jesus Oropeza', 'Technical Onboarding Mgr'],
    ['U04K9B74SSX', 'Sathya Viswanathan', 'Sr. Dir, Product Mgmt'],
    ['U04TMT11X0S', 'Stockton Sheehan', ''],
    ['U05K9D47SDQ', 'Matt Wallach', 'Partner Manager'],
    ['U0711AAB7UZ', 'Sam Suppipat', 'Manager, Enterprise CS'],
    ['U0774K8799P', 'Mariana Barragan', 'Product Support'],
    ['U098C77E6FP', 'Ushank R', 'Sr. Software Engineer'],
    ['U09PWMG0VME', 'Om Prakash', ''],
    ['U0A644HURB2', 'Zach Svendsen', ''],
    ['U0MKSTM1R', 'Arturo Inzunza', 'Engineer'],
    ['U02V8868VCY', 'Anchal Gupta', ''],
    ['U06A3EAHHAA', 'Gopika Sodani', 'Sr. Software Engineer - Core'],
    ['U06HXEH4QP5', 'Daniel Giaconi', 'Finance Manager'],
    ['U07HAUG5T89', 'Heather Wright', 'Enterprise CSM'],
    ['U09BUA66UF8', 'Paarth Bhatnagar', 'Sr. ML Engineer'],
    ['UT11YBBFC', 'Brandon Nembhard', 'Team Lead, Payment Ops'],
    ['U01FRT85H61', 'Savita Praveen', 'Engineering Manager'],
    ['U030Q4XLFH8', 'Stephanie Strange', 'Professional Services'],
    ['U03K2849G2X', 'Apoorva Rashmi', 'Dir, HR & Operations'],
    ['U041TLML0KX', 'Kartikeya Sharma', 'Sr. Software Engineer - BE'],
    ['U06JBN366DQ', 'Raeef', 'Customer Success Manager'],
    ['U06K6AXP8VC', 'Vivek Tiwari', 'Full Stack Engineer'],
    ['U078UNSDHK5', 'Daniel Hernandez', 'Assoc. Integrations Specialist'],
    ['U07A3DC0EC9', 'Swapnil Patil', 'PM - Core AP'],
    ['U08JCTCJD3R', 'Tatii Fairley', 'Onboarding Specialist'],
    ['U09B78DAJUW', 'Sanjanaa RS', 'Sr. Product Manager'],
    ['U09NPE6461X', 'Mel Faubert', 'Sr. Solutions Manager'],
    ['U0A0RBDGW', 'Erin Whitney', 'Dir, EDI & Data Ops'],
    ['US6V8C6TS', 'Pankaj Yadav', 'Sr. Software Engineer'],
  ];

  const upsert = db.prepare(
    'INSERT OR REPLACE INTO otti_users (user_id, display_name, title) VALUES (?, ?, ?)'
  );
  for (const [uid, name, title] of users) {
    upsert.run(uid, name, title);
  }
}

export function migrateProjectSummaries() {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(project_summaries)").all() as { name: string }[];
  if (!cols.find(c => c.name === 'summary_generated_at')) {
    db.exec("ALTER TABLE project_summaries ADD COLUMN summary_generated_at TEXT");
  }
}

export function seedOttiDeployments() {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) as c FROM otti_deployments').get() as { c: number };
  if (existing.c > 0) return;

  db.prepare(
    "INSERT INTO otti_deployments (id, name, deploy_date) VALUES (?, ?, ?)"
  ).run('codemesh-v1', 'Codemesh Integration', '2026-04-15');
}
