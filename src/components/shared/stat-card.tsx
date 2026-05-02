import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: string;
  delta?: string;
  trend?: 'up' | 'down' | 'flat';
}

export function StatCard({ label, value, delta, trend }: StatCardProps) {
  return (
    <Card className="col-span-4 relative overflow-hidden">
      <CardContent className="pt-[22px]">
        <CardTitle className="mb-[18px]">{label}</CardTitle>
        <div className="text-[2rem] font-bold tracking-tighter text-black tabular-nums leading-none mb-1">{value}</div>
        {delta && (
          <div className={cn(
            "text-[0.72rem]",
            trend === 'up' && "text-[#1a8754]",
            trend === 'down' && "text-[#c53030]",
            !trend && "text-[#555]"
          )}>
            {delta}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
