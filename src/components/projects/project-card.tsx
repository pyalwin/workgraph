import Link from 'next/link';
import { cn } from '@/lib/utils';

interface ProjectCardProps {
  projectKey: string;
  name: string;
  healthStatus: 'healthy' | 'needs_attention' | 'at_risk';
  summarySnippet: string | null;
  completionPct: number;
  completionDone: number;
  completionTotal: number;
  velocity: number;
  velocityDeltaPct: number;
  openCount: number;
  staleCount: number;
  prCount: number;
}

const HEALTH_DOT = {
  healthy: 'bg-accent-green',
  needs_attention: 'bg-[#b8860b]',
  at_risk: 'bg-accent-red',
};

const HEALTH_LABEL = {
  healthy: 'Healthy',
  needs_attention: 'Needs Attention',
  at_risk: 'At Risk',
};

export function ProjectCard({
  projectKey, name, healthStatus, summarySnippet,
  completionPct, completionDone, completionTotal,
  velocity, velocityDeltaPct, openCount, staleCount, prCount,
}: ProjectCardProps) {
  return (
    <Link href={`/projects/${projectKey}`} className="no-underline block">
      <div className="bg-surface border border-black/[0.07] rounded-card p-[22px] transition-all hover:shadow-[0_4px_20px_rgba(0,0,0,0.04)] hover:border-black/[0.13] cursor-pointer">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-[1.05rem] font-semibold tracking-tight text-black">{name}</h2>
            <span className="text-[0.68rem] font-mono text-g5 bg-g9 px-[6px] py-[1px] rounded">{projectKey}</span>
          </div>
          <div className="flex items-center gap-[6px]">
            <div className={cn("w-[7px] h-[7px] rounded-full", HEALTH_DOT[healthStatus])} />
            <span className="text-[0.7rem] font-medium text-g4">{HEALTH_LABEL[healthStatus]}</span>
          </div>
        </div>

        {/* Summary snippet */}
        {summarySnippet && (
          <p className="text-[0.76rem] text-g4 leading-[1.5] mb-3 line-clamp-2">{summarySnippet}</p>
        )}

        {/* Progress bar */}
        <div className="flex h-[5px] rounded-[3px] overflow-hidden bg-g8 mb-3">
          <div className="bg-black rounded-[3px] transition-all" style={{ width: `${completionPct}%` }} />
        </div>

        {/* Signal row */}
        <div className="flex items-center gap-4 text-[0.7rem]">
          <div className="flex items-center gap-1">
            <span className="font-semibold text-g2 tabular-nums">{completionPct}%</span>
            <span className="text-g5">done</span>
          </div>
          <div className="flex items-center gap-1">
            <span className={cn(
              "font-semibold tabular-nums",
              velocityDeltaPct > 0 ? "text-accent-green" : velocityDeltaPct < 0 ? "text-accent-red" : "text-g2"
            )}>
              {velocity}
            </span>
            <span className="text-g5">closed</span>
            {velocityDeltaPct !== 0 && (
              <span className={cn(
                "text-[0.62rem] tabular-nums",
                velocityDeltaPct > 0 ? "text-accent-green" : "text-accent-red"
              )}>
                ({velocityDeltaPct > 0 ? '+' : ''}{velocityDeltaPct}%)
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <span className="font-semibold text-g2 tabular-nums">{openCount}</span>
            <span className="text-g5">open</span>
          </div>
          {staleCount > 0 && (
            <div className="flex items-center gap-1">
              <span className="font-semibold text-accent-red tabular-nums">{staleCount}</span>
              <span className="text-accent-red">stale</span>
            </div>
          )}
          <div className="flex items-center gap-1 ml-auto">
            <span className="font-semibold text-g3 tabular-nums">{prCount}</span>
            <span className="text-g5">PRs</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
