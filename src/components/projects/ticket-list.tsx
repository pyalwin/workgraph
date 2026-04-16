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
                <div className="flex flex-wrap gap-[6px] mt-[6px] ml-[2px]">
                  {t.linked_prs.map(pr => (
                    <div key={pr.source_id} className="flex items-center gap-[5px] text-[0.68rem] text-g5 bg-[#fafafa] border border-black/[0.05] px-[8px] py-[2px] rounded">
                      <span className="font-medium text-g3">GH</span>
                      {pr.url ? (
                        <a href={pr.url} target="_blank" rel="noopener noreferrer" className="text-g5 hover:text-g3 no-underline hover:underline">
                          {pr.source_id.split('/').pop()}
                        </a>
                      ) : (
                        <span>{pr.source_id.split('/').pop()}</span>
                      )}
                      <span className="text-g6">
                        {pr.updated_at ? formatDate(pr.updated_at) : ''}
                      </span>
                    </div>
                  ))}
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
