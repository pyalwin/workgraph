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
  display_name: string;
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
    default: return null;
  }
}

function dateRange(period: string): { start: string; end: string; priorStart: string; priorEnd: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const days = periodToDays(period);

  if (!days) {
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
      delta_median_pct: deltaPct(med, priorMed) * -1,
    };
  }).sort((a, b) => b.median - a.median);
}

export function getOttiMetrics(period: string, compare: boolean, splitDate: string | null): OttiMetrics {
  const db = getDb();
  const { start, end, priorStart, priorEnd } = dateRange(period);

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

  const dailyRows = db.prepare(`
    SELECT DATE(ts_start) as date, COUNT(*) as count
    FROM otti_sessions
    WHERE ts_start >= ? AND ts_start < ?
    GROUP BY DATE(ts_start)
    ORDER BY date ASC
  `).all(start, end + 'T23:59:59') as DailyVolume[];

  const intents = queryBreakdown(currentStart, currentEnd, 'intent');
  const personas = queryBreakdown(currentStart, currentEnd, 'persona');
  const models = queryBreakdown(currentStart, currentEnd, 'model');
  const agentTypes = queryBreakdown(currentStart, currentEnd, 'agent_type');

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

  const speedByIntent = querySpeedByDimension(currentStart, currentEnd, compStart, compEnd, 'intent');
  const speedByModel = querySpeedByDimension(currentStart, currentEnd, compStart, compEnd, 'model');
  const speedByPersona = querySpeedByDimension(currentStart, currentEnd, compStart, compEnd, 'persona');

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

    const userRow = db.prepare(
      'SELECT display_name FROM otti_users WHERE user_id = ?'
    ).get(u.user_id) as { display_name: string } | undefined;

    return {
      user_id: u.user_id,
      display_name: userRow?.display_name || u.user_id,
      sessions: u.sessions,
      persona: personaRow?.persona || 'unknown',
      top_intents: intentRows.map(i => i.intent),
      avg_duration_s: Math.round(u.avg_dur),
    };
  });

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

export interface WeeklyTrend {
  week: string;      // e.g. "04-07"
  sessions: number;
}

export interface UserMetrics {
  user_id: string;
  display_name: string;
  title: string;
  total_sessions: number;
  first_seen: string;
  last_seen: string;
  days_since_last: number;
  active_days: number;
  total_days: number;
  consistency_pct: number;        // active_days / total_days * 100
  sessions_per_active_day: number;
  trend: 'growing' | 'stable' | 'declining' | 'new' | 'churned';
  trend_pct: number;              // % change recent vs earlier half
  weekly_trend: WeeklyTrend[];
  daily_volume: DailyVolume[];
  day_of_week: number[];          // [Mon, Tue, Wed, Thu, Fri, Sat, Sun] counts
  top_intent: string;
  top_intent_pct: number;
  intents: BreakdownItem[];
}

export function getUserMetrics(userId: string, period: string): UserMetrics {
  const db = getDb();
  const { start, end } = dateRange(period);
  const endTs = end + 'T23:59:59';

  const userRow = db.prepare(
    'SELECT display_name, title FROM otti_users WHERE user_id = ?'
  ).get(userId) as { display_name: string; title: string } | undefined;

  const total = (db.prepare(
    'SELECT COUNT(*) as c FROM otti_sessions WHERE user_id = ? AND ts_start >= ? AND ts_start < ?'
  ).get(userId, start, endTs) as { c: number }).c;

  const firstLast = db.prepare(
    'SELECT MIN(ts_start) as first_seen, MAX(ts_start) as last_seen FROM otti_sessions WHERE user_id = ?'
  ).get(userId) as { first_seen: string; last_seen: string };

  // Active days in period
  const activeDayRows = db.prepare(`
    SELECT DISTINCT DATE(ts_start) as d FROM otti_sessions
    WHERE user_id = ? AND ts_start >= ? AND ts_start < ?
  `).all(userId, start, endTs) as { d: string }[];
  const activeDays = activeDayRows.length;

  const startDate = new Date(start);
  const endDate = new Date(end);
  const totalDays = Math.max(Math.round((endDate.getTime() - startDate.getTime()) / 86400000), 1);
  const consistencyPct = Math.round(activeDays / totalDays * 1000) / 10;
  const sessPerActiveDay = activeDays > 0 ? Math.round(total / activeDays * 10) / 10 : 0;

  // Days since last session
  const lastDate = firstLast.last_seen ? new Date(firstLast.last_seen) : new Date();
  const daysSinceLast = Math.round((new Date().getTime() - lastDate.getTime()) / 86400000);

  // Weekly trend
  const weeklyRows = db.prepare(`
    SELECT strftime('%Y-%W', ts_start) as week, COUNT(*) as sessions
    FROM otti_sessions
    WHERE user_id = ? AND ts_start >= ? AND ts_start < ?
    GROUP BY week ORDER BY week ASC
  `).all(userId, start, endTs) as { week: string; sessions: number }[];

  const weeklyTrend: WeeklyTrend[] = weeklyRows.map(r => ({
    week: r.week.slice(5),  // just "WW"
    sessions: r.sessions,
  }));

  // Trend calculation: compare second half to first half of the period
  let trend: 'growing' | 'stable' | 'declining' | 'new' | 'churned' = 'stable';
  let trendPct = 0;

  if (weeklyTrend.length <= 1) {
    trend = total > 0 ? 'new' : 'churned';
  } else {
    const mid = Math.floor(weeklyTrend.length / 2);
    const firstHalf = weeklyTrend.slice(0, mid).reduce((s, w) => s + w.sessions, 0);
    const secondHalf = weeklyTrend.slice(mid).reduce((s, w) => s + w.sessions, 0);
    if (firstHalf === 0) {
      trend = secondHalf > 0 ? 'growing' : 'churned';
      trendPct = 100;
    } else {
      trendPct = Math.round(((secondHalf - firstHalf) / firstHalf) * 100);
      if (trendPct >= 20) trend = 'growing';
      else if (trendPct <= -20) trend = 'declining';
      else trend = 'stable';
    }
  }

  if (daysSinceLast > 14 && total > 0) trend = 'churned';

  // Daily volume — fill every day in range, 0 for inactive days
  const dailyMap = new Map<string, number>();
  const cursor = new Date(start);
  const endD = new Date(end);
  while (cursor <= endD) {
    dailyMap.set(cursor.toISOString().slice(0, 10), 0);
    cursor.setDate(cursor.getDate() + 1);
  }
  const rawDaily = db.prepare(`
    SELECT DATE(ts_start) as date, COUNT(*) as count FROM otti_sessions
    WHERE user_id = ? AND ts_start >= ? AND ts_start < ?
    GROUP BY DATE(ts_start)
  `).all(userId, start, endTs) as DailyVolume[];
  for (const r of rawDaily) {
    dailyMap.set(r.date, r.count);
  }
  const dailyRows: DailyVolume[] = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  // Day of week distribution (0=Sun...6=Sat → remap to Mon-Sun)
  const dowRows = db.prepare(`
    SELECT CAST(strftime('%w', ts_start) AS INTEGER) as dow, COUNT(*) as c
    FROM otti_sessions
    WHERE user_id = ? AND ts_start >= ? AND ts_start < ?
    GROUP BY dow
  `).all(userId, start, endTs) as { dow: number; c: number }[];

  const dayOfWeek = new Array(7).fill(0); // [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
  for (const r of dowRows) {
    // SQLite %w: 0=Sunday. Remap to Mon=0..Sun=6
    const idx = r.dow === 0 ? 6 : r.dow - 1;
    dayOfWeek[idx] = r.c;
  }

  // Top intent
  const userIntents = db.prepare(`
    SELECT intent as name, COUNT(*) as count FROM otti_sessions
    WHERE user_id = ? AND ts_start >= ? AND ts_start < ?
    GROUP BY intent ORDER BY count DESC
  `).all(userId, start, endTs) as { name: string; count: number }[];
  const intentTotal = userIntents.reduce((s, r) => s + r.count, 0);
  const intentItems: BreakdownItem[] = userIntents.map(r => ({
    name: r.name, count: r.count,
    pct: intentTotal > 0 ? Math.round(r.count / intentTotal * 1000) / 10 : 0,
  }));

  return {
    user_id: userId,
    display_name: userRow?.display_name || userId,
    title: userRow?.title || '',
    total_sessions: total,
    first_seen: firstLast.first_seen?.slice(0, 10) || '',
    last_seen: firstLast.last_seen?.slice(0, 10) || '',
    days_since_last: daysSinceLast,
    active_days: activeDays,
    total_days: totalDays,
    consistency_pct: consistencyPct,
    sessions_per_active_day: sessPerActiveDay,
    trend,
    trend_pct: trendPct,
    weekly_trend: weeklyTrend,
    daily_volume: dailyRows,
    day_of_week: dayOfWeek,
    top_intent: intentItems[0]?.name || '—',
    top_intent_pct: intentItems[0]?.pct || 0,
    intents: intentItems,
  };
}

export function getOttiUserList() {
  const db = getDb();
  return db.prepare(`
    SELECT u.user_id, u.display_name, COUNT(s.id) as sessions
    FROM otti_users u
    JOIN otti_sessions s ON u.user_id = s.user_id
    GROUP BY u.user_id
    ORDER BY sessions DESC
  `).all() as { user_id: string; display_name: string; sessions: number }[];
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
