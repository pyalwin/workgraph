'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { PeriodSelector } from '@/components/otti/period-selector';
import { HealthSnapshot } from '@/components/projects/health-snapshot';
import { TicketList } from '@/components/projects/ticket-list';
import type { ProjectDetail } from '@/lib/project-queries';

const PERIODS = ['30d', '90d', 'all'];

export function ProjectDetailClient({ projectKey }: { projectKey: string }) {
  const [period, setPeriod] = useState('30d');
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/projects/${projectKey}?period=${period}`);
    const json = await res.json();
    setData(json);
    setLoading(false);
  }, [projectKey, period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    const res = await fetch(`/api/projects/${projectKey}/refresh-summary`, { method: 'POST' });
    const { summary } = await res.json();
    setData(prev => prev ? { ...prev, health: { ...prev.health, summary } } : prev);
    setRefreshing(false);
  };

  if (loading && !data) {
    return (
      <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
        <div className="text-[0.82rem] text-g5">Loading...</div>
      </div>
    );
  }

  if (!data) return null;

  const d = data;
  const s = d.health.signals;
  const maxWeekly = Math.max(...d.velocity_weekly.map(w => w.closed), 1);

  return (
    <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
      {/* Header */}
      <div className="mb-2">
        <Link href="/projects" className="text-[0.74rem] text-g5 hover:text-g3 no-underline transition-colors">
          &larr; Back to Projects
        </Link>
      </div>
      <div className="flex items-start justify-between mb-7">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[1.5rem] font-bold tracking-tight text-black">{d.project.name}</h1>
            <span className="text-[0.72rem] font-mono text-g5 bg-g9 px-[7px] py-[2px] rounded">{d.project.key}</span>
          </div>
          <p className="text-[0.82rem] text-g5">
            {d.project.total_tickets} tickets &middot; {d.project.total_prs} linked PRs
          </p>
        </div>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      {/* Health Snapshot */}
      <div className="mb-8">
        <HealthSnapshot
          status={d.health.status}
          summary={d.health.summary}
          signals={d.health.signals}
          onRefresh={handleRefresh}
          refreshing={refreshing}
        />
      </div>

      {/* Velocity + Code Activity */}
      <div className="mb-8">
        <div className="grid grid-cols-12 gap-[10px]">
          {/* Velocity chart */}
          <div className="col-span-6 bg-surface border border-black/[0.07] rounded-card p-[22px]">
            <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Tickets Closed / Week</div>
            {d.velocity_weekly.length === 0 ? (
              <div className="text-[0.8rem] text-g5 py-4">No velocity data for this period.</div>
            ) : (
              <div className="flex items-end gap-[4px]" style={{ height: 120 }}>
                {d.velocity_weekly.map((w, i) => {
                  const h = Math.max(Math.round((w.closed / maxWeekly) * 100), w.closed > 0 ? 6 : 2);
                  const isLast = i === d.velocity_weekly.length - 1;
                  return (
                    <div key={w.week} className="flex-1 flex flex-col items-center justify-end gap-1" style={{ height: 110 }}>
                      <div className="text-[0.58rem] font-semibold tabular-nums text-g4">{w.closed}</div>
                      <div
                        className={`w-full rounded-t-[3px] ${w.closed === 0 ? 'bg-g8' : isLast ? 'bg-accent-green' : 'bg-black'}`}
                        style={{ height: h }}
                      />
                      <span className="text-[0.55rem] text-g5 tabular-nums">{w.week}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Code Activity - right side */}
          <div className="col-span-6 bg-surface border border-black/[0.07] rounded-card p-[22px]">
            <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Code Activity</div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-5">
              <div>
                <div className="text-[1.5rem] font-bold text-black tabular-nums leading-none">{d.code_activity.total_prs}</div>
                <div className="text-[0.68rem] text-g5 mt-1">linked PRs ({d.code_activity.merged_prs} merged, {d.code_activity.open_prs} open)</div>
              </div>
              <div>
                <div className="text-[1.5rem] font-bold text-black tabular-nums leading-none">{d.code_activity.contributor_count}</div>
                <div className="text-[0.68rem] text-g5 mt-1 truncate">contributors</div>
              </div>
              <div>
                <div className="text-[1.5rem] font-bold text-black tabular-nums leading-none">{d.code_activity.merge_cadence_per_week}</div>
                <div className="text-[0.68rem] text-g5 mt-1">PRs merged / week</div>
              </div>
              <div>
                <div className="text-[1.5rem] font-bold text-black tabular-nums leading-none">{d.code_activity.repo_count}</div>
                <div className="text-[0.68rem] text-g5 mt-1 truncate">{d.code_activity.repos.map(r => r.split('/').pop()).join(', ')}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tickets & Features */}
      <div className="mb-8">
        <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-4 pb-2 border-b border-black/[0.07]">
          Tickets & Features Built
        </div>
        <TicketList tickets={d.tickets} />
      </div>
    </div>
  );
}
