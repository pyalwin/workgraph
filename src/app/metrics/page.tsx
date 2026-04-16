import { StatCard } from '@/components/stat-card';

const goalHealth = [
  { name: 'AI / Copilot', pct: 42, trend: '+6%', trendDir: 'up', risk: false },
  { name: 'Platform', pct: 58, trend: '+4%', trendDir: 'up', risk: false },
  { name: 'Revenue', pct: 31, trend: '-3%', trendDir: 'down', risk: true },
  { name: 'Integrations', pct: 47, trend: '+8%', trendDir: 'up', risk: false },
  { name: 'Ops Excellence', pct: 38, trend: '-5%', trendDir: 'down', risk: true },
  { name: 'Onboarding', pct: 55, trend: '+11%', trendDir: 'up', risk: false },
];

const anomalies = [
  { severity: 'high', text: '<strong>Vendor pay activation</strong> — zero Jira movement for 21 days. Historically averages 3 updates/week.', when: 'Detected Apr 14 · Revenue & Retention' },
  { severity: 'high', text: '<strong>R2 velocity drop</strong> — 38 uncommitted items with 6 weeks to QA deadline. Need +40% throughput.', when: 'Detected Apr 10 · Ops Excellence' },
  { severity: 'med', text: '<strong>Copilot p95 latency</strong> jumped 3× (1.2s → 3.8s) after agent pipeline deploy on Apr 6.', when: 'Detected Apr 8 · AI/Copilot' },
  { severity: 'low', text: '<strong>Slack discussion spike</strong> — #integrations volume 4× above baseline. Possible blocker surfacing.', when: 'Detected Apr 12 · Integration Excellence' },
];

const throughput = [
  { src: 'Jira', label: 'JRA', color: 'bg-g1', count: 342, pct: 100, delta: '+18%', up: true },
  { src: 'Slack', label: 'SLK', color: 'bg-g3', count: 248, pct: 72, delta: '+9%', up: true },
  { src: 'Meetings', label: 'MTG', color: 'bg-g5', count: 140, pct: 41, delta: '+22%', up: true },
  { src: 'Notion', label: 'NOT', color: 'bg-g6', count: 82, pct: 24, delta: '-4%', up: false },
  { src: 'Gmail', label: 'GML', color: 'bg-g7 !text-g3', count: 35, pct: 10, delta: '+3%', up: true },
];

const weekBars = [45,52,38,61,55,48,70,65,42,58,72,80,68];

export default function MetricsPage() {
  return (
    <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
      <div className="mb-7">
        <h1 className="text-[1.5rem] font-bold tracking-tight text-black mb-[2px]">Metrics</h1>
        <p className="text-[0.82rem] text-g5">Performance analytics across all 6 strategic pillars</p>
      </div>

      {/* Period */}
      <div className="flex gap-[6px] mb-7">
        {['7d','30d','90d','YTD','All'].map((p, i) => (
          <button key={p} className={`px-[14px] py-[5px] rounded-lg text-[0.74rem] border cursor-pointer transition-all ${i === 2 ? 'bg-black border-black text-white font-medium' : 'bg-surface border-black/[0.07] text-g4 hover:border-black/[0.13]'}`}>
            {p}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-12 gap-[10px]">
        {/* KPIs */}
        <div className="col-span-3"><StatCard label="Velocity" value="38" delta="↑ 12% vs prior 90d" trend="up" /></div>
        <div className="col-span-3"><StatCard label="Cycle Time" value="4.2d" delta="↓ 0.8d improvement" trend="up" /></div>
        <div className="col-span-3"><StatCard label="Stale Rate" value="6.8%" delta="↑ 2.1% vs prior" trend="down" /></div>
        <div className="col-span-3"><StatCard label="Link Density" value="2.8×" delta="↑ avg cross-refs per item" trend="up" /></div>

        {/* Velocity chart */}
        <div className="col-span-6 bg-surface border border-black/[0.07] rounded-card p-[22px]">
          <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Weekly Throughput</div>
          <div className="flex items-end gap-[3px] h-[140px] pt-[10px]">
            {weekBars.map((h, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <div
                  className={`w-full rounded-t-[3px] ${h === 80 ? 'bg-accent-green' : h === 42 ? 'bg-g5' : 'bg-black'}`}
                  style={{ height: `${h}%` }}
                />
                <span className="text-[0.58rem] text-g5 tabular-nums">W{i+1}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-4 mt-3">
            <div className="flex items-center gap-[5px] text-[0.68rem] text-g5"><span className="w-2 h-2 rounded-sm bg-black" /> Normal</div>
            <div className="flex items-center gap-[5px] text-[0.68rem] text-g5"><span className="w-2 h-2 rounded-sm bg-accent-green" /> Peak</div>
            <div className="flex items-center gap-[5px] text-[0.68rem] text-g5"><span className="w-2 h-2 rounded-sm bg-g5" /> Low</div>
          </div>
        </div>

        {/* Goal health */}
        <div className="col-span-6 bg-surface border border-black/[0.07] rounded-card p-[22px]">
          <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Goal Health</div>
          {goalHealth.map((g, i) => (
            <div key={i} className="grid grid-cols-[130px_1fr_50px_50px] items-center gap-[14px] py-[10px] border-b border-black/[0.07] last:border-b-0">
              <div className="text-[0.78rem] font-medium text-g2">{g.name}</div>
              <div className="flex h-[6px] rounded-[3px] overflow-hidden gap-[2px] bg-g8">
                <div className="bg-black rounded-[3px]" style={{ width: `${g.pct}%` }} />
                <div className="bg-g5 rounded-[3px]" style={{ width: '12%' }} />
              </div>
              <div className={`text-[0.74rem] font-semibold tabular-nums text-right ${g.risk ? 'text-accent-red' : g.pct >= 50 ? 'text-accent-green' : 'text-g3'}`}>{g.pct}%</div>
              <div className={`text-right text-[0.68rem] font-medium ${g.trendDir === 'up' ? 'text-accent-green' : 'text-accent-red'}`}>{g.trend}</div>
            </div>
          ))}
        </div>

        {/* Anomalies */}
        <div className="col-span-6 bg-surface border border-black/[0.07] rounded-card p-[22px]">
          <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Anomalies Detected</div>
          {anomalies.map((a, i) => (
            <div key={i} className={`flex gap-3 items-start py-3 ${i > 0 ? 'border-t border-black/[0.07]' : ''}`}>
              <div className={`w-[6px] h-[6px] rounded-full mt-[6px] shrink-0 ${a.severity === 'high' ? 'bg-accent-red' : a.severity === 'med' ? 'bg-g3' : 'bg-g6'}`} />
              <div>
                <div className="text-[0.8rem] text-g4 leading-[1.45]" dangerouslySetInnerHTML={{ __html: a.text }} />
                <div className="text-[0.65rem] text-g5 mt-[2px]">{a.when}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Source throughput */}
        <div className="col-span-6 bg-surface border border-black/[0.07] rounded-card p-[22px]">
          <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[18px]">Source Throughput · Last 90 Days</div>
          {throughput.map((t, i) => (
            <div key={i} className={`flex items-center gap-3 py-[9px] ${i > 0 ? 'border-t border-black/[0.07]' : ''}`}>
              <div className={`w-6 h-6 rounded-[5px] grid place-items-center text-[0.52rem] font-bold uppercase text-white ${t.color}`}>{t.label}</div>
              <div className="flex-1 text-[0.78rem] text-g4">{t.src}</div>
              <div className="text-[0.78rem] font-semibold tabular-nums text-g2 min-w-[36px] text-right">{t.count}</div>
              <div className="w-[120px]">
                <div className="h-1 rounded-sm bg-g8 overflow-hidden">
                  <div className="h-full rounded-sm bg-black" style={{ width: `${t.pct}%` }} />
                </div>
              </div>
              <div className={`text-[0.67rem] font-medium min-w-[48px] text-right ${t.up ? 'text-accent-green' : 'text-accent-red'}`}>{t.delta}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
