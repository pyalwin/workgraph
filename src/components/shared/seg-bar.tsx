interface SegBarProps {
  done: number;
  wip: number;
  total: number;
}

export function SegBar({ done, wip, total }: SegBarProps) {
  const donePct = total > 0 ? (done / total) * 100 : 0;
  const wipPct = total > 0 ? (wip / total) * 100 : 0;

  return (
    <div className="flex h-[5px] rounded-[3px] overflow-hidden gap-[2px] bg-g8">
      <div className="bg-black rounded-[3px]" style={{ width: `${donePct}%` }} />
      <div className="bg-g5 rounded-[3px]" style={{ width: `${wipPct}%` }} />
      <div className="flex-1 rounded-[3px]" />
    </div>
  );
}
