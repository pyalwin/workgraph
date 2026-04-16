'use client';

import { cn } from '@/lib/utils';

interface Deployment {
  id: string;
  name: string;
  deploy_date: string;
}

interface CompareControlsProps {
  enabled: boolean;
  onToggle: () => void;
  splitDate: string;
  onSplitDateChange: (date: string) => void;
  deployments: Deployment[];
}

export function CompareControls({
  enabled,
  onToggle,
  splitDate,
  onSplitDateChange,
  deployments,
}: CompareControlsProps) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onToggle}
        className={cn(
          "px-[12px] py-[5px] rounded-lg text-[0.74rem] border cursor-pointer transition-all",
          enabled
            ? "bg-black border-black text-white font-medium"
            : "bg-surface border-black/[0.07] text-g4 hover:border-black/[0.13]"
        )}
      >
        Compare
      </button>
      {enabled && (
        <div className="flex items-center gap-2">
          <select
            value={splitDate}
            onChange={(e) => onSplitDateChange(e.target.value)}
            className="h-[30px] px-2 rounded-lg border border-black/[0.07] text-[0.74rem] text-g3 bg-white cursor-pointer"
          >
            <option value="">Custom date...</option>
            {deployments.map((d) => (
              <option key={d.id} value={d.deploy_date}>
                {d.name} ({d.deploy_date})
              </option>
            ))}
          </select>
          <input
            type="date"
            value={splitDate}
            onChange={(e) => onSplitDateChange(e.target.value)}
            className="h-[30px] px-2 rounded-lg border border-black/[0.07] text-[0.74rem] text-g3 bg-white"
          />
        </div>
      )}
    </div>
  );
}
