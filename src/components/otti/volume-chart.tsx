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
            <span className="w-[12px] h-[2px] bg-accent-red/40" /> Deploy
          </div>
        )}
      </div>
    </div>
  );
}
