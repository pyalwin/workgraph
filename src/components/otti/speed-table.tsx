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
