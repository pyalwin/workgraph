import { StatCard } from '@/components/stat-card';
import { getDb } from '@/lib/db';
import { initSchema, seedGoals } from '@/lib/schema';

export const dynamic = 'force-dynamic';

interface GoalRow {
  id: string;
  name: string;
  total: number;
  done: number;
  active: number;
}

interface SourceRow {
  source: string;
  count: number;
}

interface CountRow {
  c: number;
}

interface WeekRow {
  week_start: string;
  count: number;
}

interface AnomalyItem {
  severity: 'high' | 'med' | 'low';
  text: string;
  when: string;
}

const SOURCE_BADGES: Record<string, { label: string; color: string }> = {
  jira: { label: 'JRA', color: 'bg-g1' },
  slack: { label: 'SLK', color: 'bg-g3' },
  meetings: { label: 'MTG', color: 'bg-g5' },
  notion: { label: 'NOT', color: 'bg-g6' },
  gmail: { label: 'GML', color: 'bg-g7 !text-g3' },
  github: { label: 'GIT', color: 'bg-g2' },
};

function getSourceBadge(source: string) {
  const key = source.toLowerCase();
  return SOURCE_BADGES[key] ?? { label: source.slice(0, 3).toUpperCase(), color: 'bg-g4' };
}

export default function MetricsPage() {
  const db = getDb();
  initSchema();
  seedGoals();

  // --- Goal Health ---
  const goalHealth = db.prepare(`
    SELECT g.name, g.id,
      COUNT(it.item_id) as total,
      SUM(CASE WHEN wi.status IN ('done', 'closed', 'resolved') THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN wi.status IN ('open', 'in_progress', 'to_do') THEN 1 ELSE 0 END) as active
    FROM goals g
    LEFT JOIN item_tags it ON it.tag_id = g.id
    LEFT JOIN work_items wi ON wi.id = it.item_id
    WHERE g.status = 'active'
    GROUP BY g.id
    ORDER BY g.sort_order
  `).all() as GoalRow[];

  // --- Source Throughput ---
  const sources = db.prepare(
    "SELECT source, COUNT(*) as count FROM work_items GROUP BY source ORDER BY count DESC"
  ).all() as SourceRow[];

  const maxSourceCount = sources.length > 0 ? sources[0].count : 1;

  // --- Totals ---
  const totalItems = (db.prepare('SELECT COUNT(*) as c FROM work_items').get() as CountRow).c;
  const totalLinks = (db.prepare('SELECT COUNT(*) as c FROM links').get() as CountRow).c;
  const staleCount = (db.prepare(
    "SELECT COUNT(*) as c FROM work_items WHERE status NOT IN ('done','closed','resolved') AND julianday('now') - julianday(COALESCE(updated_at, created_at)) >= 14"
  ).get() as CountRow).c;

  // --- Velocity: items updated in last 7 days ---
  const velocity7d = (db.prepare(
    "SELECT COUNT(*) as c FROM work_items WHERE updated_at >= datetime('now', '-7 days')"
  ).get() as CountRow).c;

  // --- Computed KPIs ---
  const activeItems = totalItems > 0
    ? (db.prepare("SELECT COUNT(*) as c FROM work_items WHERE status NOT IN ('done','closed','resolved')").get() as CountRow).c
    : 0;

  const staleRate = activeItems > 0 ? ((staleCount / activeItems) * 100).toFixed(1) : '0.0';
  const linkDensity = totalItems > 0 ? ((totalLinks / totalItems)).toFixed(1) : '0.0';

  // --- Weekly Throughput (last 13 weeks) ---
  const weeklyData = db.prepare(`
    SELECT strftime('%Y-%W', created_at) as week_start, COUNT(*) as count
    FROM work_items
    WHERE created_at >= datetime('now', '-91 days')
    GROUP BY week_start
    ORDER BY week_start ASC
  `).all() as WeekRow[];

  // Pad to 13 weeks — fill gaps with 0
  const weekBars: number[] = [];
  const weekLabels: string[] = [];
  if (weeklyData.length > 0) {
    for (let i = 0; i < Math.min(weeklyData.length, 13); i++) {
      weekBars.push(weeklyData[i].count);
      weekLabels.push(`W${i + 1}`);
    }
  }
  // If fewer than 13 weeks, pad
  while (weekBars.length < 13) {
    weekBars.push(0);
    weekLabels.push(`W${weekBars.length}`);
  }

  const maxWeekCount = Math.max(...weekBars, 1);
  const peakWeek = Math.max(...weekBars);
  const minWeek = Math.min(...weekBars.filter(b => b > 0), peakWeek);

  // --- Anomaly Detection ---
  const anomalies: AnomalyItem[] = [];

  // Items stale > 21 days
  const veryStaleCount = (db.prepare(
    "SELECT COUNT(*) as c FROM work_items WHERE status NOT IN ('done','closed','resolved') AND julianday('now') - julianday(COALESCE(updated_at, created_at)) >= 21"
  ).get() as CountRow).c;
  if (veryStaleCount > 0) {
    anomalies.push({
      severity: 'high',
      text: `<strong>${veryStaleCount} work item${veryStaleCount > 1 ? 's' : ''}</strong> stale for 21+ days with no updates.`,
      when: `Detected now`,
    });
  }

  // Goals with 0% completion (but have items)
  const zeroGoals = goalHealth.filter(g => g.total > 0 && g.done === 0);
  for (const g of zeroGoals) {
    anomalies.push({
      severity: 'high',
      text: `<strong>${g.name}</strong> — 0% completion across ${g.total} tagged item${g.total > 1 ? 's' : ''}.`,
      when: `Detected now`,
    });
  }

  // Goals with no items at all
  const emptyGoals = goalHealth.filter(g => g.total === 0);
  for (const g of emptyGoals) {
    anomalies.push({
      severity: 'med',
      text: `<strong>${g.name}</strong> has no tagged work items. Goal may be unlinked from active work.`,
      when: `Detected now`,
    });
  }

  // Low velocity warning
  if (velocity7d === 0 && totalItems > 0) {
    anomalies.push({
      severity: 'med',
      text: `<strong>Zero velocity</strong> — no items updated in the last 7 days.`,
      when: `Detected now`,
    });
  }

  // Link density warning
  if (totalItems > 5 && totalLinks === 0) {
    anomalies.push({
      severity: 'low',
      text: `<strong>No cross-references</strong> detected. Work items may be siloed across sources.`,
      when: `Detected now`,
    });
  }

  if (anomalies.length === 0) {
    anomalies.push({
      severity: 'low',
      text: `No anomalies detected. All systems nominal.`,
      when: `Checked now`,
    });
  }

  return (
    <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
      <div className="mb-7">
        <h1 className="text-[1.5rem] font-bold tracking-tight text-black mb-[2px]">Metrics</h1>
        <p className="text-[0.82rem] text-g5">Performance analytics across all tracked goals</p>
      </div>

      {/* Period */}
      <div className="flex gap-[6px] mb-7">
        {['7d','30d','90d','YTD','All'].map((p, i) => (
          <button key={p} className={`px-[14px] py-[5px] rounded-lg text-[0.74rem] border cursor-pointer transition-all ${i === 2 ? 'bg-black border-black text-white font-medium' : 'bg-surface border-black/[0.07] text-g4 hover:border-black/[0.13]'}`}>
            {p}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-12 gap-[10px]">
        {/* KPIs */}
        <div className="col-span-3">
          <StatCard label="Velocity (7d)" value={String(velocity7d)} delta={`${totalItems} total items tracked`} trend="up" />
        </div>
        <div className="col-span-3">
          <StatCard label="Active Items" value={String(activeItems)} delta={`${totalItems} total across all sources`} trend="up" />
        </div>
        <div className="col-span-3">
          <StatCard label="Stale Rate" value={`${staleRate}%`} delta={`${staleCount} item${staleCount !== 1 ? 's' : ''} idle 14+ days`} trend={Number(staleRate) > 15 ? 'down' : 'up'} />
        </div>
        <div className="col-span-3">
          <StatCard label="Link Density" value={`${linkDensity}x`} delta={`${totalLinks} cross-references`} trend={Number(linkDensity) >= 1 ? 'up' : 'down'} />
        </div>

        {/* Velocity chart */}
        <div className="col-span-6 bg-surface border border-black/[0.07] rounded-card p-[22px]">
          <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Weekly Throughput</div>
          <div className="flex items-end gap-[3px] h-[140px] pt-[10px]">
            {weekBars.map((count, i) => {
              const heightPct = maxWeekCount > 0 ? Math.max((count / maxWeekCount) * 100, count > 0 ? 4 : 0) : 0;
              const barColor = count === peakWeek && count > 0
                ? 'bg-accent-green'
                : count === minWeek && count > 0 && count !== peakWeek
                ? 'bg-g5'
                : 'bg-black';
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <div
                    className={`w-full rounded-t-[3px] ${count === 0 ? 'bg-g8' : barColor}`}
                    style={{ height: `${count === 0 ? 2 : heightPct}%` }}
                  />
                  <span className="text-[0.58rem] text-g5 tabular-nums">{weekLabels[i]}</span>
                </div>
              );
            })}
          </div>
          <div className="flex gap-4 mt-3">
            <div className="flex items-center gap-[5px] text-[0.68rem] text-g5"><span className="w-2 h-2 rounded-sm bg-black" /> Normal</div>
            <div className="flex items-center gap-[5px] text-[0.68rem] text-g5"><span className="w-2 h-2 rounded-sm bg-accent-green" /> Peak</div>
            <div className="flex items-center gap-[5px] text-[0.68rem] text-g5"><span className="w-2 h-2 rounded-sm bg-g5" /> Low</div>
          </div>
        </div>

        {/* Goal health */}
        <div className="col-span-6 bg-surface border border-black/[0.07] rounded-card p-[22px]">
          <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Goal Health</div>
          {goalHealth.length === 0 ? (
            <div className="text-[0.8rem] text-g5 py-4">No active goals found.</div>
          ) : (
            goalHealth.map((g, i) => {
              const pct = g.total > 0 ? Math.round((g.done / g.total) * 100) : 0;
              const activePct = g.total > 0 ? Math.round((g.active / g.total) * 100) : 0;
              const risk = pct < 25 && g.total > 0;
              return (
                <div key={g.id} className="grid grid-cols-[130px_1fr_50px_50px] items-center gap-[14px] py-[10px] border-b border-black/[0.07] last:border-b-0">
                  <div className="text-[0.78rem] font-medium text-g2">{g.name}</div>
                  <div className="flex h-[6px] rounded-[3px] overflow-hidden gap-[2px] bg-g8">
                    <div className="bg-black rounded-[3px]" style={{ width: `${pct}%` }} />
                    <div className="bg-g5 rounded-[3px]" style={{ width: `${activePct}%` }} />
                  </div>
                  <div className={`text-[0.74rem] font-semibold tabular-nums text-right ${risk ? 'text-accent-red' : pct >= 50 ? 'text-accent-green' : 'text-g3'}`}>{pct}%</div>
                  <div className="text-right text-[0.68rem] font-medium text-g5">{g.total}</div>
                </div>
              );
            })
          )}
        </div>

        {/* Anomalies */}
        <div className="col-span-6 bg-surface border border-black/[0.07] rounded-card p-[22px]">
          <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Anomalies Detected</div>
          {anomalies.map((a, i) => (
            <div key={i} className={`flex gap-3 items-start py-3 ${i > 0 ? 'border-t border-black/[0.07]' : ''}`}>
              <div className={`w-[6px] h-[6px] rounded-full mt-[6px] shrink-0 ${a.severity === 'high' ? 'bg-accent-red' : a.severity === 'med' ? 'bg-g3' : 'bg-g6'}`} />
              <div>
                <div className="text-[0.8rem] text-g4 leading-[1.45]" dangerouslySetInnerHTML={{ __html: a.text }} />
                <div className="text-[0.65rem] text-g5 mt-[2px]">{a.when}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Source throughput */}
        <div className="col-span-6 bg-surface border border-black/[0.07] rounded-card p-[22px]">
          <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Source Throughput</div>
          {sources.length === 0 ? (
            <div className="text-[0.8rem] text-g5 py-4">No work items synced yet.</div>
          ) : (
            sources.map((t, i) => {
              const badge = getSourceBadge(t.source);
              const pct = Math.round((t.count / maxSourceCount) * 100);
              return (
                <div key={i} className={`flex items-center gap-3 py-[9px] ${i > 0 ? 'border-t border-black/[0.07]' : ''}`}>
                  <div className={`w-6 h-6 rounded-[5px] grid place-items-center text-[0.52rem] font-bold uppercase text-white ${badge.color}`}>{badge.label}</div>
                  <div className="flex-1 text-[0.78rem] text-g4">{t.source}</div>
                  <div className="text-[0.78rem] font-semibold tabular-nums text-g2 min-w-[36px] text-right">{t.count}</div>
                  <div className="w-[120px]">
                    <div className="h-1 rounded-sm bg-g8 overflow-hidden">
                      <div className="h-full rounded-sm bg-black" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
