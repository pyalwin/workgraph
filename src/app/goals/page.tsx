import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getDb } from '@/lib/db';
import { initSchema, seedGoals } from '@/lib/schema';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface GoalRow {
  id: string;
  name: string;
  description: string;
  keywords: string;
  item_count: number;
  done_count: number;
  active_count: number;
  source_count: number;
}

interface RecentItemRow {
  title: string;
  source: string;
  status: string;
  source_id: string;
  created_at: string;
}

const SOURCE_BADGE: Record<string, { label: string; color: string }> = {
  jira:    { label: 'JRA', color: 'bg-[#111] text-white' },
  slack:   { label: 'SLK', color: 'bg-[#555] text-white' },
  granola: { label: 'MTG', color: 'bg-[#777] text-white' },
  meeting: { label: 'MTG', color: 'bg-[#777] text-white' },
  notion:  { label: 'NOT', color: 'bg-[#999] text-white' },
  gmail:   { label: 'GML', color: 'bg-[#bbb] text-white' },
};

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function formatStatus(status: string | null): string {
  if (!status) return '';
  return status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function getGoalsData() {
  try {
    initSchema();
    seedGoals();
    const db = getDb();

    const goals = db.prepare(`
      SELECT g.id, g.name, g.description, g.keywords,
        COUNT(it.item_id) as item_count,
        SUM(CASE WHEN wi.status IN ('done', 'closed', 'resolved') THEN 1 ELSE 0 END) as done_count,
        SUM(CASE WHEN wi.status IN ('open', 'in_progress', 'to_do') THEN 1 ELSE 0 END) as active_count,
        COUNT(DISTINCT wi.source) as source_count
      FROM goals g
      LEFT JOIN item_tags it ON it.tag_id = g.id
      LEFT JOIN work_items wi ON wi.id = it.item_id
      WHERE g.status = 'active'
      GROUP BY g.id
      ORDER BY g.sort_order
    `).all() as GoalRow[];

    const recentItemsStmt = db.prepare(`
      SELECT wi.title, wi.source, wi.status, wi.source_id, wi.created_at
      FROM work_items wi
      JOIN item_tags it ON it.item_id = wi.id
      WHERE it.tag_id = ?
      ORDER BY wi.created_at DESC
      LIMIT 8
    `);

    const goalsWithItems = goals.map(goal => ({
      ...goal,
      recentItems: recentItemsStmt.all(goal.id) as RecentItemRow[],
    }));

    return { goals: goalsWithItems, hasData: goals.length > 0 };
  } catch {
    return { goals: [], hasData: false };
  }
}

export default function GoalsPage() {
  const { goals, hasData } = getGoalsData();

  return (
    <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
      <div className="mb-8">
        <h1 className="text-[1.5rem] font-bold tracking-tight text-black mb-[2px]">Goals</h1>
        <p className="text-[0.82rem] text-[#999]">
          {hasData
            ? `${goals.length} strategic pillars tracking work across all sources`
            : 'Deep-dive into each strategic pillar'}
        </p>
      </div>

      {!hasData && (
        <div className="mt-8 p-8 bg-white border border-black/[0.07] rounded-[14px] text-center text-[#999] text-[0.87rem]">
          No goals configured yet. Run a sync to populate work items.
        </div>
      )}

      <div className="flex flex-col gap-[14px]">
        {goals.map(goal => {
          const total = goal.item_count || 0;
          const done = goal.done_count || 0;
          const active = goal.active_count || 0;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;

          return (
            <Card key={goal.id}>
              <CardContent className="pt-[22px]">
                {/* Goal header */}
                <div className="flex items-start justify-between mb-[14px]">
                  <div>
                    <h2 className="text-[1.05rem] font-semibold tracking-tight text-black">{goal.name}</h2>
                    <p className="text-[0.78rem] text-[#999] mt-[2px]">{goal.description}</p>
                  </div>
                  <div className={cn(
                    "text-[1.1rem] font-bold tabular-nums",
                    pct < 35 ? "text-[#c53030]" : "text-[#333]"
                  )}>
                    {pct}%
                  </div>
                </div>

                {/* Stats row */}
                <div className="text-[0.72rem] text-[#999] mb-[10px]">
                  {total} items &middot; {done} done &middot; {active} active &middot; from {goal.source_count} source{goal.source_count !== 1 ? 's' : ''}
                </div>

                {/* Progress bar */}
                <div className="flex h-[5px] rounded-[3px] overflow-hidden bg-[#f0f0f0] mb-[18px]">
                  {total > 0 && (
                    <div
                      className="bg-[#111] rounded-[3px] transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  )}
                </div>

                {/* Recent items */}
                {goal.recentItems.length > 0 && (
                  <div>
                    <CardTitle className="mb-[12px]">Recent Items</CardTitle>
                    <div className="flex flex-col">
                      {goal.recentItems.map((item, i) => {
                        const badge = SOURCE_BADGE[item.source] || { label: item.source.slice(0, 3).toUpperCase(), color: 'bg-[#ddd] text-[#555]' };
                        return (
                          <div
                            key={`${item.source}-${item.source_id}-${i}`}
                            className={cn(
                              "grid grid-cols-[42px_1fr_auto_auto] items-center gap-3 py-[9px]",
                              i > 0 && "border-t border-black/[0.07]"
                            )}
                          >
                            <Badge
                              variant="source"
                              className={cn("text-[0.6rem] justify-center py-[2px] px-[5px]", badge.color)}
                            >
                              {badge.label}
                            </Badge>
                            <div className="text-[0.78rem] text-[#777] truncate">
                              {item.title}
                            </div>
                            {item.status && (
                              <Badge
                                variant="secondary"
                                className={cn(
                                  "text-[0.63rem] whitespace-nowrap",
                                  item.status === 'done' || item.status === 'closed' || item.status === 'resolved'
                                    ? 'bg-[rgba(26,135,84,0.08)] text-[#1a8754]'
                                    : ''
                                )}
                              >
                                {formatStatus(item.status)}
                              </Badge>
                            )}
                            <span className="text-[0.68rem] text-[#bbb] tabular-nums whitespace-nowrap">
                              {formatDate(item.created_at)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
