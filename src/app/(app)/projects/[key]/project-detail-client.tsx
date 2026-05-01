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
  const [refreshingReadme, setRefreshingReadme] = useState(false);
  const [refreshingOkrs, setRefreshingOkrs] = useState(false);
  const [readmeOpen, setReadmeOpen] = useState(false);
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

  const handleRefreshReadme = async () => {
    setRefreshingReadme(true);
    try {
      await fetch(`/api/projects/${projectKey}/refresh-readme`, { method: 'POST' });
      // Re-fetch the page to pick up the new README
      await fetchData();
      setReadmeOpen(true);
    } catch {
      // ignore
    }
    setRefreshingReadme(false);
  };

  const handleRefreshOkrs = async () => {
    setRefreshingOkrs(true);
    try {
      await fetch(`/api/projects/${projectKey}/refresh-okrs`, { method: 'POST' });
      await fetchData();
    } catch {
      // ignore
    }
    setRefreshingOkrs(false);
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

        {/* README — stable description of the project itself */}
        <div className="detail-readme">
          <button
            type="button"
            className="detail-readme-toggle"
            onClick={() => setReadmeOpen((v) => !v)}
            aria-expanded={readmeOpen}
          >
            <span className="detail-readme-arrow">{readmeOpen ? '▾' : '▸'}</span>
            <span>About this project</span>
            {d.readme?.generatedAt && (
              <span className="detail-readme-meta">
                generated {new Date(d.readme.generatedAt).toLocaleDateString()}
              </span>
            )}
            <button
              type="button"
              className="detail-readme-regen"
              onClick={(e) => { e.stopPropagation(); handleRefreshReadme(); }}
              disabled={refreshingReadme}
            >
              {refreshingReadme ? 'Regenerating…' : 'Regenerate'}
            </button>
          </button>
          {readmeOpen && (
            <div className="detail-readme-body">
              {d.readme?.content ? (
                <Markdown>{d.readme.content}</Markdown>
              ) : (
                <p className="detail-readme-empty">
                  No README yet — generating in the background. Reload in a few seconds, or click Regenerate to force a refresh.
                </p>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="detail-body">
        <div className="detail-main">
          {/* OKRs — measurable goals tied to the README */}
          <section className="detail-section">
            <div className="proj-okrs-head">
              <h4>OKRs</h4>
              <button
                type="button"
                className="proj-okrs-regen"
                onClick={handleRefreshOkrs}
                disabled={refreshingOkrs}
              >
                {refreshingOkrs ? 'Regenerating…' : (d.okrs && d.okrs.length > 0 ? 'Regenerate' : 'Generate')}
              </button>
            </div>
            {d.okrs && d.okrs.length > 0 ? (
              <ul className="proj-okrs">
                {d.okrs.map((o) => (
                  <li key={o.id} className="proj-okr">
                    <div className="proj-okr-head">
                      <span className="proj-okr-eyebrow">Objective</span>
                      <h5>{o.title}</h5>
                      {o.why && <p className="proj-okr-why">{o.why}</p>}
                    </div>
                    {o.key_results.length > 0 && (
                      <ul className="proj-okr-krs">
                        {o.key_results.map((kr) => (
                          <li key={kr.id} className="proj-okr-kr">
                            <span className="proj-okr-kr-text">{kr.text}</span>
                            <div className="proj-okr-kr-meta">
                              {kr.target_metric && (
                                <span className="proj-okr-kr-metric">
                                  {kr.target_metric} = {kr.target_value}
                                </span>
                              )}
                              {kr.target_at && (
                                <span className="proj-okr-kr-due">
                                  by {new Date(kr.target_at).toLocaleDateString()}
                                </span>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="proj-okrs-empty">
                No OKRs yet. {d.readme?.content ? 'Generating in the background — reload in a few seconds, or click Generate.' : 'Generate the README first; OKRs are anchored to it.'}
              </p>
            )}
          </section>

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

          {d.anomalies && d.anomalies.length > 0 && (
            <section className="detail-section">
              <h4>Anomalies — {d.anomalies.length} open</h4>
              <ul className="proj-anomalies">
                {d.anomalies.map((a) => (
                  <li key={a.id}>
                    <span className={`tracker-anomaly-kind tracker-anomaly-${a.kind}`}>
                      {a.kind.replace(/_/g, ' ')}
                    </span>
                    <span className="proj-anomaly-text">{a.explanation ?? a.scope}</span>
                    <span className="proj-anomaly-sev">{Math.round(a.severity * 100)}%</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {d.actionItems && d.actionItems.length > 0 && (
            <section className="detail-section">
              <h4>Action items — {d.actionItems.length} open</h4>
              <ul className="proj-actions">
                {d.actionItems.map((a) => (
                  <li key={a.id}>
                    <span className={`tracker-pri tracker-pri-${(a.user_priority ?? a.ai_priority ?? 'p3').toLowerCase()}`}>
                      {(a.user_priority ?? a.ai_priority ?? 'p3').toLowerCase()}
                    </span>
                    <span className="proj-action-text">
                      {a.text}
                      <span className="proj-action-from">
                        — {a.source_id}
                        {a.assignee ? ` · ${a.assignee}` : ''}
                        {a.due_at ? ` · due ${new Date(a.due_at).toLocaleDateString()}` : ''}
                      </span>
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
