const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuid } = require('uuid');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', '..', 'workgraph.db');
console.log('DB path:', DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');
db.exec(`
  DROP TABLE IF EXISTS sync_log; DROP TABLE IF EXISTS metrics_snapshots;
  DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS item_tags;
  DROP TABLE IF EXISTS tags; DROP TABLE IF EXISTS work_items;
  DROP TABLE IF EXISTS projects; DROP TABLE IF EXISTS goals;
`);
console.log('Dropped existing tables');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE goals (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT,keywords TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'active',origin TEXT NOT NULL DEFAULT 'manual',sort_order INTEGER,item_count INTEGER DEFAULT 0,source_count INTEGER DEFAULT 0,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE projects (id TEXT PRIMARY KEY,goal_id TEXT REFERENCES goals(id),name TEXT NOT NULL,source TEXT NOT NULL,source_id TEXT,status TEXT DEFAULT 'active',metadata TEXT,created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE work_items (id TEXT PRIMARY KEY,source TEXT NOT NULL,source_id TEXT NOT NULL,item_type TEXT NOT NULL,title TEXT NOT NULL,body TEXT,author TEXT,status TEXT,priority TEXT,url TEXT,metadata TEXT,created_at TEXT NOT NULL,updated_at TEXT,synced_at TEXT DEFAULT (datetime('now')),UNIQUE(source, source_id));
  CREATE TABLE tags (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,category TEXT);
  CREATE TABLE item_tags (item_id TEXT REFERENCES work_items(id),tag_id TEXT REFERENCES tags(id),confidence REAL DEFAULT 1.0,PRIMARY KEY (item_id, tag_id));
  CREATE TABLE links (id TEXT PRIMARY KEY,source_item_id TEXT REFERENCES work_items(id),target_item_id TEXT REFERENCES work_items(id),link_type TEXT NOT NULL,confidence REAL DEFAULT 1.0,created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE metrics_snapshots (id TEXT PRIMARY KEY,goal_id TEXT REFERENCES goals(id),snapshot_date TEXT NOT NULL,total_items INTEGER,done_items INTEGER,active_items INTEGER,stale_items INTEGER,velocity_7d REAL,avg_cycle_time_days REAL,cross_ref_count INTEGER,metadata TEXT,UNIQUE(goal_id, snapshot_date));
  CREATE TABLE sync_log (id TEXT PRIMARY KEY,source TEXT NOT NULL,started_at TEXT NOT NULL,completed_at TEXT,items_synced INTEGER DEFAULT 0,status TEXT DEFAULT 'running',error TEXT);
  CREATE INDEX idx_items_source ON work_items(source);
  CREATE INDEX idx_items_status ON work_items(status);
  CREATE INDEX idx_items_created ON work_items(created_at);
  CREATE INDEX idx_item_tags_item ON item_tags(item_id);
  CREATE INDEX idx_item_tags_tag ON item_tags(tag_id);
  CREATE INDEX idx_links_source ON links(source_item_id);
  CREATE INDEX idx_links_target ON links(target_item_id);
  CREATE INDEX idx_metrics_goal_date ON metrics_snapshots(goal_id, snapshot_date);
  CREATE INDEX idx_sync_source ON sync_log(source, completed_at);
`);
console.log('Schema created');

const goals = [
  { id: 'ai-copilot', name: 'AI / Copilot Leadership', description: 'Agent pipeline, LLM models, accuracy metrics, Otti Copilot', keywords: ['copilot','agent','pipeline','llm','gpt','gemini','accuracy','ai','otti copilot','mcp','claude','otti assistant','ml','model','prediction','data science','struct'], sort_order: 1 },
  { id: 'platform', name: 'Platform Modernization', description: 'Django microservices, Celery Lambda, bundle size, infra', keywords: ['django','microservice','celery','lambda','bundle','infra','migration','platform','ottiapi','api gateway','terraform','devops','ci','cd','deploy','docker','ecs','architecture','tdd process','paas','openapi'], sort_order: 2 },
  { id: 'revenue', name: 'Revenue & Retention', description: 'VendorPay, activation, gross retention, churn, upsell', keywords: ['vendorpay','activation','retention','churn','upsell','revenue','gross retention','pay','payment','billing','ach','bank','dwolla'], sort_order: 3 },
  { id: 'integrations', name: 'Integration Excellence', description: 'Data Dash, ERP connectors, Acumatica, partner experience', keywords: ['data dash','erp','acumatica','connector','partner','integration','pex','ftp','export','import','account build','onboarding project'], sort_order: 4 },
  { id: 'ops', name: 'Operational Excellence', description: 'R2 release, stabilization marathon, QA, bug burndown', keywords: ['r2','stabilization','qa','bug','burndown','on-call','release','sprint','hotfix','incident','fix','security','approval','appa'], sort_order: 5 },
  { id: 'onboarding', name: 'Fast Onboarding', description: 'Login revamp, passkeys, onboarding flow, time-to-value', keywords: ['login','passkey','onboarding','time-to-value','signup','totp','welcome','implementation','account setup'], sort_order: 6 },
];
const insertGoal = db.prepare('INSERT INTO goals (id,name,description,keywords,status,origin,sort_order) VALUES (?,?,?,?,?,?,?)');
for (const g of goals) insertGoal.run(g.id, g.name, g.description, JSON.stringify(g.keywords), 'active', 'inferred', g.sort_order);
console.log('Seeded ' + goals.length + ' goals');

const insertItem = db.prepare('INSERT OR IGNORE INTO work_items (id,source,source_id,item_type,title,body,author,status,priority,url,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
function normalizeStatus(raw) {
  if (!raw) return 'open';
  const s = raw.toLowerCase();
  if (s.includes('done')||s.includes('merged')||s.includes('closed')||s.includes('resolved')||s.includes('complete')) return 'done';
  if (s.includes('progress')||s.includes('review')||s.includes('active')) return 'in_progress';
  if (s.includes('stale')||s.includes('blocked')) return 'stale';
  return 'open';
}
function parseDate(raw) {
  if (!raw) return new Date().toISOString();
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// 1. Jira
let count = 0;
try {
  const jira = JSON.parse(fs.readFileSync(path.join(__dirname, 'jira.json'), 'utf8'));
  for (const issue of jira) {
    insertItem.run(uuid(), 'jira', issue.key, issue.issueType||'task', issue.summary, null, issue.assignee||null, normalizeStatus(issue.status), issue.priority||null, issue.url, JSON.stringify({labels:issue.labels||[]}), parseDate(issue.created), parseDate(issue.updated));
    count++;
  }
  console.log('Jira: inserted ' + count + ' items');
} catch(e) { console.error('Jira error:', e.message); }

// 2. Slack
count = 0;
try {
  const slack = JSON.parse(fs.readFileSync(path.join(__dirname, 'slack.json'), 'utf8'));
  for (const msg of slack) {
    insertItem.run(uuid(), 'slack', 'slack-'+uuid().slice(0,8), 'message', msg.text.slice(0,200), msg.text, msg.author||null, 'done', null, msg.url||null, JSON.stringify({channel:msg.channel}), parseDate(msg.date), parseDate(msg.date));
    count++;
  }
  console.log('Slack: inserted ' + count + ' items');
} catch(e) { console.error('Slack error:', e.message); }

// 3. Meetings
count = 0;
try {
  const meetings = JSON.parse(fs.readFileSync(path.join(__dirname, 'meetings.json'), 'utf8'));
  for (const m of meetings) {
    insertItem.run(uuid(), 'granola', m.id, 'meeting', m.title, m.summary||null, (m.participants&&m.participants[0])||null, 'done', null, m.url||null, JSON.stringify({participants:m.participants||[]}), parseDate(m.date), parseDate(m.date));
    count++;
  }
  console.log('Meetings: inserted ' + count + ' items');
} catch(e) { console.error('Meetings error:', e.message); }

// 4. Notion
count = 0;
try {
  const notion = JSON.parse(fs.readFileSync(path.join(__dirname, 'notion.json'), 'utf8'));
  for (const page of notion) {
    insertItem.run(uuid(), 'notion', page.id, page.type||'page', page.title, null, null, 'active', null, page.url||null, null, parseDate(page.date), parseDate(page.date));
    count++;
  }
  console.log('Notion: inserted ' + count + ' items');
} catch(e) { console.error('Notion error:', e.message); }

// 5. Classification
console.log('\nRunning classification...');
const allItems = db.prepare('SELECT id, title, body FROM work_items').all();
const activeGoals = db.prepare("SELECT id, keywords FROM goals WHERE status = 'active'").all();
const insertTag = db.prepare("INSERT OR IGNORE INTO tags (id, name, category) VALUES (?, ?, 'goal')");
const insertItemTag = db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence) VALUES (?, ?, ?)');
let classified = 0;
for (const item of allItems) {
  const text = (item.title + ' ' + (item.body || '')).toLowerCase();
  for (const goal of activeGoals) {
    const keywords = JSON.parse(goal.keywords);
    let matchCount = 0;
    for (const kw of keywords) { if (text.includes(kw.toLowerCase())) matchCount++; }
    if (matchCount > 0) {
      const confidence = Math.min(1.0, matchCount * 0.3 + 0.4);
      insertTag.run(goal.id, goal.id);
      insertItemTag.run(item.id, goal.id, confidence);
      classified++;
    }
  }
}
console.log('Classification: ' + classified + ' item-goal associations');

// 6. Cross-referencing
console.log('Running cross-referencing...');
const JIRA_KEY_RE = /[A-Z][A-Z0-9]+-\d+/g;
const insertLink = db.prepare('INSERT INTO links (id, source_item_id, target_item_id, link_type, confidence) VALUES (?,?,?,?,?)');
let linkCount = 0;
for (const item of allItems) {
  const text = item.title + ' ' + (item.body || '');
  const jiraKeys = [...new Set(text.match(JIRA_KEY_RE) || [])];
  for (const key of jiraKeys) {
    const target = db.prepare("SELECT id FROM work_items WHERE source = 'jira' AND source_id = ?").get(key);
    if (target && target.id !== item.id) {
      insertLink.run(uuid(), item.id, target.id, 'mentions', 1.0);
      linkCount++;
    }
  }
}
console.log('Cross-refs: ' + linkCount + ' links created');

// 7. Metrics
console.log('Computing metrics...');
const today = new Date().toISOString().split('T')[0];
for (const goal of activeGoals) {
  const counts = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN wi.status=\'done\' THEN 1 ELSE 0 END) as done, SUM(CASE WHEN wi.status IN (\'open\',\'in_progress\') THEN 1 ELSE 0 END) as active, SUM(CASE WHEN wi.status=\'stale\' THEN 1 ELSE 0 END) as stale FROM item_tags it JOIN work_items wi ON wi.id=it.item_id WHERE it.tag_id=?').get(goal.id);
  const linkCnt = db.prepare('SELECT COUNT(*) as c FROM links WHERE source_item_id IN (SELECT item_id FROM item_tags WHERE tag_id=?) OR target_item_id IN (SELECT item_id FROM item_tags WHERE tag_id=?)').get(goal.id, goal.id);
  db.prepare('INSERT OR REPLACE INTO metrics_snapshots (id,goal_id,snapshot_date,total_items,done_items,active_items,stale_items,velocity_7d,cross_ref_count) VALUES (?,?,?,?,?,?,?,?,?)').run(uuid(), goal.id, today, counts.total||0, counts.done||0, counts.active||0, counts.stale||0, 0, linkCnt.c||0);
}
db.prepare("UPDATE goals SET item_count=(SELECT COUNT(*) FROM item_tags WHERE tag_id=goals.id), source_count=(SELECT COUNT(DISTINCT wi.source) FROM item_tags it JOIN work_items wi ON wi.id=it.item_id WHERE it.tag_id=goals.id), updated_at=datetime('now')").run();

// 8. Sync log
const now = new Date().toISOString();
for (const src of ['jira','slack','granola','notion']) {
  const cnt = db.prepare('SELECT COUNT(*) as c FROM work_items WHERE source=?').get(src);
  db.prepare('INSERT INTO sync_log (id,source,started_at,completed_at,items_synced,status) VALUES (?,?,?,?,?,?)').run(uuid(), src, now, now, cnt.c, 'complete');
}

// Summary
console.log('\n=== Database Summary ===');
console.log('Total work items: ' + db.prepare('SELECT COUNT(*) as c FROM work_items').get().c);
console.log('Total cross-refs: ' + db.prepare('SELECT COUNT(*) as c FROM links').get().c);
console.log('Total goal associations: ' + db.prepare('SELECT COUNT(*) as c FROM item_tags').get().c);
console.log('\nGoal breakdown:');
for (const goal of activeGoals) {
  const g = db.prepare('SELECT name, item_count, source_count FROM goals WHERE id=?').get(goal.id);
  console.log('  ' + g.name + ': ' + g.item_count + ' items from ' + g.source_count + ' sources');
}
console.log('\nBy source:');
db.prepare('SELECT source, COUNT(*) as c FROM work_items GROUP BY source').all().forEach(s => console.log('  ' + s.source + ': ' + s.c));

db.close();
console.log('\nDone!');
