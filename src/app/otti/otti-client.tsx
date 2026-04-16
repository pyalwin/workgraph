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

interface OttiMetrics {
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
  const vsLabel = compare ? 'before' : 'prior';

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
              delta={`${d.kpis.conversations.delta_pct > 0 ? '+' : ''}${d.kpis.conversations.delta_pct}% vs ${vsLabel}`}
              trend={d.kpis.conversations.delta_pct >= 0 ? 'up' : 'down'}
            />
          </div>
          <div className="col-span-3">
            <StatCard
              label="Unique Users"
              value={String(d.kpis.unique_users.value)}
              delta={`${d.kpis.unique_users.delta_pct > 0 ? '+' : ''}${d.kpis.unique_users.delta_pct}% vs ${vsLabel}`}
              trend={d.kpis.unique_users.delta_pct >= 0 ? 'up' : 'down'}
            />
          </div>
          <div className="col-span-3">
            <StatCard
              label="Sessions / User"
              value={String(d.kpis.sessions_per_user.value)}
              delta={`${d.kpis.sessions_per_user.delta_pct > 0 ? '+' : ''}${d.kpis.sessions_per_user.delta_pct}% vs ${vsLabel}`}
              trend={d.kpis.sessions_per_user.delta_pct >= 0 ? 'up' : 'down'}
            />
          </div>
          <div className="col-span-3">
            <StatCard
              label="Median Speed"
              value={formatDuration(d.kpis.median_speed_s.value)}
              delta={`${d.kpis.median_speed_s.delta_pct > 0 ? '+' : ''}${d.kpis.median_speed_s.delta_pct}% vs ${vsLabel}`}
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

      {/* ── Section: Engagement Details ── */}
      <div className="mb-8">
        <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-4 pb-2 border-b border-black/[0.07]">
          Engagement Details
        </div>
        <div className="grid grid-cols-12 gap-[10px]">
          {/* Top Users */}
          <div className="col-span-7 bg-surface border border-black/[0.07] rounded-card p-[22px]">
            <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">
              Top Users
            </div>
            <div className="space-y-0">
              <div className="grid grid-cols-[1fr_56px_90px_100px] gap-3 pb-2 border-b border-black/[0.07]">
                <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-g5">User</div>
                <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-g5 text-right">Sessions</div>
                <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-g5">Persona</div>
                <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-g5">Top Intent</div>
              </div>
              {d.top_users.map((u) => (
                <div key={u.user_id} className="grid grid-cols-[1fr_56px_90px_100px] gap-3 py-[10px] border-b border-black/[0.07] last:border-b-0">
                  <div className="text-[0.78rem] font-medium text-g2 truncate" title={u.user_id}>{u.display_name}</div>
                  <div className="text-[0.78rem] font-semibold tabular-nums text-g2 text-right">{u.sessions}</div>
                  <div className="text-[0.66rem] px-[7px] py-[2px] rounded-md bg-g9 text-g3 w-fit truncate">{u.persona}</div>
                  <div className="text-[0.68rem] text-g4 truncate">{u.top_intents[0] || ''}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Hourly Heatmap */}
          <div className="col-span-5">
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
