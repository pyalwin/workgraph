'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import type { ProjectDetail } from '@/lib/project-queries';
import { Markdown } from '@/components/prompt-kit/markdown';
import { ItemDetailDrawer } from '@/components/item-detail-drawer';

const STATUS_LABEL: Record<string, string> = {
  healthy: 'On track',
  needs_attention: 'Watch',
  at_risk: 'At risk',
};
const STATUS_CLASS: Record<string, string> = {
  healthy: 'status-on-track',
  needs_attention: 'status-at-risk',
  at_risk: 'status-at-risk',
};

export function ProjectDetailClient({ projectKey }: { projectKey: string }) {
  const [period, setPeriod] = useState('30d');
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [openItemId, setOpenItemId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/projects/${projectKey}?period=${period}`);
    const json = await res.json();
    setData(json);
    setLoading(false);
  }, [projectKey, period]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/projects/${projectKey}/refresh-summary`, { method: 'POST' });
      const { summary } = await res.json();
      setData((prev) => (prev ? { ...prev, health: { ...prev.health, summary } } : prev));
    } catch {
      // ignore
    }
    setRefreshing(false);
  };

  if (loading && !data) {
    return (
      <div className="detail-page">
        <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>Loading…</div>
      </div>
    );
  }
  if (!data) return null;

  const d = data;
  const s = d.health.signals;
  const maxWeekly = Math.max(...d.velocity_weekly.map((w) => w.closed), 1);
  const statusKey = d.health.status;

  return (
    <div className="detail-page">
      <Link href="/projects" className="detail-back">
        <span className="arrow">←</span> Back to projects
      </Link>

      <header className="detail-head">
        <div className="detail-head-top">
          <div className="detail-head-identity">
            <div className="detail-head-meta">
              <span className={`status-chip ${STATUS_CLASS[statusKey] ?? 'status-stalled'}`}>
                {STATUS_LABEL[statusKey] ?? 'Unknown'}
              </span>
              <span className="sep">·</span>
              <span style={{ fontFamily: 'var(--mono)' }}>{d.project.key}</span>
              <span className="sep">·</span>
              <span>
                {d.project.total_tickets} tickets · {d.project.total_prs} linked PRs
              </span>
            </div>
            <h1 className="detail-head-title">{d.project.name}</h1>
          </div>
          <div className="detail-head-actions">
            <button className="btn btn-primary" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? 'Refreshing…' : 'Refresh summary'}
            </button>
            <PeriodPill value={period} onChange={setPeriod} />
          </div>
        </div>
        {d.health.summary ? (
          <div className="detail-head-desc">
            <Markdown>{d.health.summary}</Markdown>
          </div>
        ) : (
          <p className="detail-head-desc">
            No AI summary yet — refresh to generate one from the latest signals.
          </p>
        )}
      </header>

      <div className="detail-body">
        <div className="detail-main">
          <section className="detail-section">
            <h4>Status snapshot</h4>
            <div className="proj-detail-grid">
              <div className="pd-cell">
                <div className="eyebrow">Completion</div>
                <div className="pd-v">
                  {Math.round(s.completion_pct)}% — {s.completion_done}/{s.completion_total}
                </div>
              </div>
              <div className="pd-cell">
                <div className="eyebrow">Velocity</div>
                <div className="pd-v">
                  {s.velocity} /wk
                  <span
                    style={{
                      marginLeft: 6,
                      color: s.velocity_delta_pct >= 0 ? 'var(--green)' : 'var(--red)',
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                    }}
                  >
                    {s.velocity_delta_pct >= 0 ? '+' : ''}
                    {s.velocity_delta_pct}%
                  </span>
                </div>
              </div>
              <div className="pd-cell">
                <div className="eyebrow">Cycle time</div>
                <div className="pd-v">{s.cycle_time_days}d</div>
                <div className="pd-sub">
                  was {s.cycle_time_prior_days}d ({s.cycle_time_delta_pct >= 0 ? '+' : ''}
                  {s.cycle_time_delta_pct}%)
                </div>
              </div>
              <div className="pd-cell">
                <div className="eyebrow">PR cadence</div>
                <div className="pd-v">{s.pr_cadence_per_week}/wk</div>
              </div>
              <div className="pd-cell">
                <div className="eyebrow">Stale items</div>
                <div className="pd-v">{s.stale_count}</div>
                {s.stale_pct > 0 && (
                  <div className={`pd-sub ${s.stale_pct > 30 ? 'bad' : ''}`}>
                    {Math.round(s.stale_pct)}% of open
                  </div>
                )}
              </div>
              <div className="pd-cell">
                <div className="eyebrow">Contributors</div>
                <div className="pd-v">{d.code_activity.contributor_count}</div>
                <div className="pd-sub">{d.code_activity.repo_count} repos</div>
              </div>
            </div>
          </section>

          {d.velocity_weekly.length > 0 && (
            <section className="detail-section">
              <h4>
                Tickets closed / week <span className="count">· {d.velocity_weekly.length} weeks</span>
              </h4>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-end',
                  gap: 6,
                  height: 120,
                  padding: 12,
                  background: 'var(--bg)',
                  border: '1px solid var(--rule)',
                  borderRadius: 8,
                }}
              >
                {d.velocity_weekly.map((w, i) => {
                  const h = Math.max(Math.round((w.closed / maxWeekly) * 100), w.closed > 0 ? 6 : 2);
                  const isLast = i === d.velocity_weekly.length - 1;
                  return (
                    <div
                      key={w.week}
                      style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: 4,
                        height: 110,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontFamily: 'var(--mono)',
                          color: 'var(--ink-4)',
                        }}
                      >
                        {w.closed}
                      </div>
                      <div
                        style={{
                          width: '100%',
                          height: h,
                          background: w.closed === 0 ? 'var(--rule-2)' : isLast ? 'var(--green)' : 'var(--ink-2)',
                          borderRadius: '3px 3px 0 0',
                        }}
                      />
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: 'var(--mono)',
                          color: 'var(--ink-5)',
                        }}
                      >
                        {w.week}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {d.tickets.length > 0 && (
            <section className="detail-section">
              <h4>
                Tickets &amp; features <span className="count">· {d.tickets.length}</span>
              </h4>
              <ul className="item-linked">
                {d.tickets.slice(0, 25).map((t) => (
                  <li
                    key={t.id}
                    onClick={() => setOpenItemId(t.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setOpenItemId(t.id);
                      }
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <span className="src-badge src-jira">JRA</span>
                    <span className="lw-id">{t.source_id}</span>
                    <span className="lw-title">{t.title}</span>
                    <span className={`lw-state state-${t.status}`}>
                      {t.status.replace(/_/g, ' ')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="detail-side">
          <div className="side-card">
            <span className="side-card-label">Completion</span>
            <span className="side-card-val">{Math.round(s.completion_pct)}%</span>
            <span className="side-card-sub">
              {s.completion_done} of {s.completion_total} done
            </span>
          </div>
          <div className="side-card">
            <span className="side-card-label">Velocity</span>
            <span className="side-card-val">{s.velocity}</span>
            <span className="side-card-sub">per week · last {period}</span>
          </div>
          <div className="side-card">
            <span className="side-card-label">PRs</span>
            <span className="side-card-val">{d.code_activity.total_prs}</span>
            <span className="side-card-sub">
              {d.code_activity.merged_prs} merged · {d.code_activity.open_prs} open
            </span>
          </div>
          <div className="side-card">
            <span className="side-card-label">Contributors</span>
            <span className="side-card-val" style={{ fontSize: 14, fontWeight: 400, lineHeight: 1.4 }}>
              {d.code_activity.contributors.slice(0, 6).join(' · ') || '—'}
            </span>
          </div>
          {d.code_activity.repos.length > 0 && (
            <div className="side-card">
              <span className="side-card-label">Repos</span>
              <span
                className="side-card-val"
                style={{ fontSize: 13, fontWeight: 400, lineHeight: 1.4, fontFamily: 'var(--mono)' }}
              >
                {d.code_activity.repos.map((r) => r.split('/').pop()).join(' · ')}
              </span>
            </div>
          )}
        </aside>
      </div>
      <ItemDetailDrawer itemId={openItemId} onClose={() => setOpenItemId(null)} />
    </div>
  );
}

function PeriodPill({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const options = ['30d', '90d', 'all'];
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 3,
        borderRadius: 8,
        background: 'var(--bone-2)',
        border: '1px solid var(--rule)',
      }}
    >
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          style={{
            padding: '5px 10px',
            border: 0,
            borderRadius: 6,
            background: value === o ? 'var(--paper)' : 'transparent',
            color: value === o ? 'var(--ink)' : 'var(--ink-4)',
            fontSize: 12,
            fontWeight: 500,
            fontFamily: 'var(--mono)',
            cursor: 'pointer',
          }}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
