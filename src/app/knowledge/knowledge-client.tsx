'use client';
import { useState, useMemo } from 'react';
import { StatusDot } from '@/components/status-dot';

export interface KnowledgeItem {
  id: string;
  source: string;
  source_id: string;
  item_type: string;
  title: string;
  body: string | null;
  author: string | null;
  status: string | null;
  created_at: string;
  url: string | null;
  goal_names: string | null;
  link_count: number;
}

interface Props {
  items: KnowledgeItem[];
  totalItems: number;
  totalLinks: number;
}

const srcMeta: Record<string, { label: string; color: string }> = {
  jira:    { label: 'JRA', color: 'bg-g1' },
  slack:   { label: 'SLK', color: 'bg-g3' },
  meeting: { label: 'MTG', color: 'bg-g5' },
  notion:  { label: 'NOT', color: 'bg-g6' },
  gmail:   { label: 'GML', color: 'bg-g7 !text-g3' },
};

const sourceFilters = ['All Sources', 'Jira', 'Slack', 'Meetings', 'Notion', 'Gmail'];
const sourceFilterMap: Record<string, string> = {
  Jira: 'jira',
  Slack: 'slack',
  Meetings: 'meeting',
  Notion: 'notion',
  Gmail: 'gmail',
};

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function KnowledgeClient({ items, totalItems, totalLinks }: Props) {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All Sources');

  const goalFilters = useMemo(() => {
    const goals = new Set<string>();
    for (const item of items) {
      if (item.goal_names) {
        for (const g of item.goal_names.split(',')) {
          goals.add(g.trim());
        }
      }
    }
    return Array.from(goals).sort();
  }, [items]);

  const filtered = useMemo(() => {
    let result = items;

    if (activeFilter !== 'All Sources') {
      const srcKey = sourceFilterMap[activeFilter];
      if (srcKey) result = result.filter((r) => r.source === srcKey);
    }

    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter((r) => r.title.toLowerCase().includes(q));
    }

    return result;
  }, [items, query, activeFilter]);

  const distinctSources = useMemo(() => {
    const sources = new Set<string>();
    for (const item of filtered) sources.add(item.source);
    return sources.size;
  }, [filtered]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { done: 0, active: 0, stale: 0, open: 0 };
    for (const item of filtered) {
      const s = item.status || 'open';
      const normalized = s === 'in_progress' ? 'active' : s;
      if (normalized in counts) counts[normalized]++;
      else counts.open++;
    }
    return counts;
  }, [filtered]);

  const total = statusCounts.done + statusCounts.active + statusCounts.stale + statusCounts.open;
  const pct = (n: number) => total > 0 ? `${(n / total * 100).toFixed(0)}%` : '0%';

  return (
    <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
      <div className="mb-7">
        <h1 className="text-[1.5rem] font-bold tracking-tight text-black mb-[2px]">Knowledge Base</h1>
        <p className="text-[0.82rem] text-g5">{totalItems.toLocaleString()} items across {Object.keys(srcMeta).length} sources &middot; {totalLinks.toLocaleString()} cross-references</p>
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
        <div className="text-[0.67rem] font-semibold text-white bg-black px-[7px] py-[2px] rounded-[10px]">{filtered.length}</div>
      </div>

      {/* Filters */}
      <div className="flex gap-[6px] mb-6 flex-wrap">
        {sourceFilters.map((f) => (
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
            <div className="text-[0.74rem] text-g5">Showing <strong className="text-g2 font-semibold">{filtered.length}</strong> results{query ? <> for &ldquo;{query}&rdquo;</> : null}</div>
            <button className="flex items-center gap-1 text-[0.72rem] text-g5 bg-transparent border-none cursor-pointer hover:text-g2">Relevance</button>
          </div>
          <div className="flex flex-col">
            {filtered.map((r) => {
              const meta = srcMeta[r.source] || { label: r.source.substring(0, 3).toUpperCase(), color: 'bg-g5' };
              const goals = r.goal_names ? r.goal_names.split(',').map((g) => g.trim()) : [];
              return (
                <div key={r.id} className="grid grid-cols-[32px_1fr_120px_90px_60px] items-center gap-4 py-[14px] px-[10px] border-t border-black/[0.07] cursor-pointer hover:bg-g9 hover:-mx-[10px] hover:px-5 hover:rounded-lg transition-all">
                  <div className={`w-7 h-7 rounded-[6px] grid place-items-center text-[0.58rem] font-bold uppercase text-white ${meta.color}`}>{meta.label}</div>
                  <div className="min-w-0">
                    <div className="text-[0.84rem] text-g2 leading-[1.4] truncate hover:text-black transition-colors">{r.title}</div>
                    <div className="flex items-center gap-2 mt-[3px]">
                      <span className="text-[0.68rem] text-g5">{r.source_id}</span>
                      {goals.map((g) => (
                        <span key={g} className="text-[0.6rem] font-semibold px-[6px] py-px rounded-[3px] bg-g9 text-g3">{g}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-[0.72rem] text-g5">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-g6"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
                    {r.link_count} linked
                  </div>
                  <div className="text-[0.72rem] text-g5 tabular-nums text-right">{formatDate(r.created_at)}</div>
                  <div className="text-right"><StatusDot status={r.status || 'open'} /></div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="py-16 text-center text-[0.84rem] text-g5">No items match your search.</div>
            )}
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
              ['Items in view', filtered.length.toString()],
              ['Cross-references', totalLinks.toString()],
              ['Sources touched', `${distinctSources} / ${Object.keys(srcMeta).length}`],
            ].map(([label, val]) => (
              <div key={label} className="flex justify-between items-center">
                <span className="text-[0.74rem] text-g5">{label}</span>
                <span className="text-[0.78rem] font-semibold text-g2 tabular-nums">{val}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-black/[0.07]">
            <div className="flex gap-[2px] h-1 rounded-sm overflow-hidden bg-g8 mb-[5px]">
              <div className="rounded-sm bg-accent-green" style={{ width: pct(statusCounts.done) }} />
              <div className="rounded-sm bg-black" style={{ width: pct(statusCounts.active) }} />
              <div className="rounded-sm bg-accent-red" style={{ width: pct(statusCounts.stale) }} />
              <div className="rounded-sm bg-g6" style={{ width: pct(statusCounts.open) }} />
            </div>
            <div className="flex justify-between">
              <span className="text-[0.62rem] font-medium text-accent-green">{statusCounts.done} done</span>
              <span className="text-[0.62rem] font-medium text-black">{statusCounts.active} active</span>
              <span className="text-[0.62rem] font-medium text-accent-red">{statusCounts.stale} stale</span>
              <span className="text-[0.62rem] font-medium text-g5">{statusCounts.open} open</span>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-black/[0.07]">
            <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-[10px]">Top Clusters</div>
            {goalFilters.slice(0, 5).map((name) => {
              const count = filtered.filter((r) => r.goal_names?.includes(name)).length;
              return (
                <div key={name} className="flex justify-between items-center py-[6px]">
                  <span className="text-[0.74rem] text-g4">{name}</span>
                  <span className="text-[0.67rem] font-semibold text-g3 tabular-nums">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
