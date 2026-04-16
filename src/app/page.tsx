import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Sparkline } from '@/components/sparkline';
import { SegBar } from '@/components/seg-bar';
import { AlertCard } from '@/components/alert-card';
import { StatCard } from '@/components/stat-card';
import { getDb } from '@/lib/db';
import { initSchema, seedGoals } from '@/lib/schema';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface GoalRow { id: string; name: string; item_count: number; source_count: number; }
interface MetricsRow { total_items: number; done_items: number; active_items: number; stale_items: number; cross_ref_count: number; }
interface SourceCount { source: string; c: number; }
interface StaleRow { title: string; days: number; goal_name: string; }
interface RecentRow { title: string; source: string; goal_name: string; created_at: string; }

function getOverviewData() {
  try {
    initSchema();
    seedGoals();
    const db = getDb();

    const totalItems = (db.prepare("SELECT COUNT(*) as c FROM work_items").get() as any)?.c || 0;
    const totalLinks = (db.prepare("SELECT COUNT(*) as c FROM links").get() as any)?.c || 0;
    const totalDecisions = (db.prepare("SELECT COUNT(*) as c FROM work_items WHERE item_type = 'message' OR item_type = 'meeting'").get() as any)?.c || 0;

    // Goal data with metrics
    const goalsData = db.prepare(`
      SELECT g.id, g.name, g.item_count, g.source_count,
        COALESCE(m.total_items, 0) as total, COALESCE(m.done_items, 0) as done,
        COALESCE(m.active_items, 0) as active, COALESCE(m.stale_items, 0) as stale,
        COALESCE(m.cross_ref_count, 0) as xrefs
      FROM goals g
      LEFT JOIN metrics_snapshots m ON m.goal_id = g.id
      WHERE g.status = 'active'
      ORDER BY g.sort_order
    `).all() as any[];

    // Source distribution
    const sources = db.prepare("SELECT source, COUNT(*) as c FROM work_items GROUP BY source ORDER BY c DESC").all() as SourceCount[];

    // Stale items (no update in 14+ days)
    const staleItems = db.prepare(`
      SELECT wi.title, CAST(julianday('now') - julianday(wi.updated_at) AS INTEGER) as days,
        COALESCE(g.name, 'Uncategorized') as goal_name
      FROM work_items wi
      LEFT JOIN item_tags it ON it.item_id = wi.id
      LEFT JOIN goals g ON g.id = it.tag_id
      WHERE julianday('now') - julianday(wi.updated_at) >= 14
        AND wi.status NOT IN ('done')
      ORDER BY days DESC
      LIMIT 6
    `).all() as StaleRow[];

    // Recent notable items (decisions, meetings, messages)
    const recent = db.prepare(`
      SELECT wi.title, wi.source, wi.created_at,
        COALESCE(g.name, 'General') as goal_name
      FROM work_items wi
      LEFT JOIN item_tags it ON it.item_id = wi.id
      LEFT JOIN goals g ON g.id = it.tag_id
      WHERE wi.item_type IN ('message', 'meeting')
      GROUP BY wi.id
      ORDER BY wi.created_at DESC
      LIMIT 8
    `).all() as RecentRow[];

    return { totalItems, totalLinks, totalDecisions, goalsData, sources, staleItems, recent, hasData: totalItems > 0 };
  } catch {
    return { totalItems: 0, totalLinks: 0, totalDecisions: 0, goalsData: [], sources: [], staleItems: [], recent: [], hasData: false };
  }
}

export default function OverviewPage() {
  const data = getOverviewData();

  // Map DB goals to display format
  const goals = data.goalsData.length > 0
    ? data.goalsData.map((g: any) => {
        const total = g.total || 1;
        const donePct = Math.round((g.done / total) * 100);
        const wipPct = Math.round((g.active / total) * 100);
        const trend = g.done > g.active ? 'up' as const : g.stale > g.active ? 'down' as const : 'up' as const;
        return {
          name: g.name.replace(' Leadership', '').replace('Operational ', 'Ops '),
          detail: `${g.item_count} items · ${g.done} done · ${g.active} active`,
          pct: donePct,
          done: donePct,
          wip: wipPct,
          trend,
        };
      })
    : [
        { name: 'AI / Copilot', detail: '17 epics · 19 shipped · 8 active', pct: 42, done: 42, wip: 18, trend: 'up' as const },
        { name: 'Platform', detail: '6 epics · 27 shipped', pct: 58, done: 58, wip: 12, trend: 'up' as const },
        { name: 'Revenue & Retention', detail: '10 epics · 89%→95% GR target', pct: 31, done: 31, wip: 10, trend: 'down' as const },
        { name: 'Integrations', detail: '10 epics · Data Dash rollout', pct: 47, done: 47, wip: 15, trend: 'up' as const },
        { name: 'Ops Excellence', detail: 'R2: 72/110 on track', pct: 38, done: 38, wip: 20, trend: 'down' as const },
        { name: 'Fast Onboarding', detail: '3.4mo→2wk · Login shipped', pct: 55, done: 55, wip: 8, trend: 'up' as const },
      ];

  const totalItems = data.totalItems || 285;

  const staleItems = data.staleItems.length > 0
    ? data.staleItems.map(s => ({ title: s.title, days: s.days, goal: s.goal_name }))
    : [
        { title: 'Bulk vendor ACH upload — awaiting API spec', days: 28, goal: 'Revenue' },
        { title: 'VendorPay activation campaign — unassigned', days: 21, goal: 'Revenue' },
        { title: 'Acumatica auth update — blocked on vendor', days: 16, goal: 'Integrations' },
        { title: 'Generic build onboarding — design not started', days: 14, goal: 'Onboarding' },
      ];

  const decisions = data.recent.length > 0
    ? data.recent.map(r => {
        const d = new Date(r.created_at);
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return {
          month: months[d.getMonth()] || 'Apr',
          day: String(d.getDate()),
          text: r.title.length > 160 ? r.title.slice(0, 157) + '…' : r.title,
          source: r.source === 'granola' ? 'Meeting' : r.source.charAt(0).toUpperCase() + r.source.slice(1),
          goal: r.goal_name,
        };
      })
    : [
        { month: 'Apr', day: '10', text: 'Login revamp go-live confirmed — passkeys + TOTP authenticator replacing password/SMS', source: 'Slack', goal: 'Onboarding' },
        { month: 'Apr', day: '8', text: 'R2 scope locked at 110 commitments — QA deadline May 29', source: 'Jira', goal: 'Ops Excellence' },
        { month: 'Apr', day: '2', text: 'Stabilization marathon May 28 – Jul 20. Feature freeze. 1,000+ bug burndown', source: 'Meeting', goal: 'Ops Excellence' },
        { month: 'Mar', day: '15', text: 'Data Dash enforced as new ERP standard — legacy serializer sunset Q3', source: 'Slack', goal: 'Integration Excellence' },
      ];

  const sourceColorMap: Record<string, string> = { jira: 'bg-[#111]', slack: 'bg-[#555]', granola: 'bg-[#999]', notion: 'bg-[#bbb]', gmail: 'bg-[#ddd]' };
  const sourceNameMap: Record<string, string> = { jira: 'Jira', slack: 'Slack', granola: 'Meetings', notion: 'Notion', gmail: 'Gmail' };
  const sources = data.sources.length > 0
    ? data.sources.map(s => ({ name: sourceNameMap[s.source] || s.source, count: s.c, color: sourceColorMap[s.source] || 'bg-[#ddd]' }))
    : [
        { name: 'Jira', count: 100, color: 'bg-[#111]' },
        { name: 'Meetings', count: 140, color: 'bg-[#999]' },
        { name: 'Slack', count: 20, color: 'bg-[#555]' },
        { name: 'Notion', count: 25, color: 'bg-[#bbb]' },
      ];

  return (
    <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
      <div className="mb-8">
        <h1 className="text-[1.5rem] font-bold tracking-tight text-black mb-[2px]">Good afternoon, Arun</h1>
        <p className="text-[0.82rem] text-[#999]">Jan 1 – Apr 16, 2026 · {totalItems} items across 5 sources</p>
      </div>

      <div className="grid grid-cols-12 gap-[10px] mb-11">
        {/* Hero: Goal Map */}
        <Card className="col-span-8 row-span-2">
          <CardContent className="pt-[22px]">
            <CardTitle className="mb-[18px]">Strategic Pillars</CardTitle>
            <div className="flex flex-col">
              {goals.map((g, i) => (
                <div key={i} className="grid grid-cols-[175px_1fr_80px_36px] items-center gap-5 py-[13px] px-[6px] border-b border-black/[0.07] last:border-b-0 cursor-pointer hover:bg-[#f5f5f5] hover:rounded-lg transition-all">
                  <div>
                    <div className="text-[0.87rem] font-medium text-black tracking-tight">{g.name}</div>
                    <div className="text-[0.7rem] text-[#999] mt-[1px]">{g.detail}</div>
                  </div>
                  <SegBar done={g.done} wip={g.wip} total={100} />
                  <div className="flex justify-end"><Sparkline trend={g.trend} /></div>
                  <div className={cn("text-[0.78rem] font-semibold tabular-nums text-right", g.pct < 35 ? "text-[#c53030]" : "text-[#333]")}>
                    {g.pct}%
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Alert Cards */}
        <div className="col-span-4">
          <AlertCard
            title="Vendor pay activation frozen 3 weeks"
            body="600+ customers without activation. No Jira movement since Mar 24. Last Slack mention Mar 26."
            tag="→ PAY-298 unassigned"
          />
        </div>
        <div className="col-span-4">
          <AlertCard
            title="38 R2 items uncommitted"
            body='QA deadline May 29. Current velocity needs <strong>+40%</strong> to clear. Stabilization marathon starts May 28.'
            tag="→ 6 weeks remaining"
          />
        </div>

        {/* Stats */}
        <StatCard label="Work Items" value={String(totalItems)} delta={`across ${sources.length} sources`} trend="up" />
        <StatCard label="Decisions" value={String(data.totalDecisions || 160)} delta="meetings + messages" trend="up" />
        <StatCard label="Cross-References" value={String(data.totalLinks || 1)} delta="auto-linked across sources" />

        {/* Source Distribution */}
        <Card className="col-span-6">
          <CardContent className="pt-[22px]">
            <CardTitle className="mb-[18px]">Knowledge Base · {totalItems} items</CardTitle>
            <div className="flex gap-[2px] h-[6px] rounded-[3px] overflow-hidden mb-[14px]">
              {sources.map((s) => (
                <div key={s.name} className={cn("rounded-[3px]", s.color)} style={{ width: `${Math.round((s.count / totalItems) * 100)}%` }} />
              ))}
            </div>
            <div className="flex gap-[14px] flex-wrap">
              {sources.map((s) => (
                <div key={s.name} className="flex items-center gap-[5px] text-[0.7rem] text-[#999]">
                  <div className={cn("w-[6px] h-[6px] rounded-[2px]", s.color)} />
                  {s.name} <span className="font-semibold text-[#333] tabular-nums">{s.count}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Stale Items */}
        <Card className="col-span-6">
          <CardContent className="pt-[22px]">
            <CardTitle className="mb-[18px]">Stale · No movement 14+ days</CardTitle>
            {staleItems.map((item, i) => (
              <div key={i} className={cn("flex items-center gap-3 py-[9px]", i > 0 && "border-t border-black/[0.07]")}>
                <Badge variant={item.days >= 21 ? "destructive" : "secondary"} className={cn(
                  "text-[0.68rem] font-bold tabular-nums min-w-[30px] justify-center py-[2px]",
                  item.days >= 21 ? "bg-[#c53030] text-white hover:bg-[#c53030]" : item.days >= 16 ? "bg-[#bbb] text-white hover:bg-[#bbb]" : "bg-black text-white hover:bg-black"
                )}>
                  {item.days}d
                </Badge>
                <div className="flex-1 text-[0.78rem] text-[#777]">{item.title}</div>
                <Badge variant="secondary" className="text-[0.63rem]">{item.goal}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Decision Feed */}
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999]">Recent Decisions</h2>
        <div className="flex gap-px">
          {['All', 'Meetings', 'Slack', 'Jira'].map((tab, i) => (
            <button key={tab} className={cn(
              "px-[10px] py-1 rounded-[6px] text-[0.72rem] border-none cursor-pointer font-[inherit]",
              i === 0 ? "text-black bg-white shadow-sm font-medium" : "text-[#999] bg-transparent hover:text-[#777]"
            )}>
              {tab}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col">
        {decisions.map((d, i) => (
          <div key={i} className="grid grid-cols-[40px_1fr_auto] gap-[14px] items-start py-[13px] border-t border-black/[0.07] cursor-pointer hover:bg-[#f5f5f5] hover:-mx-2 hover:px-2 hover:rounded-lg transition-all">
            <div className="text-[0.68rem] text-[#999] pt-[2px]">
              {d.month}<span className="block text-[0.82rem] font-semibold text-[#333]">{d.day}</span>
            </div>
            <div>
              <div className="text-[0.84rem] text-[#777] leading-[1.45] hover:text-black transition-colors">{d.text}</div>
              <div className="flex items-center gap-2 mt-[5px]">
                <Badge variant="source">{d.source}</Badge>
                <span className="text-[0.65rem] text-[#999]">{d.goal}</span>
              </div>
            </div>
            <div className="flex gap-[3px] pt-[3px]">
              <div className="w-[5px] h-[5px] rounded-full bg-[#ddd]" />
              <div className="w-[5px] h-[5px] rounded-full bg-[#ddd]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
