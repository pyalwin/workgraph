'use client';
import { useState } from 'react';
import { StatusDot } from '@/components/status-dot';

const seedResults = [
  { src: 'meet', srcLabel: 'MTG', title: 'Agent-based LLM pipeline (GPT + Gemini 2.5 Flash) replacing fine-tuned models', origin: 'Architecture Review: AI', goal: 'AI/Copilot', links: 4, date: 'Feb 10', status: 'active' },
  { src: 'jira', srcLabel: 'JRA', title: 'COPILOT-892: Agent pipeline v2 — multi-step reasoning with tool calling', origin: 'Otti Copilot', goal: 'AI/Copilot', links: 6, date: 'Mar 22', status: 'active' },
  { src: 'slack', srcLabel: 'SLK', title: '"Agent pipeline accuracy at 94.2% on validation set — ready for staged rollout"', origin: '#copilot-eng', goal: 'AI/Copilot', links: 3, date: 'Apr 3', status: 'done' },
  { src: 'jira', srcLabel: 'JRA', title: 'COPILOT-910: Pipeline latency regression — p95 jumped from 1.2s to 3.8s', origin: 'Otti Copilot', goal: 'AI/Copilot', links: 2, date: 'Apr 8', status: 'stale' },
  { src: 'slack', srcLabel: 'SLK', title: '"Should we gate agent pipeline behind feature flag for enterprise tier first?"', origin: '#copilot-product', goal: 'AI/Copilot', links: 2, date: 'Apr 1', status: 'open' },
  { src: 'meet', srcLabel: 'MTG', title: 'Pipeline cost analysis: $0.12/query vs $0.03 fine-tuned — needs optimization', origin: 'AI Standup', goal: 'AI/Copilot', links: 5, date: 'Mar 18', status: 'active' },
  { src: 'notion', srcLabel: 'NOT', title: 'Copilot Agent Architecture RFC — multi-model orchestration spec', origin: 'Engineering Docs', goal: 'AI/Copilot', links: 8, date: 'Feb 5', status: 'done' },
  { src: 'jira', srcLabel: 'JRA', title: 'COPILOT-845: Prompt caching layer for repeated agent tool calls', origin: 'Otti Copilot', goal: 'Platform', links: 3, date: 'Mar 5', status: 'done' },
];

const srcColors: Record<string, string> = { jira: 'bg-g1', slack: 'bg-g3', meet: 'bg-g5', notion: 'bg-g6', gmail: 'bg-g7 !text-g3' };

const filters = ['All Sources', 'Jira', 'Slack', 'Meetings', 'Notion', 'Gmail'];
const goalFilters = ['AI/Copilot', 'Platform', 'Ops'];

export default function KnowledgePage() {
  const [query, setQuery] = useState('copilot agent pipeline');
  const [activeFilter, setActiveFilter] = useState('All Sources');

  return (
    <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
      <div className="mb-7">
        <h1 className="text-[1.5rem] font-bold tracking-tight text-black mb-[2px]">Knowledge Base</h1>
        <p className="text-[0.82rem] text-g5">847 items across 5 sources · 234 cross-references</p>
      </div>

      {/* Search */}
      <div className="flex items-center gap-[10px] bg-surface border border-black/[0.07] rounded-[10px] px-4 h-[44px] mb-4 focus-within:border-g4 focus-within:shadow-[0_0_0_3px_rgba(0,0,0,0.04)] transition-all">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-g5 shrink-0"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input
          className="flex-1 border-none outline-none bg-transparent text-[0.87rem] text-g2 placeholder:text-g6"
          placeholder="Search decisions, Jira keys, people, topics..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="text-[0.67rem] font-semibold text-white bg-black px-[7px] py-[2px] rounded-[10px]">{seedResults.length}</div>
      </div>

      {/* Filters */}
      <div className="flex gap-[6px] mb-6 flex-wrap">
        {filters.map((f) => (
          <button key={f} onClick={() => setActiveFilter(f)} className={`flex items-center gap-[5px] px-3 py-[5px] rounded-lg text-[0.74rem] border transition-all cursor-pointer ${activeFilter === f ? 'bg-black border-black text-white font-medium' : 'bg-surface border-black/[0.07] text-g4 hover:border-black/[0.13] hover:text-g2'}`}>
            {f}
          </button>
        ))}
        <div className="w-px h-5 bg-black/[0.07] mx-1 self-center" />
        {goalFilters.map((f) => (
          <button key={f} className="flex items-center gap-[5px] px-3 py-[5px] rounded-lg text-[0.74rem] bg-surface border border-black/[0.07] text-g4 hover:border-black/[0.13] hover:text-g2 cursor-pointer transition-all">
            {f}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_300px] gap-6">
        {/* Results */}
        <div>
          <div className="flex justify-between items-center mb-[10px]">
            <div className="text-[0.74rem] text-g5">Showing <strong className="text-g2 font-semibold">{seedResults.length}</strong> results for "{query}"</div>
            <button className="flex items-center gap-1 text-[0.72rem] text-g5 bg-transparent border-none cursor-pointer hover:text-g2">Relevance</button>
          </div>
          <div className="flex flex-col">
            {seedResults.map((r, i) => (
              <div key={i} className="grid grid-cols-[32px_1fr_120px_90px_60px] items-center gap-4 py-[14px] px-[10px] border-t border-black/[0.07] cursor-pointer hover:bg-g9 hover:-mx-[10px] hover:px-5 hover:rounded-lg transition-all">
                <div className={`w-7 h-7 rounded-[6px] grid place-items-center text-[0.58rem] font-bold uppercase text-white ${srcColors[r.src]}`}>{r.srcLabel}</div>
                <div className="min-w-0">
                  <div className="text-[0.84rem] text-g2 leading-[1.4] truncate hover:text-black transition-colors">{r.title}</div>
                  <div className="flex items-center gap-2 mt-[3px]">
                    <span className="text-[0.68rem] text-g5">{r.origin}</span>
                    <span className="text-[0.6rem] font-semibold px-[6px] py-px rounded-[3px] bg-g9 text-g3">{r.goal}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 text-[0.72rem] text-g5">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-g6"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
                  {r.links} linked
                </div>
                <div className="text-[0.72rem] text-g5 tabular-nums text-right">{r.date}</div>
                <div className="text-right"><StatusDot status={r.status} /></div>
              </div>
            ))}
          </div>
        </div>

        {/* Sidebar */}
        <div className="bg-surface border border-black/[0.07] rounded-card p-[22px] h-fit sticky top-[72px]">
          <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-4">Connection Map</div>
          <div className="w-full h-[220px] bg-g9 rounded-[10px] mb-[18px] relative overflow-hidden">
            <div className="absolute w-[14px] h-[14px] rounded-full bg-g1 top-10 left-[130px]" />
            <div className="absolute w-[10px] h-[10px] rounded-full bg-g3 top-[90px] left-20" />
            <div className="absolute w-[10px] h-[10px] rounded-full bg-g3 top-[70px] left-[190px]" />
            <div className="absolute w-[12px] h-[12px] rounded-full bg-accent-green top-[55px] left-[100px]" />
            <div className="absolute w-[7px] h-[7px] rounded-full bg-accent-red top-[170px] left-[200px]" />
            <div className="absolute w-[8px] h-[8px] rounded-full bg-g5 top-[140px] left-[60px]" />
            <div className="absolute h-px w-[55px] bg-g7 top-[47px] left-[113px] rotate-[50deg] origin-left" />
            <div className="absolute h-px w-[65px] bg-g7 top-[46px] left-[134px] rotate-[25deg] origin-left" />
            <div className="absolute h-px w-[60px] bg-g7 top-[95px] left-[84px] rotate-[50deg] origin-left" />
          </div>
          <div className="flex flex-col gap-3">
            {[
              ['Items in view', '23'],
              ['Cross-references', '33'],
              ['Sources touched', '5 / 5'],
            ].map(([label, val]) => (
              <div key={label} className="flex justify-between items-center">
                <span className="text-[0.74rem] text-g5">{label}</span>
                <span className="text-[0.78rem] font-semibold text-g2 tabular-nums">{val}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-black/[0.07]">
            <div className="flex gap-[2px] h-1 rounded-sm overflow-hidden bg-g8 mb-[5px]">
              <div className="rounded-sm bg-accent-green" style={{ width: '35%' }} />
              <div className="rounded-sm bg-black" style={{ width: '40%' }} />
              <div className="rounded-sm bg-accent-red" style={{ width: '10%' }} />
              <div className="rounded-sm bg-g6" style={{ width: '15%' }} />
            </div>
            <div className="flex justify-between">
              <span className="text-[0.62rem] font-medium text-accent-green">8 done</span>
              <span className="text-[0.62rem] font-medium text-black">9 active</span>
              <span className="text-[0.62rem] font-medium text-accent-red">2 stale</span>
              <span className="text-[0.62rem] font-medium text-g5">4 open</span>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-black/[0.07]">
            <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[10px]">Top Clusters</div>
            {[
              ['Agent orchestration', 8],
              ['Pipeline latency', 5],
              ['Cost optimization', 4],
              ['Model selection', 3],
              ['Feature flags', 3],
            ].map(([name, count]) => (
              <div key={name as string} className="flex justify-between items-center py-[6px]">
                <span className="text-[0.74rem] text-g4">{name}</span>
                <span className="text-[0.67rem] font-semibold text-g3 tabular-nums">{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
