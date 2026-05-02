import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AlertCardProps {
  title: string;
  body: string;
  tag: string;
}

export function AlertCard({ title, body, tag }: AlertCardProps) {
  return (
    <div className="bg-black rounded-[14px] p-[22px] text-white hover:shadow-[0_8px_30px_rgba(0,0,0,0.15)] transition-shadow border border-black">
      <div className="flex items-center gap-[5px] text-[0.63rem] font-semibold uppercase tracking-wide text-white/45 mb-[10px]">
        <span className="w-[5px] h-[5px] rounded-full bg-[#ff6b6b] animate-pulse" />
        Needs Attention
      </div>
      <div className="text-[0.88rem] font-semibold text-white mb-[6px] tracking-tight leading-[1.35]">{title}</div>
      <div className="text-[0.76rem] text-white/55 leading-[1.55]" dangerouslySetInnerHTML={{ __html: body }} />
      <div className="inline-flex mt-3 text-[0.67rem] font-medium text-white/70 px-2 py-[3px] rounded bg-white/[0.08]">{tag}</div>
    </div>
  );
}
