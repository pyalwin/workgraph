'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import type { ProjectDetail } from '@/lib/project-queries';
import { Markdown } from '@/components/chat/prompt-kit/markdown';
import { ItemDetailDrawer } from '@/components/items/item-detail-drawer';
import { AnomalyActionPanel } from '@/components/anomalies/anomaly-action-panel';
import { OrphanPrReviewModal } from '@/components/anomalies/orphan-pr-review-modal';
import { OrphanTicketsSection } from '@/components/projects/orphan-tickets-section';

type Tab = 'overview' | 'goals' | 'actions' | 'activity';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'goals', label: 'Goals' },
  { id: 'actions', label: 'Actions' },
  { id: 'activity', label: 'Activity' },
];

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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabFromUrl = searchParams.get('tab');
  const initialTab: Tab = TABS.some((t) => t.id === tabFromUrl) ? (tabFromUrl as Tab) : 'overview';
  const [tab, setTabState] = useState<Tab>(initialTab);

  const setTab = useCallback(
    (next: Tab) => {
      setTabState(next);
      const sp = new URLSearchParams(searchParams.toString());
      sp.set('tab', next);
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const [period, setPeriod] = useState('30d');
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingReadme, setRefreshingReadme] = useState(false);
  const [refreshingOkrs, setRefreshingOkrs] = useState(false);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [ticketQuery, setTicketQuery] = useState('');
  const [ticketsExpanded, setTicketsExpanded] = useState(false);
  const [ticketStatus, setTicketStatus] = useState<string>('all');
  // Repo name to scope the orphan-PR review modal. Set when the user clicks
  // "Review" on an orphan_pr_batch anomaly card; null = modal closed.
  const [orphanReviewRepo, setOrphanReviewRepo] = useState<string | null>(null);

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

  const okrsCount = d.okrs?.length ?? 0;
  const krCount = d.okrs?.reduce((acc, o) => acc + o.key_results.length, 0) ?? 0;
  const actionCount = d.actionItems?.length ?? 0;
  const anomalyCount = d.anomalies?.length ?? 0;

  return (
    <div className="proj-page">
      <Link href="/projects" className="proj-back">
        <span className="arrow">←</span> Back to projects
      </Link>

      {/* ───── Header ───── */}
      <header className="proj-header">
        <div className="proj-header-row">
          <div className="proj-header-meta">
            <span className={`status-chip ${STATUS_CLASS[statusKey] ?? 'status-stalled'}`}>
              {STATUS_LABEL[statusKey] ?? 'Unknown'}
            </span>
            <span className="proj-header-key">{d.project.key}</span>
            <span className="proj-header-counts">
              {d.project.total_tickets} tickets · {d.project.total_prs} linked PRs
            </span>
          </div>
          <div className="proj-header-actions">
            <PeriodPill value={period} onChange={setPeriod} />
          </div>
        </div>
        <h1 className="proj-header-title">{d.project.name}</h1>
        <div className="proj-header-stats">
          <Stat label="completion" primary={`${Math.round(s.completion_pct)}%`} sub={`${s.completion_done} / ${s.completion_total}`} />
          <Stat label="velocity" primary={`${s.velocity} /wk`} sub={`${s.velocity_delta_pct >= 0 ? '+' : ''}${s.velocity_delta_pct}% vs. prior`} tone={s.velocity_delta_pct >= 0 ? 'good' : 'warn'} />
          <Stat label="cycle time" primary={`${s.cycle_time_days}d`} sub={`was ${s.cycle_time_prior_days}d`} />
          <Stat label="stale" primary={String(s.stale_count)} sub={s.stale_pct > 0 ? `${Math.round(s.stale_pct)}% of open` : '—'} tone={s.stale_pct > 30 ? 'warn' : undefined} />
          <Stat label="action items" primary={String(actionCount)} sub={actionCount > 0 ? 'open' : 'none'} tone={actionCount > 0 ? 'warm' : undefined} />
          <Stat label="anomalies" primary={String(anomalyCount)} sub={anomalyCount > 0 ? 'open' : 'none'} tone={anomalyCount > 0 ? 'alert' : undefined} />
        </div>
      </header>

      {/* ───── Tabs ───── */}
      <nav className="proj-tabs" role="tablist" aria-label="Project sections">
        {TABS.map((t) => {
          const count = tabCount(t.id, { okrsCount, actionCount, anomalyCount, ticketCount: d.tickets.length });
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`proj-tab ${active ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <span>{t.label}</span>
              {typeof count === 'number' && count > 0 && (
                <span className="proj-tab-count">{count}</span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === 'overview' && (<>
      {/* ───── Recap (rolling status) ───── */}
      <section className="proj-section">
        <div className="proj-section-head">
          <div>
            <p className="proj-section-eyebrow">Recap</p>
            <h2 className="proj-section-title">This week — what shipped, in flight, watch</h2>
          </div>
          <button className="proj-section-action" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh recap'}
          </button>
        </div>
        <div className="proj-section-body proj-recap">
          {d.health.summary ? (
            <Markdown>{d.health.summary}</Markdown>
          ) : (
            <p className="proj-empty">No recap yet — refresh to generate one.</p>
          )}
        </div>
      </section>

      {/* ───── About (README) ───── */}
      <section className="proj-section">
        <div className="proj-section-head">
          <div>
            <p className="proj-section-eyebrow">About this project</p>
            <h2 className="proj-section-title">Purpose, scope, and the people in it</h2>
          </div>
          <div className="proj-section-actions">
            {d.readme?.generatedAt && (
              <span className="proj-section-meta">
                generated {new Date(d.readme.generatedAt).toLocaleDateString()}
              </span>
            )}
            <button className="proj-section-action" onClick={handleRefreshReadme} disabled={refreshingReadme}>
              {refreshingReadme ? 'Regenerating…' : 'Regenerate'}
            </button>
          </div>
        </div>
        <div className="proj-section-body proj-readme-body">
          {d.readme?.content ? (
            <Markdown>{d.readme.content}</Markdown>
          ) : (
            <p className="proj-empty">
              No README yet — generating in the background. Reload in a few seconds, or click Regenerate to force a refresh.
            </p>
          )}
        </div>
      </section>

      </>)}

      {tab === 'goals' && (
      <>
      {/* ───── OKRs ───── */}
      <section className="proj-section">
        <div className="proj-section-head">
          <div>
            <p className="proj-section-eyebrow">OKRs</p>
            <h2 className="proj-section-title">
              Measurable goals — {okrsCount} {okrsCount === 1 ? 'objective' : 'objectives'} · {krCount} key results
            </h2>
          </div>
          <button className="proj-section-action" onClick={handleRefreshOkrs} disabled={refreshingOkrs}>
            {refreshingOkrs ? 'Regenerating…' : okrsCount > 0 ? 'Regenerate' : 'Generate'}
          </button>
        </div>
        <div className="proj-section-body">
          {okrsCount > 0 ? (
            <ul className="proj-okrs">
              {d.okrs!.map((o, idx) => (
                <li key={o.id} className="proj-okr">
                  <div className="proj-okr-head">
                    <span className="proj-okr-num">O{idx + 1}</span>
                    <div className="proj-okr-head-text">
                      <h3>{o.title}</h3>
                      {o.why && <p className="proj-okr-why">{o.why}</p>}
                    </div>
                  </div>
                  {o.key_results.length > 0 && (
                    <ol className="proj-okr-krs">
                      {o.key_results.map((kr, krIdx) => (
                        <li key={kr.id} className="proj-okr-kr">
                          <span className="proj-okr-kr-num">KR{krIdx + 1}</span>
                          <div className="proj-okr-kr-content">
                            <span className="proj-okr-kr-text">{kr.text}</span>
                            {kr.why && <span className="proj-okr-kr-why">{kr.why}</span>}
                            <div className="proj-okr-kr-meta">
                              {kr.target_metric && (
                                <span className="proj-okr-kr-metric">
                                  <span className="proj-okr-kr-metric-name">{kr.target_metric}</span>
                                  <span className="proj-okr-kr-metric-eq"> = </span>
                                  <span className="proj-okr-kr-metric-val">{kr.target_value}</span>
                                </span>
                              )}
                              {kr.target_at && (
                                <span className="proj-okr-kr-due">
                                  due {new Date(kr.target_at).toLocaleDateString()}
                                </span>
                              )}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="proj-empty">
              No OKRs yet.{' '}
              {d.readme?.content
                ? 'Generating in the background — reload, or click Generate.'
                : 'Generate the README first; OKRs are anchored to it.'}
            </p>
          )}
        </div>
      </section>

      </>)}

      {tab === 'actions' && (
      <>
      {/* ───── Action items ───── */}
      <section className="proj-section">
        <div className="proj-section-head">
          <div>
            <p className="proj-section-eyebrow">Action items</p>
            <h2 className="proj-section-title">
              {actionCount === 0 ? 'No open actions' : `${actionCount} open ${actionCount === 1 ? 'action' : 'actions'} — what needs to happen next`}
            </h2>
          </div>
        </div>
        <div className="proj-section-body">
          {actionCount > 0 ? (
            <ul className="proj-actions-v2">
              {d.actionItems!.map((a) => {
                const pri = (a.user_priority ?? a.ai_priority ?? 'p3').toLowerCase();
                return (
                  <li key={a.id} className="proj-action-v2">
                    <span className={`proj-action-pri tracker-pri tracker-pri-${pri}`}>{pri}</span>
                    <div className="proj-action-content">
                      <p className="proj-action-text">{a.text}</p>
                      <div className="proj-action-meta">
                        {a.assignee && <span className="proj-action-assignee">{a.assignee}</span>}
                        {a.due_at && <span className="proj-action-due">due {new Date(a.due_at).toLocaleDateString()}</span>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="proj-empty">No open action items right now. They get regenerated each sync.</p>
          )}
        </div>
      </section>

      {/* ───── Orphan-ticket code matcher ───── */}
      <OrphanTicketsSection projectKey={projectKey} />

      {/* ───── Anomalies (only when present) ───── */}
      {anomalyCount > 0 && (
        <section className="proj-section">
          <div className="proj-section-head">
            <div>
              <p className="proj-section-eyebrow">Anomalies</p>
              <h2 className="proj-section-title">
                {anomalyCount} flag{anomalyCount === 1 ? '' : 's'} — things to check before they drift
              </h2>
            </div>
          </div>
          <div className="proj-section-body">
            <ul className="proj-anomalies-v2">
              {d.anomalies!.map((a) => {
                const evidence = a.evidence ?? [];
                const primary = evidence[0];
                const extra = evidence.slice(1, 4);
                return (
                  <li key={a.id} className="proj-anomaly-v2" style={{ flexWrap: 'wrap' }}>
                    <span className={`tracker-anomaly-kind tracker-anomaly-${a.kind}`}>
                      {a.kind.replace(/_/g, ' ')}
                    </span>
                    <span className="proj-anomaly-text">{a.explanation ?? a.scope}</span>
                    {primary && (
                      <span className="proj-anomaly-sources">
                        <button
                          type="button"
                          className="proj-anomaly-source"
                          onClick={() => setOpenItemId(primary.id)}
                          title={primary.title}
                        >
                          {primary.source_id}
                        </button>
                        {extra.map((ev) => (
                          <button
                            key={ev.id}
                            type="button"
                            className="proj-anomaly-source"
                            onClick={() => setOpenItemId(ev.id)}
                            title={ev.title}
                          >
                            {ev.source_id}
                          </button>
                        ))}
                        {evidence.length > 4 && (
                          <span className="proj-anomaly-source-more">+{evidence.length - 4}</span>
                        )}
                      </span>
                    )}
                    <span className="proj-anomaly-sev">sev {Math.round(a.severity * 100)}%</span>
                    {a.kind === 'orphan_pr_batch' && a.scope.startsWith('repo:') && (
                      <button
                        type="button"
                        onClick={() => setOrphanReviewRepo(a.scope.slice('repo:'.length))}
                        style={{
                          fontSize: 11,
                          padding: '3px 9px',
                          background: 'var(--ink)',
                          color: 'var(--paper)',
                          border: 'none',
                          borderRadius: 4,
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                      >
                        Review &amp; attach
                      </button>
                    )}
                    <div style={{ flexBasis: '100%' }}>
                      <AnomalyActionPanel
                        anomaly={{
                          id: a.id,
                          kind: a.kind,
                          severity: a.severity,
                          explanation: a.explanation,
                          evidence: a.evidence ?? [],
                          scope: a.scope,
                          action_item_id: a.action_item_id,
                          jira_issue_key: a.jira_issue_key,
                          handled_at: a.handled_at,
                          dismissed_by_user: a.dismissed_by_user,
                        }}
                        projectKey={projectKey}
                        onActioned={fetchData}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}

      </>)}

      {tab === 'activity' && (
      <>
      {/* ───── Velocity chart ───── */}
      {d.velocity_weekly.length > 0 && (
        <section className="proj-section">
          <div className="proj-section-head">
            <div>
              <p className="proj-section-eyebrow">Velocity</p>
              <h2 className="proj-section-title">Tickets closed per week — last {d.velocity_weekly.length} weeks</h2>
            </div>
          </div>
          <div className="proj-section-body proj-velocity-chart">
            {d.velocity_weekly.map((w, i) => {
              const h = Math.max(Math.round((w.closed / maxWeekly) * 100), w.closed > 0 ? 6 : 2);
              const isLast = i === d.velocity_weekly.length - 1;
              return (
                <div key={w.week} className="proj-velocity-bar">
                  <span className="proj-velocity-bar-count">{w.closed}</span>
                  <div
                    className="proj-velocity-bar-fill"
                    style={{
                      height: `${h}px`,
                      background: w.closed === 0 ? 'var(--rule-2)' : isLast ? 'var(--green)' : 'var(--ink-2)',
                    }}
                  />
                  <span className="proj-velocity-bar-label">{w.week}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ───── Items / Tickets ───── */}
      {d.tickets.length > 0 ? (() => {
        const q = ticketQuery.trim().toLowerCase();
        const statusCounts = d.tickets.reduce<Record<string, number>>((acc, t) => {
          acc[t.status] = (acc[t.status] ?? 0) + 1;
          return acc;
        }, {});
        const statusOrder = ['to_do', 'open', 'in_progress', 'done', 'resolved', 'closed'];
        const statusKeys = Object.keys(statusCounts).sort((a, b) => {
          const ai = statusOrder.indexOf(a);
          const bi = statusOrder.indexOf(b);
          if (ai === -1 && bi === -1) return a.localeCompare(b);
          if (ai === -1) return 1;
          if (bi === -1) return -1;
          return ai - bi;
        });
        const filtered = d.tickets.filter((t) => {
          if (ticketStatus !== 'all' && t.status !== ticketStatus) return false;
          if (!q) return true;
          return (
            t.source_id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)
          );
        });
        return (
          <section className="proj-section">
            <div className="proj-section-head">
              <div>
                <p className="proj-section-eyebrow">Items</p>
                <h2 className="proj-section-title">
                  {q || ticketStatus !== 'all'
                    ? `${filtered.length} of ${d.tickets.length}`
                    : d.tickets.length}{' '}
                  {filtered.length === 1 ? 'ticket' : 'tickets'} {periodLabel(period)}
                </h2>
              </div>
              <span className="proj-section-meta">
                {d.code_activity.contributor_count} contributors · {d.code_activity.repo_count} repos
              </span>
            </div>
            <div className="proj-section-body">
              <input
                type="search"
                value={ticketQuery}
                onChange={(e) => setTicketQuery(e.target.value)}
                placeholder="Filter by issue key or title"
                className="proj-ticket-search"
                style={{
                  width: '100%',
                  fontSize: 13,
                  padding: '8px 10px',
                  marginBottom: 10,
                  background: 'var(--paper)',
                  border: '1px solid var(--rule)',
                  borderRadius: 6,
                  fontFamily: 'inherit',
                }}
              />
              {statusKeys.length > 1 && (
                <div className="proj-ticket-filters">
                  <button
                    type="button"
                    className={`proj-ticket-filter ${ticketStatus === 'all' ? 'is-active' : ''}`}
                    onClick={() => setTicketStatus('all')}
                  >
                    All <span className="proj-ticket-filter-count">{d.tickets.length}</span>
                  </button>
                  {statusKeys.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`proj-ticket-filter state-${s} ${ticketStatus === s ? 'is-active' : ''}`}
                      onClick={() => setTicketStatus(s)}
                    >
                      {s.replace(/_/g, ' ')}{' '}
                      <span className="proj-ticket-filter-count">{statusCounts[s]}</span>
                    </button>
                  ))}
                </div>
              )}
              {filtered.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--ink-4)' }}>
                  No tickets match these filters.
                </p>
              ) : (
                <>
                  <ul className="proj-tickets">
                    {(ticketsExpanded ? filtered : filtered.slice(0, 30)).map((t) => (
                      <li
                        key={t.id}
                        className="proj-ticket"
                        onClick={() => setOpenItemId(t.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setOpenItemId(t.id);
                          }
                        }}
                      >
                        <span className="src-badge src-jira">JRA</span>
                        <span className="proj-ticket-id">{t.source_id}</span>
                        <span className="proj-ticket-title">{t.title}</span>
                        {t.linked_prs && t.linked_prs.length > 0 && (
                          <span className="proj-ticket-pr-count" title={`${t.linked_prs.length} PR${t.linked_prs.length === 1 ? '' : 's'} attached`}>
                            {t.linked_prs.length} PR
                          </span>
                        )}
                        {/*
                          Surface fulfillment badges only when the AI flagged something
                          notable AND Jira agrees the ticket is "done-ish". Showing
                          "Partial" on an open ticket adds no information — of course
                          it's partial, it isn't finished. The valuable signal is when
                          Jira says done but the code says otherwise.
                        */}
                        {(t.gap_status === 'partial' || t.gap_status === 'gap') &&
                          ['done', 'closed', 'resolved'].includes(t.status) && (
                            <span
                              className={`proj-ticket-gap proj-ticket-gap-${t.gap_status}`}
                              title={
                                t.gap_status === 'partial'
                                  ? 'AI says some asked requirements are missing from the linked PRs'
                                  : 'AI says the linked PRs do not address what the ticket asked for'
                              }
                              style={{
                                background: t.gap_status === 'gap' ? '#b13434' : '#c4790a',
                                color: '#fff',
                                fontSize: 10,
                                fontWeight: 600,
                                padding: '2px 7px',
                                borderRadius: 999,
                                textTransform: 'uppercase',
                                letterSpacing: '0.06em',
                              }}
                            >
                              {t.gap_status === 'gap' ? 'Gap' : 'Partial'}
                            </span>
                          )}
                        <span className={`proj-ticket-state state-${t.status}`}>
                          {t.status.replace(/_/g, ' ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {filtered.length > 30 && (
                    <button
                      type="button"
                      className="proj-tickets-more"
                      onClick={() => setTicketsExpanded((v) => !v)}
                    >
                      {ticketsExpanded ? 'Show less' : `Show ${filtered.length - 30} more`}
                    </button>
                  )}
                </>
              )}
            </div>
          </section>
        );
      })() : (
        <section className="proj-section">
          <div className="proj-section-head">
            <div>
              <p className="proj-section-eyebrow">Items</p>
              <h2 className="proj-section-title">No tickets {periodLabel(period)}</h2>
            </div>
          </div>
          <div className="proj-section-body">
            <p style={{ fontSize: 13, color: 'var(--ink-4)' }}>
              Try a wider window — switch to <strong>all</strong> to see every ticket on this project.
            </p>
          </div>
        </section>
      )}

      </>)}

      <ItemDetailDrawer itemId={openItemId} onClose={() => setOpenItemId(null)} />
      <OrphanPrReviewModal
        open={orphanReviewRepo !== null}
        repoFilter={orphanReviewRepo}
        projectFilter={projectKey}
        onClose={() => setOrphanReviewRepo(null)}
        onChanged={fetchData}
      />
    </div>
  );
}

function periodLabel(period: string): string {
  if (period === '30d') return 'in last 30 days';
  if (period === '90d') return 'in last 90 days';
  return 'all-time';
}

function tabCount(
  tabId: Tab,
  counts: { okrsCount: number; actionCount: number; anomalyCount: number; ticketCount: number },
): number | null {
  switch (tabId) {
    case 'overview':
      return null;
    case 'goals':
      return counts.okrsCount;
    case 'actions':
      return counts.actionCount + counts.anomalyCount;
    case 'activity':
      return counts.ticketCount;
  }
}

function Stat({
  label,
  primary,
  sub,
  tone,
}: {
  label: string;
  primary: string;
  sub: string;
  tone?: 'good' | 'warn' | 'warm' | 'alert';
}) {
  return (
    <div className={`proj-stat${tone ? ` proj-stat-${tone}` : ''}`}>
      <span className="proj-stat-label">{label}</span>
      <span className="proj-stat-primary">{primary}</span>
      <span className="proj-stat-sub">{sub}</span>
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
