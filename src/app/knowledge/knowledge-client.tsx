'use client';
import { useState, useMemo, useCallback } from 'react';
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

interface LinkedItem {
  link_id: string;
  link_type: string;
  confidence: number;
  linked_item_id: string;
  title: string;
  body: string | null;
  source: string;
  source_id: string;
  item_type: string;
  author: string | null;
  status: string | null;
  url: string | null;
  created_at: string;
}

interface VersionEntry {
  id: string;
  item_id: string;
  changed_fields: string;
  snapshot: string;
  changed_at: string;
}

interface ItemDetail {
  item: {
    id: string;
    source: string;
    source_id: string;
    item_type: string;
    title: string;
    body: string | null;
    author: string | null;
    status: string | null;
    priority: string | null;
    url: string | null;
    metadata: string | null;
    created_at: string;
    updated_at: string | null;
  };
  versions: VersionEntry[];
  linkedItems: LinkedItem[];
  goals: { name: string }[];
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

const linkTypeMeta: Record<string, { label: string; color: string }> = {
  references: { label: 'references', color: 'bg-accent-green-soft text-accent-green' },
  discusses:  { label: 'discusses', color: 'bg-[rgba(59,130,246,0.08)] text-[#3b82f6]' },
  mentions:   { label: 'mentions', color: 'bg-g9 text-g4' },
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

function formatTrailDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function truncateBody(text: string | null, maxLen = 180): string {
  if (!text) return '';
  const clean = text.replace(/\n+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen).trim() + '...';
}

/* ---- Decision Trail Panel (expanded under a row) ---- */
function ItemDetailPanel({
  detail,
  loading,
}: {
  detail: ItemDetail | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="py-8 flex items-center justify-center gap-2">
        <div className="w-[14px] h-[14px] rounded-full border-2 border-g7 border-t-g3 animate-spin" />
        <span className="text-[0.78rem] text-g5">Loading context trail...</span>
      </div>
    );
  }

  if (!detail) return null;

  const { item, versions, linkedItems, goals } = detail;

  // Build a chronological "decision trail" combining linked items + versions
  const trailEntries: {
    date: string;
    source: string;
    label: string;
    title: string;
    linkType?: string;
    url?: string | null;
    type: 'linked' | 'version';
  }[] = [];

  for (const li of linkedItems) {
    trailEntries.push({
      date: li.created_at,
      source: li.source,
      label: (srcMeta[li.source]?.label || li.source.substring(0, 3).toUpperCase()),
      title: li.title,
      linkType: li.link_type,
      url: li.url,
      type: 'linked',
    });
  }

  for (const v of versions) {
    let changedFields: string[] = [];
    try { changedFields = JSON.parse(v.changed_fields); } catch { /* ignore */ }
    trailEntries.push({
      date: v.changed_at,
      source: item.source,
      label: 'VER',
      title: `Fields updated: ${changedFields.join(', ') || 'snapshot'}`,
      type: 'version',
    });
  }

  // Sort chronologically
  trailEntries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return (
    <div className="bg-g9 rounded-[10px] mx-[10px] mb-[6px] overflow-hidden">
      {/* Item details header */}
      <div className="px-5 pt-5 pb-4 border-b border-black/[0.05]">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            {item.body && (
              <p className="text-[0.78rem] text-g3 leading-[1.55] mb-3">{truncateBody(item.body, 300)}</p>
            )}
            <div className="flex items-center gap-[10px] flex-wrap">
              {item.author && (
                <span className="text-[0.68rem] text-g5">
                  <span className="text-g4 font-medium">{item.author}</span>
                </span>
              )}
              {item.url && (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[0.68rem] text-g5 underline underline-offset-2 hover:text-g2 transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  Open source
                </a>
              )}
              {item.priority && (
                <span className="text-[0.6rem] font-semibold px-[6px] py-px rounded-[3px] bg-white text-g4 border border-black/[0.07]">
                  {item.priority}
                </span>
              )}
              {item.status && (
                <span className="flex items-center gap-1 text-[0.68rem] text-g5">
                  <StatusDot status={item.status} />
                  {item.status.replace('_', ' ')}
                </span>
              )}
              {goals.map((g) => (
                <span key={g.name} className="text-[0.6rem] font-semibold px-[6px] py-px rounded-[3px] bg-white text-g3 border border-black/[0.07]">
                  {g.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Decision Trail */}
      {trailEntries.length > 0 && (
        <div className="px-5 pt-4 pb-5">
          <div className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-g5 mb-3">Decision Trail</div>
          <div className="relative pl-5">
            {/* Vertical line */}
            <div className="absolute left-[7px] top-[6px] bottom-[6px] w-px bg-black/[0.1]" />

            {trailEntries.map((entry, i) => {
              const meta = srcMeta[entry.source] || { label: entry.label, color: 'bg-g5' };
              const ltMeta = entry.linkType ? (linkTypeMeta[entry.linkType] || linkTypeMeta.mentions) : null;
              return (
                <div key={i} className="relative flex items-start gap-3 pb-[14px] last:pb-0">
                  {/* Dot on timeline */}
                  <div className={`absolute left-[-13px] top-[7px] w-[7px] h-[7px] rounded-full ${entry.type === 'version' ? 'bg-g6' : 'bg-g3'}`} />

                  {/* Source badge */}
                  <div className={`w-[30px] h-[18px] rounded-[4px] grid place-items-center text-[0.5rem] font-bold uppercase text-white shrink-0 ${entry.type === 'version' ? 'bg-g6' : meta.color}`}>
                    {entry.label}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[0.68rem] text-g5 tabular-nums shrink-0">{formatTrailDate(entry.date)}</span>
                      {ltMeta && (
                        <span className={`text-[0.56rem] font-semibold px-[5px] py-px rounded-[3px] ${ltMeta.color}`}>
                          {ltMeta.label}
                        </span>
                      )}
                    </div>
                    {entry.url ? (
                      <a
                        href={entry.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[0.78rem] text-g2 leading-[1.4] hover:text-black hover:underline underline-offset-2 transition-colors block mt-[2px] truncate"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {entry.title}
                      </a>
                    ) : (
                      <div className="text-[0.78rem] text-g2 leading-[1.4] mt-[2px] truncate">{entry.title}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {trailEntries.length === 0 && (
        <div className="px-5 py-5 text-[0.78rem] text-g5 text-center">
          No linked items or version history yet.
        </div>
      )}
    </div>
  );
}

export default function KnowledgeClient({ items, totalItems, totalLinks }: Props) {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All Sources');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, ItemDetail>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const handleRowClick = useCallback(async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }

    setExpandedId(id);

    if (detailCache[id]) return; // already fetched

    setLoadingId(id);
    try {
      const res = await fetch(`/api/items/${id}`);
      if (res.ok) {
        const data: ItemDetail = await res.json();
        setDetailCache((prev) => ({ ...prev, [id]: data }));
      }
    } catch {
      // silently fail — panel will show no trail
    } finally {
      setLoadingId(null);
    }
  }, [expandedId, detailCache]);

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
              const isExpanded = expandedId === r.id;
              return (
                <div key={r.id}>
                  <div
                    onClick={() => handleRowClick(r.id)}
                    className={`grid grid-cols-[32px_1fr_120px_90px_60px] items-center gap-4 py-[14px] px-[10px] border-t border-black/[0.07] cursor-pointer hover:bg-g9 hover:-mx-[10px] hover:px-5 hover:rounded-lg transition-all ${isExpanded ? 'bg-g9 -mx-[10px] px-5 rounded-t-lg border-t-transparent' : ''}`}
                  >
                    <div className={`w-7 h-7 rounded-[6px] grid place-items-center text-[0.58rem] font-bold uppercase text-white ${meta.color}`}>{meta.label}</div>
                    <div className="min-w-0">
                      <div className={`text-[0.84rem] leading-[1.4] truncate transition-colors ${isExpanded ? 'text-black font-medium' : 'text-g2 hover:text-black'}`}>{r.title}</div>
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
                    <div className="flex items-center justify-end gap-1">
                      <StatusDot status={r.status || 'open'} />
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className={`text-g6 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>
                  </div>
                  {/* Expanded detail panel */}
                  {isExpanded && (
                    <ItemDetailPanel
                      detail={detailCache[r.id] || null}
                      loading={loadingId === r.id}
                    />
                  )}
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
