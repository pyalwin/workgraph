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
      <div className="flex gap-[2px] h-[8px] rounded-[4px] overflow-hidden mb-4">
        {items.map((item, i) => (
          <div
            key={item.name}
            className={COLORS[i % COLORS.length]}
            style={{ width: `${item.pct}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {items.map((item, i) => (
          <div key={item.name} className="flex items-center gap-[6px]">
            <span className={`w-[8px] h-[8px] rounded-[2px] ${COLORS[i % COLORS.length]}`} />
            <span className="text-[0.72rem] text-g4">{item.name}</span>
            <span className="text-[0.72rem] font-semibold text-g3 tabular-nums">{item.count}</span>
            <span className="text-[0.65rem] text-g5 tabular-nums">{item.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
