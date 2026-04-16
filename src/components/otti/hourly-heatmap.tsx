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

  const allValues = dates.flatMap(d => data[d]);
  const maxVal = Math.max(...allValues, 1);

  return (
    <div className="bg-surface border border-black/[0.07] rounded-card p-[22px]">
      <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Hourly Activity</div>
      <div className="overflow-x-auto">
        <div className="flex gap-[2px] mb-[2px] ml-[72px]">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="flex-1 min-w-[18px] text-center text-[0.55rem] text-g5 tabular-nums">
              {h % 3 === 0 ? `${h}` : ''}
            </div>
          ))}
        </div>
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
