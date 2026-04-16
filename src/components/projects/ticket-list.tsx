'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface LinkedPR {
  source_id: string;
  title: string;
  status: string;
  updated_at: string | null;
  repo: string;
  url: string | null;
}

interface Ticket {
  id: string;
  source_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string | null;
  url: string | null;
  linked_prs: LinkedPR[];
}

interface TicketListProps {
  tickets: Ticket[];
}

type Filter = 'recent' | 'active' | 'stale' | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'recent', label: 'Recently Completed' },
  { key: 'active', label: 'Active' },
  { key: 'stale', label: 'Stale' },
  { key: 'all', label: 'All' },
];

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function isDone(status: string): boolean {
  return ['done', 'closed', 'resolved'].includes(status);
}

function isStale(ticket: Ticket): boolean {
  const lastUpdate = new Date(ticket.updated_at || ticket.created_at);
  return !isDone(ticket.status) && (Date.now() - lastUpdate.getTime()) / 86400000 >= 14;
}

export function TicketList({ tickets }: TicketListProps) {
  const [filter, setFilter] = useState<Filter>('recent');

  const filtered = tickets.filter(t => {
    switch (filter) {
      case 'recent': return isDone(t.status);
      case 'active': return !isDone(t.status) && !isStale(t);
      case 'stale': return isStale(t);
      case 'all': return true;
    }
  });

  return (
    <div>
      {/* Filter pills */}
      <div className="flex gap-[6px] mb-4">
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              "px-[14px] py-[5px] rounded-lg text-[0.74rem] border cursor-pointer transition-all",
              filter === f.key
                ? "bg-black border-black text-white font-medium"
                : "bg-surface border-black/[0.07] text-g4 hover:border-black/[0.13]"
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-[0.8rem] text-g5 py-6 text-center">No tickets match this filter.</div>
      ) : (
        <div className="bg-surface border border-black/[0.07] rounded-card overflow-hidden">
          {filtered.map((t, i) => (
            <div key={t.id} className={cn("px-[18px] py-[14px]", i > 0 && "border-t border-black/[0.05]")}>
              {/* Ticket row */}
              <div className="flex items-center gap-[10px] mb-1">
                <span className="text-[0.68rem] font-semibold text-g5 bg-g9 px-[6px] py-[1px] rounded shrink-0">
                  {t.source_id}
                </span>
                <span className="text-[0.8rem] font-medium text-g2 truncate flex-1">
                  {t.url ? (
                    <a href={t.url} target="_blank" rel="noopener noreferrer" className="hover:underline text-g2 no-underline">
                      {t.title}
                    </a>
                  ) : t.title}
                </span>
                <Badge
                  variant="secondary"
                  className={cn(
                    "text-[0.6rem] shrink-0",
                    isDone(t.status) ? "bg-[rgba(26,135,84,0.08)] text-[#1a8754]" : ""
                  )}
                >
                  {t.status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                </Badge>
                <span className="text-[0.68rem] text-g6 tabular-nums shrink-0">
                  {formatDate(t.updated_at || t.created_at)}
                </span>
              </div>

              {/* Linked PRs */}
              {t.linked_prs.length > 0 ? (
                <div className="flex flex-wrap gap-[6px] mt-[8px] ml-[2px]">
                  {t.linked_prs.map(pr => {
                    const prNum = pr.source_id.split('/').pop() || pr.source_id;
                    const repo = pr.repo?.split('/').pop() || '';
                    const isMerged = pr.status === 'done' || pr.status === 'merged';
                    return (
                      <a
                        key={pr.source_id}
                        href={pr.url || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-[6px] text-[0.7rem] no-underline bg-[#111] text-white px-[10px] py-[4px] rounded-[6px] hover:bg-[#333] transition-colors"
                      >
                        <svg className="w-[14px] h-[14px] shrink-0" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"/>
                        </svg>
                        <span className="font-medium">{prNum}</span>
                        {repo && <span className="text-[0.62rem] text-white/60">{repo}</span>}
                        {isMerged && (
                          <span className="text-[0.58rem] bg-white/20 px-[5px] py-[0.5px] rounded">merged</span>
                        )}
                        {pr.updated_at && (
                          <span className="text-[0.6rem] text-white/50">{formatDate(pr.updated_at)}</span>
                        )}
                      </a>
                    );
                  })}
                </div>
              ) : (
                <div className="text-[0.66rem] text-g6 mt-[4px] ml-[2px] italic">No linked PRs</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
