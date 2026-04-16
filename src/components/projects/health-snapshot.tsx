'use client';

import { cn } from '@/lib/utils';

interface ProjectSignals {
  completion_pct: number;
  completion_done: number;
  completion_total: number;
  velocity: number;
  velocity_delta_pct: number;
  cycle_time_days: number;
  cycle_time_delta_pct: number;
  pr_cadence_per_week: number;
  stale_count: number;
  stale_pct: number;
}

interface HealthSnapshotProps {
  status: 'healthy' | 'needs_attention' | 'at_risk';
  summary: string | null;
  signals: ProjectSignals;
  onRefresh: () => void;
  refreshing: boolean;
}

const STATUS_CONFIG = {
  healthy: { label: 'Healthy', color: 'text-accent-green', bg: 'bg-accent-green', dot: 'bg-accent-green' },
  needs_attention: { label: 'Needs Attention', color: 'text-[#b8860b]', bg: 'bg-[#b8860b]', dot: 'bg-[#b8860b]' },
  at_risk: { label: 'At Risk', color: 'text-accent-red', bg: 'bg-accent-red', dot: 'bg-accent-red' },
};

export function HealthSnapshot({ status, summary, signals, onRefresh, refreshing }: HealthSnapshotProps) {
  const cfg = STATUS_CONFIG[status];

  return (
    <div className="bg-surface border border-black/[0.07] rounded-card overflow-hidden">
      {/* Narrative top */}
      <div className="px-[22px] pt-[18px] pb-[14px] border-b border-black/[0.05]">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-[8px]">
            <div className={cn("w-[9px] h-[9px] rounded-full", cfg.dot)} />
            <span className={cn("text-[0.82rem] font-semibold", cfg.color)}>{cfg.label}</span>
          </div>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="text-[0.68rem] text-g5 hover:text-g3 transition-colors cursor-pointer disabled:opacity-50"
          >
            {refreshing ? 'Generating...' : 'Refresh'}
          </button>
        </div>
        {summary && (
          <p className="text-[0.78rem] text-g3 leading-[1.55]">{summary}</p>
        )}
      </div>
      {/* Signal strip */}
      <div className="grid grid-cols-5 divide-x divide-black/[0.05] bg-[#fafafa]">
        <div className="py-[12px] px-[14px] text-center">
          <div className="text-[1.1rem] font-bold text-black tabular-nums">{signals.completion_pct}%</div>
          <div className="text-[0.6rem] text-g5">complete</div>
        </div>
        <div className="py-[12px] px-[14px] text-center">
          <div className={cn(
            "text-[1.1rem] font-bold tabular-nums",
            signals.velocity_delta_pct > 0 ? "text-accent-green" : signals.velocity_delta_pct < 0 ? "text-accent-red" : "text-black"
          )}>
            {signals.velocity_delta_pct > 0 ? '+' : ''}{signals.velocity_delta_pct}%
          </div>
          <div className="text-[0.6rem] text-g5">velocity</div>
        </div>
        <div className="py-[12px] px-[14px] text-center">
          <div className="text-[1.1rem] font-bold text-black tabular-nums">{signals.cycle_time_days}d</div>
          <div className="text-[0.6rem] text-g5">cycle time</div>
        </div>
        <div className="py-[12px] px-[14px] text-center">
          <div className="text-[1.1rem] font-bold text-black tabular-nums">{signals.pr_cadence_per_week}</div>
          <div className="text-[0.6rem] text-g5">PRs/wk</div>
        </div>
        <div className="py-[12px] px-[14px] text-center">
          <div className={cn(
            "text-[1.1rem] font-bold tabular-nums",
            signals.stale_count > 0 ? "text-accent-red" : "text-black"
          )}>{signals.stale_count}</div>
          <div className={cn("text-[0.6rem]", signals.stale_count > 0 ? "text-accent-red" : "text-g5")}>stale</div>
        </div>
      </div>
    </div>
  );
}
