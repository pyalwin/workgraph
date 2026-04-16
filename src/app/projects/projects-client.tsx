'use client';

import { useState, useCallback } from 'react';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/* ── types ─────────────────────────────────────────────── */

export interface RecentItemRow {
  id: string;
  title: string;
  source: string;
  status: string;
  source_id: string;
  created_at: string;
  updated_at: string | null;
  body: string | null;
  author: string | null;
  url: string | null;
  metadata: string | null;
  link_count: number;
  version_count: number;
}

export interface GoalWithItems {
  id: string;
  name: string;
  description: string;
  keywords: string;
  item_count: number;
  done_count: number;
  active_count: number;
  source_count: number;
  recentItems: RecentItemRow[];
}

interface VersionRow {
  id: string;
  changed_fields: string;
  changed_at: string;
}

interface LinkedItemRow {
  link_id: string;
  link_type: string;
  linked_item_id: string;
  title: string;
  source: string;
  source_id: string;
  status: string | null;
}

interface ItemDetails {
  item: Record<string, unknown>;
  versions: VersionRow[];
  linkedItems: LinkedItemRow[];
}

/* ── constants ─────────────────────────────────────────── */

const SOURCE_BADGE: Record<string, { label: string; color: string }> = {
  jira:    { label: 'JRA', color: 'bg-[#111] text-white' },
  slack:   { label: 'SLK', color: 'bg-[#555] text-white' },
  granola: { label: 'MTG', color: 'bg-[#777] text-white' },
  meeting: { label: 'MTG', color: 'bg-[#777] text-white' },
  notion:  { label: 'NOT', color: 'bg-[#999] text-white' },
  gmail:   { label: 'GML', color: 'bg-[#bbb] text-white' },
};

/* ── helpers ───────────────────────────────────────────── */

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function formatFullDate(dateStr: string): string {
  const d = new Date(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatStatus(status: string | null): string {
  if (!status) return '';
  return status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function getBadge(source: string) {
  return SOURCE_BADGE[source] || { label: source.slice(0, 3).toUpperCase(), color: 'bg-[#ddd] text-[#555]' };
}

/* ── expanded detail panel ─────────────────────────────── */

function ItemDetailPanel({
  item,
  details,
  loading,
}: {
  item: RecentItemRow;
  details: ItemDetails | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="px-4 py-5 text-[0.78rem] text-[#999] animate-pulse">
        Loading details...
      </div>
    );
  }

  // Parse metadata
  let meta: Record<string, unknown> = {};
  try {
    if (item.metadata) meta = JSON.parse(item.metadata);
  } catch { /* ignore */ }

  const metaLabels = Array.isArray(meta.labels) ? meta.labels as string[] : [];
  const metaComponents = Array.isArray(meta.components) ? meta.components as string[] : [];
  const metaParticipants = Array.isArray(meta.participants) ? meta.participants as string[] : [];
  const metaSprint = typeof meta.sprint === 'string' ? meta.sprint : null;
  const metaProject = typeof meta.project === 'string' ? meta.project : null;

  return (
    <div className="bg-[#fafafa] border-t border-black/[0.05] px-5 py-4 space-y-4">
      {/* Body / description */}
      {item.body && (
        <div>
          <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-1">Description</div>
          <div className="text-[0.78rem] text-[#555] leading-[1.6] whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
            {item.body}
          </div>
        </div>
      )}

      {/* Author + source link */}
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {item.author && (
          <div>
            <span className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999] mr-1">Author</span>
            <span className="text-[0.78rem] text-[#555]">{item.author}</span>
          </div>
        )}
        {item.url && (
          <div>
            <span className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999] mr-1">Source</span>
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[0.78rem] text-[#2563eb] hover:underline"
            >
              Open in {item.source}
            </a>
          </div>
        )}
      </div>

      {/* Status + timestamps */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-[0.78rem]">
        {item.status && (
          <div>
            <span className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999] mr-1">Status</span>
            <Badge
              variant="secondary"
              className={cn(
                "text-[0.63rem]",
                (item.status === 'done' || item.status === 'closed' || item.status === 'resolved')
                  ? 'bg-[rgba(26,135,84,0.08)] text-[#1a8754]' : ''
              )}
            >
              {formatStatus(item.status)}
            </Badge>
          </div>
        )}
        <div>
          <span className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999] mr-1">Created</span>
          <span className="text-[#777]">{formatFullDate(item.created_at)}</span>
        </div>
        {item.updated_at && (
          <div>
            <span className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999] mr-1">Updated</span>
            <span className="text-[#777]">{formatFullDate(item.updated_at)}</span>
          </div>
        )}
      </div>

      {/* Metadata badges */}
      {(metaLabels.length > 0 || metaComponents.length > 0 || metaParticipants.length > 0 || metaSprint || metaProject) && (
        <div className="flex flex-wrap gap-2">
          {metaProject && (
            <Badge variant="outline" className="text-[0.63rem]">
              Project: {metaProject}
            </Badge>
          )}
          {metaSprint && (
            <Badge variant="outline" className="text-[0.63rem]">
              Sprint: {metaSprint}
            </Badge>
          )}
          {metaLabels.map((l) => (
            <Badge key={l} variant="secondary" className="text-[0.63rem]">
              {l}
            </Badge>
          ))}
          {metaComponents.map((c) => (
            <Badge key={c} variant="secondary" className="text-[0.63rem]">
              {c}
            </Badge>
          ))}
          {metaParticipants.map((p) => (
            <Badge key={p} variant="outline" className="text-[0.63rem]">
              {p}
            </Badge>
          ))}
        </div>
      )}

      {/* Version history */}
      {details && details.versions.length > 0 && (
        <div>
          <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-2">
            Version History ({details.versions.length})
          </div>
          <div className="space-y-1">
            {details.versions.map((v) => {
              let changes: Record<string, { old: string | null; new: string | null }> = {};
              try { changes = JSON.parse(v.changed_fields); } catch { /* ignore */ }
              return (
                <div key={v.id} className="text-[0.73rem] text-[#777] flex flex-wrap gap-x-1">
                  {Object.entries(changes).map(([field, { old: oldVal, new: newVal }]) => (
                    <span key={field}>
                      <span className="font-medium text-[#555]">{field}:</span>{' '}
                      <span className="text-[#aaa]">{oldVal || '(empty)'}</span>
                      <span className="mx-[2px]">&rarr;</span>
                      <span>{newVal || '(empty)'}</span>
                    </span>
                  ))}
                  <span className="text-[#bbb] ml-1">on {formatDate(v.changed_at)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Cross-references */}
      {details && details.linkedItems.length > 0 && (
        <div>
          <div className="text-[0.67rem] font-semibold uppercase tracking-[0.07em] text-[#999] mb-2">
            Cross-references ({details.linkedItems.length})
          </div>
          <div className="space-y-1">
            {details.linkedItems.map((li) => {
              const lBadge = getBadge(li.source);
              return (
                <div key={li.link_id} className="flex items-center gap-2 text-[0.73rem]">
                  <Badge variant="source" className={cn("text-[0.55rem] py-[1px] px-[4px]", lBadge.color)}>
                    {lBadge.label}
                  </Badge>
                  <span className="text-[#777] truncate">{li.title}</span>
                  {li.status && (
                    <Badge
                      variant="secondary"
                      className={cn(
                        "text-[0.58rem]",
                        (li.status === 'done' || li.status === 'closed' || li.status === 'resolved')
                          ? 'bg-[rgba(26,135,84,0.08)] text-[#1a8754]' : ''
                      )}
                    >
                      {formatStatus(li.status)}
                    </Badge>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* No extra details available */}
      {details && details.versions.length === 0 && details.linkedItems.length === 0 && !item.body && !item.author && (
        <div className="text-[0.78rem] text-[#bbb]">No additional details available for this item.</div>
      )}
    </div>
  );
}

/* ── main client component ─────────────────────────────── */

export default function ProjectsClient({
  goals,
  hasData,
}: {
  goals: GoalWithItems[];
  hasData: boolean;
}) {
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [detailsCache, setDetailsCache] = useState<Record<string, ItemDetails>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const toggleItem = useCallback(async (itemId: string) => {
    if (expandedItem === itemId) {
      setExpandedItem(null);
      return;
    }
    setExpandedItem(itemId);

    // Lazy-load full details if not cached
    if (!detailsCache[itemId]) {
      setLoadingId(itemId);
      try {
        const res = await fetch(`/api/items/${itemId}`);
        if (res.ok) {
          const data = await res.json();
          setDetailsCache(prev => ({ ...prev, [itemId]: data }));
        }
      } catch {
        /* silently fail — inline data still shown */
      } finally {
        setLoadingId(null);
      }
    }
  }, [expandedItem, detailsCache]);

  return (
    <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
      <div className="mb-8">
        <h1 className="text-[1.5rem] font-bold tracking-tight text-black mb-[2px]">Projects</h1>
        <p className="text-[0.82rem] text-[#999]">
          {hasData
            ? `Work items grouped across ${goals.length} strategic pillars`
            : 'All projects across your strategic pillars'}
        </p>
      </div>

      {!hasData && (
        <div className="mt-8 p-8 bg-white border border-black/[0.07] rounded-[14px] text-center text-[#999] text-[0.87rem]">
          No project data yet. Run a sync from Settings to populate work items.
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

                <div className="text-[0.72rem] text-[#999] mb-[10px]">
                  {total} items &middot; {done} done &middot; {active} active &middot; from {goal.source_count} source{goal.source_count !== 1 ? 's' : ''}
                </div>

                <div className="flex h-[5px] rounded-[3px] overflow-hidden bg-[#f0f0f0] mb-[18px]">
                  {total > 0 && (
                    <div className="bg-[#111] rounded-[3px] transition-all" style={{ width: `${pct}%` }} />
                  )}
                </div>

                {goal.recentItems.length > 0 && (
                  <div>
                    <CardTitle className="mb-[12px]">Recent Items</CardTitle>
                    <div className="flex flex-col">
                      {goal.recentItems.map((item, i) => {
                        const badge = getBadge(item.source);
                        const isExpanded = expandedItem === item.id;

                        return (
                          <div key={`${item.source}-${item.source_id}-${i}`}>
                            <div
                              role="button"
                              tabIndex={0}
                              onClick={() => toggleItem(item.id)}
                              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleItem(item.id); } }}
                              className={cn(
                                "grid grid-cols-[42px_1fr_auto_auto_20px] items-center gap-3 py-[9px] cursor-pointer transition-colors hover:bg-[#fafafa] rounded-[4px] px-1 -mx-1",
                                i > 0 && !isExpanded && "border-t border-black/[0.07]",
                                isExpanded && "bg-[#fafafa]"
                              )}
                            >
                              <Badge variant="source" className={cn("text-[0.6rem] justify-center py-[2px] px-[5px]", badge.color)}>
                                {badge.label}
                              </Badge>
                              <div className="text-[0.78rem] text-[#777] truncate">{item.title}</div>
                              {item.status && (
                                <Badge variant="secondary" className={cn(
                                  "text-[0.63rem] whitespace-nowrap",
                                  item.status === 'done' || item.status === 'closed' || item.status === 'resolved'
                                    ? 'bg-[rgba(26,135,84,0.08)] text-[#1a8754]' : ''
                                )}>
                                  {formatStatus(item.status)}
                                </Badge>
                              )}
                              <span className="text-[0.68rem] text-[#bbb] tabular-nums whitespace-nowrap">
                                {formatDate(item.created_at)}
                              </span>
                              {/* expand/collapse chevron */}
                              <svg
                                className={cn(
                                  "w-3.5 h-3.5 text-[#bbb] transition-transform duration-150",
                                  isExpanded && "rotate-180"
                                )}
                                viewBox="0 0 20 20"
                                fill="currentColor"
                              >
                                <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                              </svg>
                            </div>

                            {/* expanded detail panel */}
                            {isExpanded && (
                              <ItemDetailPanel
                                item={item}
                                details={detailsCache[item.id] || null}
                                loading={loadingId === item.id}
                              />
                            )}
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
