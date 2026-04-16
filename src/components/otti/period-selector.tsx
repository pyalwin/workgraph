'use client';

import { cn } from '@/lib/utils';

const PERIODS = ['7d', '30d', '90d', 'all'] as const;

interface PeriodSelectorProps {
  value: string;
  onChange: (period: string) => void;
}

export function PeriodSelector({ value, onChange }: PeriodSelectorProps) {
  return (
    <div className="flex gap-[6px]">
      {PERIODS.map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={cn(
            "px-[14px] py-[5px] rounded-lg text-[0.74rem] border cursor-pointer transition-all",
            p === value
              ? "bg-black border-black text-white font-medium"
              : "bg-surface border-black/[0.07] text-g4 hover:border-black/[0.13]"
          )}
        >
          {p === 'all' ? 'All' : p.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
