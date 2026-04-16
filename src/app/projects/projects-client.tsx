'use client';

import { useState, useEffect } from 'react';
import { PeriodSelector } from '@/components/otti/period-selector';
import { ProjectCard } from '@/components/projects/project-card';
import type { ProjectSummaryCard } from '@/lib/project-queries';

const PERIODS = ['30d', '90d', 'all'];

export function ProjectsIndexClient({ initialCards }: { initialCards: ProjectSummaryCard[] }) {
  const [period, setPeriod] = useState('30d');
  const [cards, setCards] = useState(initialCards);

  useEffect(() => {
    // Refetch when period changes (initial render uses server data)
    if (period === '30d') {
      setCards(initialCards);
      return;
    }
    fetch(`/api/projects/index?period=${period}`)
      .then(r => r.json())
      .then(setCards)
      .catch(() => {});
  }, [period, initialCards]);

  const totalTickets = cards.reduce((s, c) => s + c.completion_total, 0);
  const totalPRs = cards.reduce((s, c) => s + c.pr_count, 0);

  return (
    <div className="max-w-[1180px] mx-auto px-10 pt-8 pb-20">
      <div className="flex items-start justify-between mb-7">
        <div>
          <h1 className="text-[1.5rem] font-bold tracking-tight text-black mb-[2px]">Projects</h1>
          <p className="text-[0.82rem] text-g5">
            {cards.length} projects &middot; {totalTickets} tickets &middot; {totalPRs} PRs
          </p>
        </div>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      {cards.length === 0 ? (
        <div className="p-8 bg-white border border-black/[0.07] rounded-[14px] text-center text-g5 text-[0.87rem]">
          No project data yet. Run a sync from Settings to populate work items.
        </div>
      ) : (
        <div className="flex flex-col gap-[12px]">
          {cards.map(c => (
            <ProjectCard
              key={c.key}
              projectKey={c.key}
              name={c.name}
              healthStatus={c.health_status}
              summarySnippet={c.summary_snippet}
              completionPct={c.completion_pct}
              completionDone={c.completion_done}
              completionTotal={c.completion_total}
              velocity={c.velocity}
              velocityDeltaPct={c.velocity_delta_pct}
              openCount={c.open_count}
              staleCount={c.stale_count}
              prCount={c.pr_count}
            />
          ))}
        </div>
      )}
    </div>
  );
}
