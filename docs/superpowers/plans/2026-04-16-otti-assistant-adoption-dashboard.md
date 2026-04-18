# Otti Assistant Adoption Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Otti Assistant" tab to the WorkGraph Tracker showing adoption metrics, usage patterns, performance stats, and deployment comparison — powered by session transcript JSONL files ingested into SQLite.

**Architecture:** Ingest script reads JSONL session transcripts into `otti_sessions` table in `workgraph.db`. A single API route computes all metrics server-side via SQL. A client-side page with period selector and compare toggle renders five sections: header, adoption, usage, performance, engagement.

**Tech Stack:** Next.js 14 App Router, better-sqlite3, TypeScript, Tailwind CSS, Radix UI primitives

**Spec:** `docs/superpowers/specs/2026-04-16-otti-assistant-adoption-dashboard-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `scripts/ingest-otti-sessions.ts` | Read JSONL files, upsert into otti_sessions table |
| Modify | `src/lib/schema.ts` | Add otti_sessions + otti_deployments table creation |
| Create | `src/lib/otti-queries.ts` | All SQL queries for otti metrics (normal + compare mode) |
| Create | `src/app/api/otti/sessions/route.ts` | GET endpoint returning computed metrics JSON |
| Create | `src/app/api/otti/deployments/route.ts` | GET/POST for deployment markers |
| Create | `src/app/otti/page.tsx` | Server component shell (init schema, render client) |
| Create | `src/app/otti/otti-client.tsx` | Client component — fetches data, renders all sections |
| Create | `src/components/otti/period-selector.tsx` | Period pill buttons |
| Create | `src/components/otti/compare-controls.tsx` | Compare toggle + deployment dropdown + date input |
| Create | `src/components/otti/breakdown-bar.tsx` | Segmented bar + legend (intent, persona, model, agent) |
| Create | `src/components/otti/speed-table.tsx` | Tabular speed metrics with delta columns |
| Create | `src/components/otti/volume-chart.tsx` | Daily bar chart with optional split-date marker |
| Create | `src/components/otti/hourly-heatmap.tsx` | 24h x N-days intensity grid |
| Modify | `src/components/topbar.tsx` | Add "Otti Assistant" nav item |

---

### Task 1: Schema — Add otti_sessions and otti_deployments tables

**Files:**
- Modify: `src/lib/schema.ts` (append to `initSchema()`)

- [ ] **Step 1: Add table definitions to initSchema()**

In `src/lib/schema.ts`, add the following SQL at the end of the `db.exec()` template literal in `initSchema()`, just before the closing backtick:

```sql
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

CREATE INDEX IF NOT EXISTS idx_otti_ts ON otti_sessions(ts_start);
CREATE INDEX IF NOT EXISTS idx_otti_user ON otti_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_otti_intent ON otti_sessions(intent);
CREATE INDEX IF NOT EXISTS idx_otti_persona ON otti_sessions(persona);
CREATE INDEX IF NOT EXISTS idx_otti_model ON otti_sessions(model);
```

- [ ] **Step 2: Verify tables are created**

```bash
cd ~/Documents/Tracker/workgraph && npx tsx scripts/init-db.ts
```

Expected: script runs without errors, output includes `otti_sessions` and `otti_deployments` in the tables list.

- [ ] **Step 3: Seed initial deployment marker**

Add a `seedOttiDeployments()` function in `src/lib/schema.ts`:

```typescript
export function seedOttiDeployments() {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) as c FROM otti_deployments').get() as { c: number };
  if (existing.c > 0) return;

  db.prepare(
    "INSERT INTO otti_deployments (id, name, deploy_date) VALUES (?, ?, ?)"
  ).run('codemesh-v1', 'Codemesh Integration', '2026-04-15');
}
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/schema.ts
git commit -m "feat(otti): add otti_sessions and otti_deployments schema"
```

---

### Task 2: Ingest Script

**Files:**
- Create: `scripts/ingest-otti-sessions.ts`

- [ ] **Step 1: Create the ingest script**

Create `scripts/ingest-otti-sessions.ts`:

```typescript
import { getDb } from '../src/lib/db';
import { initSchema, seedOttiDeployments } from '../src/lib/schema';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_SOURCE = path.join(
  process.env.HOME || '~',
  'Documents/code/ottiassistant/data/transcripts/sessions'
);

function main() {
  const sourceDir = process.argv[2] || DEFAULT_SOURCE;
  console.log(`Ingesting sessions from: ${sourceDir}`);

  if (!fs.existsSync(sourceDir)) {
    console.error(`Source directory not found: ${sourceDir}`);
    process.exit(1);
  }

  initSchema();
  seedOttiDeployments();
  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO otti_sessions (id, ts_start, ts_end, user_id, channel_id, persona, intent, agent_type, model, repo_name, num_events, duration_s)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ts_start=excluded.ts_start, ts_end=excluded.ts_end, user_id=excluded.user_id,
      channel_id=excluded.channel_id, persona=excluded.persona, intent=excluded.intent,
      agent_type=excluded.agent_type, model=excluded.model, repo_name=excluded.repo_name,
      num_events=excluded.num_events, duration_s=excluded.duration_s
  `);

  const dateDirs = fs.readdirSync(sourceDir).filter(d =>
    fs.statSync(path.join(sourceDir, d)).isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d)
  ).sort();

  let total = 0;
  let errors = 0;

  const insertMany = db.transaction((rows: any[]) => {
    for (const r of rows) {
      upsert.run(r.id, r.ts_start, r.ts_end, r.user_id, r.channel_id, r.persona, r.intent, r.agent_type, r.model, r.repo_name, r.num_events, r.duration_s);
    }
  });

  for (const dateDir of dateDirs) {
    const dirPath = path.join(sourceDir, dateDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    const batch: any[] = [];

    for (const file of files) {
      try {
        const lines = fs.readFileSync(path.join(dirPath, file), 'utf-8').trim().split('\n');
        if (lines.length === 0 || !lines[0]) continue;

        const first = JSON.parse(lines[0]);
        const last = JSON.parse(lines[lines.length - 1]);

        const tsStart = first.ts || '';
        const tsEnd = last.ts || tsStart;

        let durationS = 0;
        try {
          durationS = (new Date(tsEnd).getTime() - new Date(tsStart).getTime()) / 1000;
          if (durationS < 0) durationS = 0;
        } catch { /* keep 0 */ }

        batch.push({
          id: first.task_id || path.basename(file, '.jsonl'),
          ts_start: tsStart,
          ts_end: tsEnd,
          user_id: first.user_id || '',
          channel_id: first.channel_id || '',
          persona: first.persona || 'unknown',
          intent: first.intent || 'unknown',
          agent_type: first.agent_type || 'unknown',
          model: first.model || 'unknown',
          repo_name: first.repo_name || null,
          num_events: lines.length,
          duration_s: durationS,
        });
        total++;
      } catch (e) {
        errors++;
      }
    }

    if (batch.length > 0) {
      insertMany(batch);
      console.log(`  ${dateDir}: ${batch.length} sessions`);
    }
  }

  const count = (db.prepare('SELECT COUNT(*) as c FROM otti_sessions').get() as { c: number }).c;
  console.log(`\nDone. Ingested ${total} sessions (${errors} errors). Total in DB: ${count}`);
}

main();
```

- [ ] **Step 2: Run the ingest**

```bash
cd ~/Documents/Tracker/workgraph && npx tsx scripts/ingest-otti-sessions.ts
```

Expected: output showing each date directory processed, total count matching the ~400+ sessions across all dates.

- [ ] **Step 3: Verify data**

```bash
cd ~/Documents/Tracker/workgraph && npx tsx -e "
  const { getDb } = require('./src/lib/db');
  const db = getDb();
  console.log(db.prepare('SELECT COUNT(*) as c FROM otti_sessions').get());
  console.log(db.prepare('SELECT intent, COUNT(*) as c FROM otti_sessions GROUP BY intent ORDER BY c DESC').all());
  console.log(db.prepare('SELECT * FROM otti_deployments').all());
"
```

- [ ] **Step 4: Commit**

```bash
git add scripts/ingest-otti-sessions.ts
git commit -m "feat(otti): add session transcript ingest script"
```

---

### Task 3: Query Layer — otti-queries.ts

**Files:**
- Create: `src/lib/otti-queries.ts`

- [ ] **Step 1: Create the query module**

Create `src/lib/otti-queries.ts`. This file contains all SQL logic. The API route just calls these functions.

```typescript
import { getDb } from './db';

interface KPI {
  value: number;
  prior: number;
  delta_pct: number;
}

interface BreakdownItem {
  name: string;
  count: number;
  pct: number;
}

interface SpeedByDimension {
  name: string;
  median: number;
  p90: number;
  delta_median_pct: number;
}

interface TopUser {
  user_id: string;
  sessions: number;
  persona: string;
  top_intents: string[];
  avg_duration_s: number;
}

interface DailyVolume {
  date: string;
  count: number;
}

interface SpeedBucket {
  label: string;
  count: number;
  pct: number;
}

export interface OttiMetrics {
  period: string;
  range: { start: string; end: string };
  prior: { start: string; end: string };
  compare_mode: boolean;
  split_date: string | null;
  kpis: {
    conversations: KPI;
    unique_users: KPI;
    sessions_per_user: KPI;
    median_speed_s: KPI;
    p90_speed_s: KPI;
    p95_speed_s: KPI;
  };
  daily_volume: DailyVolume[];
  intents: BreakdownItem[];
  personas: BreakdownItem[];
  models: BreakdownItem[];
  agent_types: BreakdownItem[];
  hourly_heatmap: Record<string, number[]>;
  speed_by_intent: SpeedByDimension[];
  speed_by_model: SpeedByDimension[];
  speed_by_persona: SpeedByDimension[];
  speed_buckets: SpeedBucket[];
  top_users: TopUser[];
  single_event_count: number;
  single_event_pct: number;
}

function periodToDays(period: string): number | null {
  switch (period) {
    case '7d': return 7;
    case '30d': return 30;
    case '90d': return 90;
    default: return null; // 'all'
  }
}

function dateRange(period: string): { start: string; end: string; priorStart: string; priorEnd: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const days = periodToDays(period);

  if (!days) {
    // 'all' — get min date from data
    const db = getDb();
    const row = db.prepare('SELECT MIN(ts_start) as m FROM otti_sessions').get() as { m: string } | undefined;
    const minDate = row?.m?.slice(0, 10) || end;
    return { start: minDate, end, priorStart: minDate, priorEnd: minDate };
  }

  const start = new Date(now);
  start.setDate(start.getDate() - days);
  const startStr = start.toISOString().slice(0, 10);

  const priorEnd = startStr;
  const priorStart = new Date(start);
  priorStart.setDate(priorStart.getDate() - days);
  const priorStartStr = priorStart.toISOString().slice(0, 10);

  return { start: startStr, end, priorStart: priorStartStr, priorEnd };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const k = (sorted.length - 1) * p / 100;
  const f = Math.floor(k);
  const c = Math.min(f + 1, sorted.length - 1);
  return sorted[f] + (k - f) * (sorted[c] - sorted[f]);
}

function deltaPct(current: number, prior: number): number {
  if (prior === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - prior) / prior) * 100);
}

function queryBreakdown(start: string, end: string, column: string): BreakdownItem[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ${column} as name, COUNT(*) as count
    FROM otti_sessions
    WHERE ts_start >= ? AND ts_start < ?
    GROUP BY ${column}
    ORDER BY count DESC
  `).all(start, end + 'T23:59:59') as { name: string; count: number }[];

  const total = rows.reduce((s, r) => s + r.count, 0);
  return rows.map(r => ({
    name: r.name,
    count: r.count,
    pct: total > 0 ? Math.round(r.count / total * 1000) / 10 : 0,
  }));
}

function querySpeedByDimension(
  start: string, end: string,
  priorStart: string, priorEnd: string,
  column: string
): SpeedByDimension[] {
  const db = getDb();
  const currentRows = db.prepare(`
    SELECT ${column} as name, duration_s
    FROM otti_sessions
    WHERE ts_start >= ? AND ts_start < ? AND duration_s > 0
  `).all(start, end + 'T23:59:59') as { name: string; duration_s: number }[];

  const priorRows = db.prepare(`
    SELECT ${column} as name, duration_s
    FROM otti_sessions
    WHERE ts_start >= ? AND ts_start < ? AND duration_s > 0
  `).all(priorStart, priorEnd + 'T23:59:59') as { name: string; duration_s: number }[];

  const grouped = new Map<string, number[]>();
  const priorGrouped = new Map<string, number[]>();

  for (const r of currentRows) {
    if (!grouped.has(r.name)) grouped.set(r.name, []);
    grouped.get(r.name)!.push(r.duration_s);
  }
  for (const r of priorRows) {
    if (!priorGrouped.has(r.name)) priorGrouped.set(r.name, []);
    priorGrouped.get(r.name)!.push(r.duration_s);
  }

  return Array.from(grouped.entries()).map(([name, durations]) => {
    const priorDurations = priorGrouped.get(name) || [];
    const med = percentile(durations, 50);
    const priorMed = percentile(priorDurations, 50);
    return {
      name,
      median: Math.round(med),
      p90: Math.round(percentile(durations, 90)),
      delta_median_pct: deltaPct(med, priorMed) * -1, // negative = faster = good
    };
  }).sort((a, b) => b.median - a.median);
}

export function getOttiMetrics(period: string, compare: boolean, splitDate: string | null): OttiMetrics {
  const db = getDb();
  const { start, end, priorStart, priorEnd } = dateRange(period);

  // In compare mode, split the current range into before/after
  let currentStart = start;
  let currentEnd = end;
  let compStart = priorStart;
  let compEnd = priorEnd;

  if (compare && splitDate) {
    currentStart = splitDate;
    currentEnd = end;
    compStart = start;
    compEnd = splitDate;
  }

  const endTs = currentEnd + 'T23:59:59';
  const compEndTs = compEnd + 'T23:59:59';

  // --- KPIs ---
  const convoCurrent = (db.prepare(
    'SELECT COUNT(*) as c FROM otti_sessions WHERE ts_start >= ? AND ts_start < ?'
  ).get(currentStart, endTs) as { c: number }).c;

  const convoPrior = (db.prepare(
    'SELECT COUNT(*) as c FROM otti_sessions WHERE ts_start >= ? AND ts_start < ?'
  ).get(compStart, compEndTs) as { c: number }).c;

  const usersCurrent = (db.prepare(
    'SELECT COUNT(DISTINCT user_id) as c FROM otti_sessions WHERE ts_start >= ? AND ts_start < ?'
  ).get(currentStart, endTs) as { c: number }).c;

  const usersPrior = (db.prepare(
    'SELECT COUNT(DISTINCT user_id) as c FROM otti_sessions WHERE ts_start >= ? AND ts_start < ?'
  ).get(compStart, compEndTs) as { c: number }).c;

  const sessPerUser = usersCurrent > 0 ? Math.round(convoCurrent / usersCurrent * 10) / 10 : 0;
  const sessPerUserPrior = usersPrior > 0 ? Math.round(convoPrior / usersPrior * 10) / 10 : 0;

  // Speed percentiles
  const currentDurations = (db.prepare(
    'SELECT duration_s FROM otti_sessions WHERE ts_start >= ? AND ts_start < ? AND duration_s > 0'
  ).all(currentStart, endTs) as { duration_s: number }[]).map(r => r.duration_s);

  const priorDurations = (db.prepare(
    'SELECT duration_s FROM otti_sessions WHERE ts_start >= ? AND ts_start < ? AND duration_s > 0'
  ).all(compStart, compEndTs) as { duration_s: number }[]).map(r => r.duration_s);

  const medCurrent = percentile(currentDurations, 50);
  const medPrior = percentile(priorDurations, 50);
  const p90Current = percentile(currentDurations, 90);
  const p90Prior = percentile(priorDurations, 90);
  const p95Current = percentile(currentDurations, 95);
  const p95Prior = percentile(priorDurations, 95);

  // --- Daily Volume ---
  const dailyRows = db.prepare(`
    SELECT DATE(ts_start) as date, COUNT(*) as count
    FROM otti_sessions
    WHERE ts_start >= ? AND ts_start < ?
    GROUP BY DATE(ts_start)
    ORDER BY date ASC
  `).all(start, end + 'T23:59:59') as DailyVolume[];

  // --- Breakdowns ---
  const intents = queryBreakdown(currentStart, currentEnd, 'intent');
  const personas = queryBreakdown(currentStart, currentEnd, 'persona');
  const models = queryBreakdown(currentStart, currentEnd, 'model');
  const agentTypes = queryBreakdown(currentStart, currentEnd, 'agent_type');

  // --- Hourly Heatmap ---
  const hourlyRows = db.prepare(`
    SELECT DATE(ts_start) as date, CAST(strftime('%H', ts_start) AS INTEGER) as hour, COUNT(*) as count
    FROM otti_sessions
    WHERE ts_start >= ? AND ts_start < ?
    GROUP BY date, hour
  `).all(start, end + 'T23:59:59') as { date: string; hour: number; count: number }[];

  const heatmap: Record<string, number[]> = {};
  for (const r of hourlyRows) {
    if (!heatmap[r.date]) heatmap[r.date] = new Array(24).fill(0);
    heatmap[r.date][r.hour] = r.count;
  }

  // --- Speed by dimension ---
  const speedByIntent = querySpeedByDimension(currentStart, currentEnd, compStart, compEnd, 'intent');
  const speedByModel = querySpeedByDimension(currentStart, currentEnd, compStart, compEnd, 'model');
  const speedByPersona = querySpeedByDimension(currentStart, currentEnd, compStart, compEnd, 'persona');

  // --- Speed Buckets ---
  const bucketDefs = [
    { label: '< 1m', min: 0, max: 60 },
    { label: '1-2m', min: 60, max: 120 },
    { label: '2-3m', min: 120, max: 180 },
    { label: '3-5m', min: 180, max: 300 },
    { label: '5-10m', min: 300, max: 600 },
    { label: '> 10m', min: 600, max: 999999 },
  ];
  const speedBuckets: SpeedBucket[] = bucketDefs.map(b => {
    const count = currentDurations.filter(d => d >= b.min && d < b.max).length;
    return {
      label: b.label,
      count,
      pct: currentDurations.length > 0 ? Math.round(count / currentDurations.length * 1000) / 10 : 0,
    };
  });

  // --- Top Users ---
  const topUserRows = db.prepare(`
    SELECT user_id, COUNT(*) as sessions, AVG(duration_s) as avg_dur
    FROM otti_sessions
    WHERE ts_start >= ? AND ts_start < ?
    GROUP BY user_id
    ORDER BY sessions DESC
    LIMIT 10
  `).all(currentStart, endTs) as { user_id: string; sessions: number; avg_dur: number }[];

  const topUsers: TopUser[] = topUserRows.map(u => {
    const personaRow = db.prepare(`
      SELECT persona, COUNT(*) as c FROM otti_sessions
      WHERE user_id = ? AND ts_start >= ? AND ts_start < ?
      GROUP BY persona ORDER BY c DESC LIMIT 1
    `).get(u.user_id, currentStart, endTs) as { persona: string; c: number } | undefined;

    const intentRows = db.prepare(`
      SELECT intent, COUNT(*) as c FROM otti_sessions
      WHERE user_id = ? AND ts_start >= ? AND ts_start < ?
      GROUP BY intent ORDER BY c DESC LIMIT 2
    `).all(u.user_id, currentStart, endTs) as { intent: string; c: number }[];

    return {
      user_id: u.user_id,
      sessions: u.sessions,
      persona: personaRow?.persona || 'unknown',
      top_intents: intentRows.map(i => i.intent),
      avg_duration_s: Math.round(u.avg_dur),
    };
  });

  // --- Single event ---
  const singleCount = (db.prepare(
    'SELECT COUNT(*) as c FROM otti_sessions WHERE ts_start >= ? AND ts_start < ? AND num_events <= 1'
  ).get(currentStart, endTs) as { c: number }).c;

  return {
    period,
    range: { start: currentStart, end: currentEnd },
    prior: { start: compStart, end: compEnd },
    compare_mode: compare,
    split_date: splitDate,
    kpis: {
      conversations: { value: convoCurrent, prior: convoPrior, delta_pct: deltaPct(convoCurrent, convoPrior) },
      unique_users: { value: usersCurrent, prior: usersPrior, delta_pct: deltaPct(usersCurrent, usersPrior) },
      sessions_per_user: { value: sessPerUser, prior: sessPerUserPrior, delta_pct: deltaPct(sessPerUser, sessPerUserPrior) },
      median_speed_s: { value: Math.round(medCurrent), prior: Math.round(medPrior), delta_pct: deltaPct(medCurrent, medPrior) },
      p90_speed_s: { value: Math.round(p90Current), prior: Math.round(p90Prior), delta_pct: deltaPct(p90Current, p90Prior) },
      p95_speed_s: { value: Math.round(p95Current), prior: Math.round(p95Prior), delta_pct: deltaPct(p95Current, p95Prior) },
    },
    daily_volume: dailyRows,
    intents,
    personas,
    models,
    agent_types: agentTypes,
    hourly_heatmap: heatmap,
    speed_by_intent: speedByIntent,
    speed_by_model: speedByModel,
    speed_by_persona: speedByPersona,
    speed_buckets: speedBuckets,
    top_users: topUsers,
    single_event_count: singleCount,
    single_event_pct: convoCurrent > 0 ? Math.round(singleCount / convoCurrent * 1000) / 10 : 0,
  };
}

export function getOttiDeployments() {
  const db = getDb();
  return db.prepare('SELECT * FROM otti_deployments ORDER BY deploy_date DESC').all();
}

export function createOttiDeployment(name: string, deployDate: string) {
  const db = getDb();
  const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  db.prepare(
    'INSERT OR REPLACE INTO otti_deployments (id, name, deploy_date) VALUES (?, ?, ?)'
  ).run(id, name, deployDate);
  return { id, name, deploy_date: deployDate };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/otti-queries.ts
git commit -m "feat(otti): add query layer for all otti metrics"
```

---

### Task 4: API Routes

**Files:**
- Create: `src/app/api/otti/sessions/route.ts`
- Create: `src/app/api/otti/deployments/route.ts`

- [ ] **Step 1: Create sessions API route**

Create `src/app/api/otti/sessions/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { getOttiMetrics } from '@/lib/otti-queries';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  initSchema();

  const params = req.nextUrl.searchParams;
  const period = params.get('period') || '7d';
  const compare = params.get('compare') === 'true';
  const splitDate = params.get('split_date') || null;

  const metrics = getOttiMetrics(period, compare, splitDate);
  return NextResponse.json(metrics);
}
```

- [ ] **Step 2: Create deployments API route**

Create `src/app/api/otti/deployments/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { initSchema } from '@/lib/schema';
import { getOttiDeployments, createOttiDeployment } from '@/lib/otti-queries';

export const dynamic = 'force-dynamic';

export function GET() {
  initSchema();
  return NextResponse.json(getOttiDeployments());
}

export async function POST(req: NextRequest) {
  initSchema();
  const body = await req.json();
  const { name, deploy_date } = body;

  if (!name || !deploy_date) {
    return NextResponse.json({ error: 'name and deploy_date required' }, { status: 400 });
  }

  const result = createOttiDeployment(name, deploy_date);
  return NextResponse.json(result, { status: 201 });
}
```

- [ ] **Step 3: Test API route**

```bash
cd ~/Documents/Tracker/workgraph && bun run dev &
sleep 3
curl -s 'http://localhost:3000/api/otti/sessions?period=all' | head -c 500
curl -s 'http://localhost:3000/api/otti/deployments'
```

Expected: JSON response with metrics data; deployments returns the codemesh seed entry.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/otti/
git commit -m "feat(otti): add sessions and deployments API routes"
```

---

### Task 5: Topbar — Add nav item

**Files:**
- Modify: `src/components/topbar.tsx`

- [ ] **Step 1: Add Otti Assistant to navItems**

In `src/components/topbar.tsx`, add to the `navItems` array (after Metrics, before Settings):

```typescript
const navItems = [
  { label: 'Overview', href: '/' },
  { label: 'Projects', href: '/projects' },
  { label: 'Knowledge', href: '/knowledge' },
  { label: 'Metrics', href: '/metrics' },
  { label: 'Otti Assistant', href: '/otti' },
  { label: 'Settings', href: '/settings' },
];
```

- [ ] **Step 2: Commit**

```bash
git add src/components/topbar.tsx
git commit -m "feat(otti): add Otti Assistant tab to navigation"
```

---

### Task 6: Shared Components — PeriodSelector, CompareControls, BreakdownBar

**Files:**
- Create: `src/components/otti/period-selector.tsx`
- Create: `src/components/otti/compare-controls.tsx`
- Create: `src/components/otti/breakdown-bar.tsx`

- [ ] **Step 1: Create PeriodSelector**

Create `src/components/otti/period-selector.tsx`:

```tsx
'use client';

import { cn } from '@/lib/utils';

const PERIODS = ['7d', '30d', '90d', 'all'] as const;
type Period = (typeof PERIODS)[number];

interface PeriodSelectorProps {
  value: string;
  onChange: (period: string) => void;
}

export function PeriodSelector({ value, onChange }: PeriodSelectorProps) {
  return (
    <div className="flex gap-[6px]">
      {PERIODS.map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={cn(
            "px-[14px] py-[5px] rounded-lg text-[0.74rem] border cursor-pointer transition-all",
            p === value
              ? "bg-black border-black text-white font-medium"
              : "bg-surface border-black/[0.07] text-g4 hover:border-black/[0.13]"
          )}
        >
          {p === 'all' ? 'All' : p.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create CompareControls**

Create `src/components/otti/compare-controls.tsx`:

```tsx
'use client';

import { cn } from '@/lib/utils';

interface Deployment {
  id: string;
  name: string;
  deploy_date: string;
}

interface CompareControlsProps {
  enabled: boolean;
  onToggle: () => void;
  splitDate: string;
  onSplitDateChange: (date: string) => void;
  deployments: Deployment[];
}

export function CompareControls({
  enabled,
  onToggle,
  splitDate,
  onSplitDateChange,
  deployments,
}: CompareControlsProps) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onToggle}
        className={cn(
          "px-[12px] py-[5px] rounded-lg text-[0.74rem] border cursor-pointer transition-all",
          enabled
            ? "bg-black border-black text-white font-medium"
            : "bg-surface border-black/[0.07] text-g4 hover:border-black/[0.13]"
        )}
      >
        Compare
      </button>
      {enabled && (
        <div className="flex items-center gap-2">
          <select
            value={splitDate}
            onChange={(e) => onSplitDateChange(e.target.value)}
            className="h-[30px] px-2 rounded-lg border border-black/[0.07] text-[0.74rem] text-g3 bg-white cursor-pointer"
          >
            <option value="">Custom date...</option>
            {deployments.map((d) => (
              <option key={d.id} value={d.deploy_date}>
                {d.name} ({d.deploy_date})
              </option>
            ))}
          </select>
          {splitDate === '' || !deployments.find(d => d.deploy_date === splitDate) ? null : null}
          <input
            type="date"
            value={splitDate}
            onChange={(e) => onSplitDateChange(e.target.value)}
            className="h-[30px] px-2 rounded-lg border border-black/[0.07] text-[0.74rem] text-g3 bg-white"
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create BreakdownBar**

Create `src/components/otti/breakdown-bar.tsx`:

```tsx
const COLORS = [
  'bg-black', 'bg-g3', 'bg-g5', 'bg-g6', 'bg-g7', 'bg-g8',
];

interface BreakdownItem {
  name: string;
  count: number;
  pct: number;
}

interface BreakdownBarProps {
  title: string;
  items: BreakdownItem[];
}

export function BreakdownBar({ title, items }: BreakdownBarProps) {
  return (
    <div className="bg-surface border border-black/[0.07] rounded-card p-[22px]">
      <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">
        {title}
      </div>
      {/* Segmented bar */}
      <div className="flex gap-[2px] h-[8px] rounded-[4px] overflow-hidden mb-4">
        {items.map((item, i) => (
          <div
            key={item.name}
            className={COLORS[i % COLORS.length]}
            style={{ width: `${item.pct}%` }}
          />
        ))}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {items.map((item, i) => (
          <div key={item.name} className="flex items-center gap-[6px]">
            <span className={`w-[8px] h-[8px] rounded-[2px] ${COLORS[i % COLORS.length]}`} />
            <span className="text-[0.72rem] text-g4">
              {item.name}
            </span>
            <span className="text-[0.72rem] font-semibold text-g3 tabular-nums">
              {item.count}
            </span>
            <span className="text-[0.65rem] text-g5 tabular-nums">
              {item.pct}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/otti/
git commit -m "feat(otti): add period selector, compare controls, breakdown bar components"
```

---

### Task 7: Components — VolumeChart, SpeedTable, HourlyHeatmap

**Files:**
- Create: `src/components/otti/volume-chart.tsx`
- Create: `src/components/otti/speed-table.tsx`
- Create: `src/components/otti/hourly-heatmap.tsx`

- [ ] **Step 1: Create VolumeChart**

Create `src/components/otti/volume-chart.tsx`:

```tsx
interface DailyVolume {
  date: string;
  count: number;
}

interface VolumeChartProps {
  data: DailyVolume[];
  splitDate?: string | null;
}

export function VolumeChart({ data, splitDate }: VolumeChartProps) {
  if (data.length === 0) {
    return (
      <div className="bg-surface border border-black/[0.07] rounded-card p-[22px]">
        <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Daily Volume</div>
        <div className="text-[0.8rem] text-g5 py-4">No data for this period.</div>
      </div>
    );
  }

  const maxCount = Math.max(...data.map(d => d.count), 1);
  const peakCount = Math.max(...data.map(d => d.count));

  return (
    <div className="bg-surface border border-black/[0.07] rounded-card p-[22px]">
      <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Daily Volume</div>
      <div className="flex items-end gap-[3px] h-[140px] pt-[10px]">
        {data.map((d) => {
          const heightPct = Math.max((d.count / maxCount) * 100, d.count > 0 ? 4 : 0);
          const isPeak = d.count === peakCount && d.count > 0;
          const isSplit = splitDate && d.date === splitDate;
          return (
            <div key={d.date} className="flex-1 flex flex-col items-center gap-1 relative">
              {isSplit && (
                <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-[2px] h-[calc(100%+16px)] bg-accent-red/40 z-10" />
              )}
              <div
                className={`w-full rounded-t-[3px] transition-all ${
                  d.count === 0 ? 'bg-g8' : isPeak ? 'bg-accent-green' : 'bg-black'
                }`}
                style={{ height: `${d.count === 0 ? 2 : heightPct}%` }}
                title={`${d.date}: ${d.count}`}
              />
              {data.length <= 14 && (
                <span className="text-[0.55rem] text-g5 tabular-nums">
                  {d.date.slice(5)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex gap-4 mt-3">
        <div className="flex items-center gap-[5px] text-[0.68rem] text-g5">
          <span className="w-2 h-2 rounded-sm bg-black" /> Normal
        </div>
        <div className="flex items-center gap-[5px] text-[0.68rem] text-g5">
          <span className="w-2 h-2 rounded-sm bg-accent-green" /> Peak
        </div>
        {splitDate && (
          <div className="flex items-center gap-[5px] text-[0.68rem] text-g5">
            <span className="w-2 h-[2px] bg-accent-red/40" style={{ width: 12 }} /> Deploy
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create SpeedTable**

Create `src/components/otti/speed-table.tsx`:

```tsx
import { cn } from '@/lib/utils';

interface SpeedRow {
  name: string;
  median: number;
  p90: number;
  delta_median_pct: number;
}

interface SpeedTableProps {
  title: string;
  rows: SpeedRow[];
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

export function SpeedTable({ title, rows }: SpeedTableProps) {
  return (
    <div className="bg-surface border border-black/[0.07] rounded-card p-[22px]">
      <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-[0.8rem] text-g5 py-2">No data.</div>
      ) : (
        <div className="space-y-0">
          {/* Header */}
          <div className="grid grid-cols-[1fr_80px_80px_90px] gap-2 pb-2 border-b border-black/[0.07]">
            <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-g5">Name</div>
            <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-g5 text-right">Median</div>
            <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-g5 text-right">P90</div>
            <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-g5 text-right">Delta</div>
          </div>
          {rows.map((r) => (
            <div
              key={r.name}
              className="grid grid-cols-[1fr_80px_80px_90px] gap-2 py-[9px] border-b border-black/[0.07] last:border-b-0"
            >
              <div className="text-[0.78rem] font-medium text-g2">{r.name}</div>
              <div className="text-[0.78rem] font-semibold tabular-nums text-g3 text-right">
                {formatDuration(r.median)}
              </div>
              <div className="text-[0.78rem] tabular-nums text-g4 text-right">
                {formatDuration(r.p90)}
              </div>
              <div className={cn(
                "text-[0.74rem] font-semibold tabular-nums text-right",
                r.delta_median_pct > 0 ? "text-accent-green" : r.delta_median_pct < 0 ? "text-accent-red" : "text-g5"
              )}>
                {r.delta_median_pct > 0 ? '+' : ''}{r.delta_median_pct}%
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create HourlyHeatmap**

Create `src/components/otti/hourly-heatmap.tsx`:

```tsx
interface HourlyHeatmapProps {
  data: Record<string, number[]>;
}

export function HourlyHeatmap({ data }: HourlyHeatmapProps) {
  const dates = Object.keys(data).sort();
  if (dates.length === 0) {
    return (
      <div className="bg-surface border border-black/[0.07] rounded-card p-[22px]">
        <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Hourly Activity</div>
        <div className="text-[0.8rem] text-g5 py-2">No data.</div>
      </div>
    );
  }

  // Find max for color scaling
  const allValues = dates.flatMap(d => data[d]);
  const maxVal = Math.max(...allValues, 1);

  return (
    <div className="bg-surface border border-black/[0.07] rounded-card p-[22px]">
      <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Hourly Activity</div>
      <div className="overflow-x-auto">
        {/* Hour labels */}
        <div className="flex gap-[2px] mb-[2px] ml-[72px]">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="flex-1 min-w-[18px] text-center text-[0.55rem] text-g5 tabular-nums">
              {h % 3 === 0 ? `${h}` : ''}
            </div>
          ))}
        </div>
        {/* Rows */}
        {dates.map((date) => (
          <div key={date} className="flex gap-[2px] mb-[2px] items-center">
            <div className="w-[68px] text-[0.6rem] text-g5 tabular-nums shrink-0">
              {date.slice(5)}
            </div>
            {data[date].map((count, h) => {
              const intensity = count / maxVal;
              const bg = count === 0
                ? 'bg-g9'
                : intensity > 0.7
                ? 'bg-black'
                : intensity > 0.4
                ? 'bg-g3'
                : intensity > 0.15
                ? 'bg-g5'
                : 'bg-g7';
              return (
                <div
                  key={h}
                  className={`flex-1 min-w-[18px] h-[18px] rounded-[3px] ${bg}`}
                  title={`${date} ${h}:00 — ${count} sessions`}
                />
              );
            })}
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-2 mt-3 ml-[72px]">
        <span className="text-[0.6rem] text-g5">Less</span>
        {['bg-g9', 'bg-g7', 'bg-g5', 'bg-g3', 'bg-black'].map((c) => (
          <div key={c} className={`w-[14px] h-[14px] rounded-[2px] ${c}`} />
        ))}
        <span className="text-[0.6rem] text-g5">More</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/otti/
git commit -m "feat(otti): add volume chart, speed table, hourly heatmap components"
```

---

### Task 8: Page — Server Shell + Client Component

**Files:**
- Create: `src/app/otti/page.tsx`
- Create: `src/app/otti/otti-client.tsx`

- [ ] **Step 1: Create server page**

Create `src/app/otti/page.tsx`:

```tsx
import { initSchema, seedOttiDeployments } from '@/lib/schema';
import { OttiClient } from './otti-client';

export const dynamic = 'force-dynamic';

export default function OttiPage() {
  initSchema();
  seedOttiDeployments();

  return <OttiClient />;
}
```

- [ ] **Step 2: Create client component**

Create `src/app/otti/otti-client.tsx`:

```tsx
'use client';

import { useEffect, useState, useCallback } from 'react';
import { StatCard } from '@/components/stat-card';
import { PeriodSelector } from '@/components/otti/period-selector';
import { CompareControls } from '@/components/otti/compare-controls';
import { BreakdownBar } from '@/components/otti/breakdown-bar';
import { VolumeChart } from '@/components/otti/volume-chart';
import { SpeedTable } from '@/components/otti/speed-table';
import { HourlyHeatmap } from '@/components/otti/hourly-heatmap';
import { cn } from '@/lib/utils';
import type { OttiMetrics } from '@/lib/otti-queries';

interface Deployment {
  id: string;
  name: string;
  deploy_date: string;
}

function formatDuration(seconds: number): string {
  if (seconds === 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function DeltaBadge({ pct, invert }: { pct: number; invert?: boolean }) {
  // For speed: negative delta = faster = good, so invert the color
  const isGood = invert ? pct < 0 : pct > 0;
  const isBad = invert ? pct > 0 : pct < 0;
  return (
    <span className={cn(
      "text-[0.72rem] font-medium",
      isGood && "text-accent-green",
      isBad && "text-accent-red",
      !isGood && !isBad && "text-g5",
    )}>
      {pct > 0 ? '+' : ''}{pct}% vs prior
    </span>
  );
}

export function OttiClient() {
  const [period, setPeriod] = useState('7d');
  const [compare, setCompare] = useState(false);
  const [splitDate, setSplitDate] = useState('');
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [data, setData] = useState<OttiMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ period });
    if (compare && splitDate) {
      params.set('compare', 'true');
      params.set('split_date', splitDate);
    }
    const res = await fetch(`/api/otti/sessions?${params}`);
    const json = await res.json();
    setData(json);
    setLoading(false);
  }, [period, compare, splitDate]);

  useEffect(() => {
    fetch('/api/otti/deployments').then(r => r.json()).then(setDeployments);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
        <div className="text-[0.82rem] text-g5">Loading...</div>
      </div>
    );
  }

  if (!data) return null;

  const d = data;

  return (
    <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
      {/* Header */}
      <div className="flex items-start justify-between mb-7">
        <div>
          <h1 className="text-[1.5rem] font-bold tracking-tight text-black mb-[2px]">
            Otti Assistant
          </h1>
          <p className="text-[0.82rem] text-g5">Adoption & Performance</p>
        </div>
        <div className="flex items-center gap-4">
          <CompareControls
            enabled={compare}
            onToggle={() => setCompare(!compare)}
            splitDate={splitDate}
            onSplitDateChange={setSplitDate}
            deployments={deployments}
          />
          <PeriodSelector value={period} onChange={setPeriod} />
        </div>
      </div>

      {/* Compare banner */}
      {compare && splitDate && (
        <div className="mb-5 px-4 py-2 rounded-lg bg-black/[0.03] border border-black/[0.07] text-[0.74rem] text-g3">
          Comparing: <strong>{d.prior.start}</strong> → <strong>{splitDate}</strong> (before)
          {' '}vs{' '}
          <strong>{splitDate}</strong> → <strong>{d.range.end}</strong> (after)
        </div>
      )}

      {/* ── Section: Adoption ── */}
      <div className="mb-8">
        <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-4 pb-2 border-b border-black/[0.07]">
          Adoption
        </div>
        <div className="grid grid-cols-12 gap-[10px]">
          <div className="col-span-3">
            <StatCard
              label="Conversations"
              value={String(d.kpis.conversations.value)}
              delta={`${d.kpis.conversations.delta_pct > 0 ? '+' : ''}${d.kpis.conversations.delta_pct}% vs ${compare ? 'before' : 'prior'}`}
              trend={d.kpis.conversations.delta_pct >= 0 ? 'up' : 'down'}
            />
          </div>
          <div className="col-span-3">
            <StatCard
              label="Unique Users"
              value={String(d.kpis.unique_users.value)}
              delta={`${d.kpis.unique_users.delta_pct > 0 ? '+' : ''}${d.kpis.unique_users.delta_pct}% vs ${compare ? 'before' : 'prior'}`}
              trend={d.kpis.unique_users.delta_pct >= 0 ? 'up' : 'down'}
            />
          </div>
          <div className="col-span-3">
            <StatCard
              label="Sessions / User"
              value={String(d.kpis.sessions_per_user.value)}
              delta={`${d.kpis.sessions_per_user.delta_pct > 0 ? '+' : ''}${d.kpis.sessions_per_user.delta_pct}% vs ${compare ? 'before' : 'prior'}`}
              trend={d.kpis.sessions_per_user.delta_pct >= 0 ? 'up' : 'down'}
            />
          </div>
          <div className="col-span-3">
            <StatCard
              label="Median Speed"
              value={formatDuration(d.kpis.median_speed_s.value)}
              delta={`${d.kpis.median_speed_s.delta_pct > 0 ? '+' : ''}${d.kpis.median_speed_s.delta_pct}% vs ${compare ? 'before' : 'prior'}`}
              trend={d.kpis.median_speed_s.delta_pct <= 0 ? 'up' : 'down'}
            />
          </div>
          <div className="col-span-12">
            <VolumeChart data={d.daily_volume} splitDate={compare ? splitDate : null} />
          </div>
        </div>
      </div>

      {/* ── Section: Usage Patterns ── */}
      <div className="mb-8">
        <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-4 pb-2 border-b border-black/[0.07]">
          Usage Patterns
        </div>
        <div className="grid grid-cols-12 gap-[10px]">
          <div className="col-span-6">
            <BreakdownBar title="Intent Breakdown" items={d.intents} />
          </div>
          <div className="col-span-6">
            <BreakdownBar title="Persona Split" items={d.personas} />
          </div>
          <div className="col-span-6">
            <BreakdownBar title="Model Distribution" items={d.models} />
          </div>
          <div className="col-span-6">
            <BreakdownBar title="Agent Routing" items={d.agent_types} />
          </div>
        </div>
      </div>

      {/* ── Section: Performance ── */}
      <div className="mb-8">
        <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-4 pb-2 border-b border-black/[0.07]">
          Performance
        </div>
        <div className="grid grid-cols-12 gap-[10px]">
          <div className="col-span-4">
            <StatCard
              label="Median Speed"
              value={formatDuration(d.kpis.median_speed_s.value)}
              delta={`${d.kpis.median_speed_s.delta_pct > 0 ? '+' : ''}${d.kpis.median_speed_s.delta_pct}%`}
              trend={d.kpis.median_speed_s.delta_pct <= 0 ? 'up' : 'down'}
            />
          </div>
          <div className="col-span-4">
            <StatCard
              label="P90 Speed"
              value={formatDuration(d.kpis.p90_speed_s.value)}
              delta={`${d.kpis.p90_speed_s.delta_pct > 0 ? '+' : ''}${d.kpis.p90_speed_s.delta_pct}%`}
              trend={d.kpis.p90_speed_s.delta_pct <= 0 ? 'up' : 'down'}
            />
          </div>
          <div className="col-span-4">
            <StatCard
              label="P95 Speed"
              value={formatDuration(d.kpis.p95_speed_s.value)}
              delta={`${d.kpis.p95_speed_s.delta_pct > 0 ? '+' : ''}${d.kpis.p95_speed_s.delta_pct}%`}
              trend={d.kpis.p95_speed_s.delta_pct <= 0 ? 'up' : 'down'}
            />
          </div>
          <div className="col-span-4">
            <SpeedTable title="Speed by Intent" rows={d.speed_by_intent} />
          </div>
          <div className="col-span-4">
            <SpeedTable title="Speed by Model" rows={d.speed_by_model} />
          </div>
          <div className="col-span-4">
            <SpeedTable title="Speed by Persona" rows={d.speed_by_persona} />
          </div>
          {/* Speed Buckets */}
          <div className="col-span-12 bg-surface border border-black/[0.07] rounded-card p-[22px]">
            <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">
              Speed Distribution
            </div>
            <div className="space-y-[6px]">
              {d.speed_buckets.map((b) => (
                <div key={b.label} className="flex items-center gap-3">
                  <div className="w-[52px] text-[0.72rem] text-g4 text-right tabular-nums">{b.label}</div>
                  <div className="flex-1 h-[14px] bg-g9 rounded-[3px] overflow-hidden">
                    <div
                      className="h-full bg-black rounded-[3px] transition-all"
                      style={{ width: `${b.pct}%` }}
                    />
                  </div>
                  <div className="w-[32px] text-[0.72rem] font-semibold text-g3 tabular-nums text-right">{b.count}</div>
                  <div className="w-[40px] text-[0.65rem] text-g5 tabular-nums">{b.pct}%</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Section: Engagement ── */}
      <div className="mb-8">
        <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-4 pb-2 border-b border-black/[0.07]">
          Engagement Details
        </div>
        <div className="grid grid-cols-12 gap-[10px]">
          {/* Top Users */}
          <div className="col-span-6 bg-surface border border-black/[0.07] rounded-card p-[22px]">
            <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">
              Top Users
            </div>
            <div className="space-y-0">
              <div className="grid grid-cols-[1fr_60px_80px_80px] gap-2 pb-2 border-b border-black/[0.07]">
                <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-g5">User</div>
                <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-g5 text-right">Sessions</div>
                <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-g5">Persona</div>
                <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-g5">Top Intent</div>
              </div>
              {d.top_users.map((u) => (
                <div key={u.user_id} className="grid grid-cols-[1fr_60px_80px_80px] gap-2 py-[9px] border-b border-black/[0.07] last:border-b-0">
                  <div className="text-[0.74rem] font-mono text-g3 truncate">{u.user_id}</div>
                  <div className="text-[0.78rem] font-semibold tabular-nums text-g2 text-right">{u.sessions}</div>
                  <div className="text-[0.68rem] px-[6px] py-[1px] rounded bg-g9 text-g3 w-fit">{u.persona}</div>
                  <div className="text-[0.68rem] text-g4 truncate">{u.top_intents[0] || ''}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Hourly Heatmap */}
          <div className="col-span-6">
            <HourlyHeatmap data={d.hourly_heatmap} />
          </div>

          {/* Single event warning */}
          {d.single_event_pct > 5 && (
            <div className="col-span-12 bg-accent-red/[0.04] border border-accent-red/20 rounded-card p-[16px] flex items-center gap-3">
              <div className="w-[6px] h-[6px] rounded-full bg-accent-red shrink-0" />
              <div className="text-[0.78rem] text-g3">
                <strong>{d.single_event_count} single-event sessions</strong> ({d.single_event_pct}%) — may indicate routing failures or aborted requests.
              </div>
            </div>
          )}
          {d.single_event_count > 0 && d.single_event_pct <= 5 && (
            <div className="col-span-12 bg-g9/50 border border-black/[0.05] rounded-card p-[14px] flex items-center gap-3">
              <div className="w-[5px] h-[5px] rounded-full bg-g6 shrink-0" />
              <div className="text-[0.74rem] text-g5">
                {d.single_event_count} single-event session{d.single_event_count !== 1 ? 's' : ''} ({d.single_event_pct}%) — within normal range.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/otti/
git commit -m "feat(otti): add Otti Assistant page with all dashboard sections"
```

---

### Task 9: Verify Full Dashboard

- [ ] **Step 1: Run ingest if not already done**

```bash
cd ~/Documents/Tracker/workgraph && npx tsx scripts/ingest-otti-sessions.ts
```

- [ ] **Step 2: Start dev server and test**

```bash
cd ~/Documents/Tracker/workgraph && bun run dev
```

Open `http://localhost:3000/otti` in browser.

Verify:
- Nav shows "Otti Assistant" tab and is active
- Period selector switches between 7d/30d/90d/All and data updates
- Adoption section shows 4 KPI cards + daily volume chart
- Usage section shows 4 breakdown bars (intent, persona, model, agent)
- Performance section shows speed KPIs + 3 speed tables + speed buckets
- Engagement section shows top users table + hourly heatmap
- Compare mode: toggle on, select "Codemesh Integration" from dropdown, verify split-date comparison renders with before/after deltas
- Compare banner appears showing date ranges

- [ ] **Step 3: Fix any issues found during testing**

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(otti): complete Otti Assistant adoption dashboard"
```
