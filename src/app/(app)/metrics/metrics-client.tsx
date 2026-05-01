'use client';

import { useEffect, useMemo, useState } from 'react';
import { Markdown } from '@/components/prompt-kit/markdown';
import { ItemDetailDrawer } from '@/components/item-detail-drawer';
import { useWorkgraphState } from '@/components/workgraph-state';

export interface GoalDisplay {
  id: string;
  name: string;
  description: string;
  owner: string;
  status: 'on-track' | 'watch' | 'at-risk' | 'behind' | 'new';
  progress: number;
  items: { total: number; done: number; active: number; stale: number };
  sources: Record<string, number>;
  velocity: number[];
  metrics: Array<{ label: string; value: string; delta: string; good: boolean }>;
  highlights: Array<{ id: string; when: string; text: string; source: string }>;
  risks: Array<{ text: string; severity: 'high' | 'med' | 'low' }>;
  northStar: { label: string; value: number; delta: number; unit: string; target: number } | null;
}

const STATUS_LABEL: Record<GoalDisplay['status'], string> = {
  'on-track': 'on track',
  watch: 'watch',
  'at-risk': 'at risk',
  behind: 'behind',
  new: 'new',
};

type DetailTab = 'overview' | 'items' | 'edit';

export function MetricsClient({
  goals: initialGoals,
  totalItems,
  sourcesCount,
}: {
  goals: GoalDisplay[];
  totalItems: number;
  sourcesCount: number;
}) {
  const { activeWorkspace } = useWorkgraphState();
  const terms = activeWorkspace.ui?.terminology ?? {};
  const goalLabel = terms.goal || 'Goal';
  const goalsLabel = terms.goals || 'Goals';
  const sourceLabel = terms.source || 'source';
  const [goals, setGoals] = useState(initialGoals);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');

  useEffect(() => {
    setGoals(initialGoals);
  }, [initialGoals]);

  const detail = detailId ? goals.find((g) => g.id === detailId) ?? null : null;

  if (detail) {
    return (
      <div className="metrics">
        <GoalDetailPage
          g={detail}
          tab={detailTab}
          setTab={setDetailTab}
          onClose={() => {
            setDetailId(null);
            setDetailTab('overview');
          }}
          onOpenItem={setOpenItemId}
          onSaved={(next) => {
            setGoals((list) => list.map((x) => (x.id === next.id ? next : x)));
          }}
          onDeleted={() => {
            setGoals((list) => list.filter((x) => x.id !== detail.id));
            setDetailId(null);
            setDetailTab('overview');
          }}
        />
        <ItemDetailDrawer itemId={openItemId} onClose={() => setOpenItemId(null)} />
        {creating && (
          <NewGoalDialog
            goalLabel={goalLabel}
            goalsLabel={goalsLabel}
            sourceLabel={sourceLabel}
            onCreate={(g) => {
              setGoals((list) => [g, ...list]);
              setCreating(false);
              setDetailId(g.id);
              setDetailTab('edit');
            }}
            onCancel={() => setCreating(false)}
          />
        )}
      </div>
    );
  }

  const onTrack = goals.filter((g) => g.status === 'on-track').length;
  const watch = goals.filter((g) => g.status === 'watch').length;
  const atRisk = goals.filter((g) => g.status === 'at-risk' || g.status === 'behind').length;
  const totals = goals.reduce(
    (acc, g) => {
      acc.total += g.items.total;
      acc.done += g.items.done;
      return acc;
    },
    { total: 0, done: 0 },
  );

  return (
    <div className="metrics">
      <section className="goals-summary">
        <div className="goals-summary-left">
          <h2>{goalsLabel}</h2>
          <p>
            {goals.length} {goalsLabel.toLowerCase()} · {totalItems} items across{' '}
            {sourcesCount} {sourceLabel.toLowerCase()}{sourcesCount === 1 ? '' : 's'} consolidated automatically
          </p>
        </div>
        <div className="goals-summary-pills">
          {onTrack > 0 && (
            <div className="sum-pill on">
              <span className="sum-pill-dot" />
              {onTrack} on track
            </div>
          )}
          {watch > 0 && (
            <div className="sum-pill watch">
              <span className="sum-pill-dot" />
              {watch} watch
            </div>
          )}
          {atRisk > 0 && (
            <div className="sum-pill risk">
              <span className="sum-pill-dot" />
              {atRisk} at risk
            </div>
          )}
          <div className="sum-pill neutral">
            <span>{totals.done}</span>/<span>{totals.total}</span> items done
          </div>
          <button type="button" className="btn-new-goal" onClick={() => setCreating(true)}>
            + New {goalLabel.toLowerCase()}
          </button>
        </div>
      </section>

      {goals.length === 0 ? (
        <div className="goals-empty">
          No {goalsLabel.toLowerCase()} yet.
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            Add your first {goalLabel.toLowerCase()}
          </button>
        </div>
      ) : (
        <div className="goals-list">
          {goals.map((g) => (
            <GoalCard
              key={g.id}
              g={g}
              onOpen={(goal) => {
                setDetailId(goal.id);
                setDetailTab('overview');
              }}
              onOpenItem={setOpenItemId}
            />
          ))}
        </div>
      )}

      <ItemDetailDrawer itemId={openItemId} onClose={() => setOpenItemId(null)} />
      {creating && (
        <NewGoalDialog
          goalLabel={goalLabel}
          goalsLabel={goalsLabel}
          sourceLabel={sourceLabel}
          onCreate={(g) => {
            setGoals((list) => [g, ...list]);
            setCreating(false);
            setDetailId(g.id);
            setDetailTab('edit');
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  );
}

/* ———————————— GoalCard ———————————— */
function GoalCard({
  g,
  onOpen,
  onOpenItem,
}: {
  g: GoalDisplay;
  onOpen: (g: GoalDisplay) => void;
  onOpenItem: (id: string) => void;
}) {
  return (
    <article
      className={`goal-card status-${g.status}`}
      onClick={() => onOpen(g)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen(g);
      }}
    >
      <header className="goal-card-head">
        <div className="goal-id">
          <div className="goal-name">
            {g.name}
            <span className={`goal-status status-${g.status}`}>{STATUS_LABEL[g.status]}</span>
          </div>
          <div className="goal-desc">
            {g.description ? (
              <Markdown compact>{g.description}</Markdown>
            ) : (
              'No description yet. Edit this goal to add one.'
            )}
          </div>
          <div className="goal-meta">
            <span>
              owner <strong>{g.owner || '—'}</strong>
            </span>
            <span className="sep">·</span>
            <span>
              {g.items.total} item{g.items.total === 1 ? '' : 's'} across {Object.keys(g.sources).length}{' '}
              source{Object.keys(g.sources).length === 1 ? '' : 's'}
            </span>
            <span className="sep">·</span>
            <span>
              {g.items.active} active, {g.items.done} done
              {g.items.stale > 0 && `, ${g.items.stale} stale`}
            </span>
          </div>
        </div>
        {g.northStar && <NorthStar ns={g.northStar} />}
      </header>

      <div className="goal-progress-row">
        <div className="goal-progress">
          <div className="goal-progress-head">
            <span>Progress</span>
            <span className="goal-progress-pct">{g.progress}%</span>
          </div>
          <div className="goal-progress-bar">
            <div
              className="goal-progress-done"
              style={{ width: `${(g.items.done / Math.max(g.items.total, 1)) * 100}%` }}
            />
            <div
              className="goal-progress-active"
              style={{ width: `${(g.items.active / Math.max(g.items.total, 1)) * 100}%` }}
            />
            {g.items.stale > 0 && (
              <div
                className="goal-progress-stale"
                style={{ width: `${(g.items.stale / Math.max(g.items.total, 1)) * 100}%` }}
              />
            )}
          </div>
          <div className="goal-progress-legend">
            <span>
              <i className="dot done" /> {g.items.done} done
            </span>
            <span>
              <i className="dot active" /> {g.items.active} active
            </span>
            {g.items.stale > 0 && (
              <span>
                <i className="dot stale" /> {g.items.stale} stale
              </span>
            )}
          </div>
        </div>
        <div className="goal-trend">
          <div className="goal-trend-label">13-week velocity</div>
          <Sparkline data={g.velocity} />
          <div className="goal-trend-val">{g.velocity.slice(-1)[0] ?? 0} this wk</div>
        </div>
      </div>

      <div className="goal-metrics">
        {g.metrics.map((m, i) => (
          <div key={i} className="goal-metric">
            <div className="goal-metric-label">{m.label}</div>
            <div className="goal-metric-row">
              <span className="goal-metric-val">{m.value}</span>
              <span className={`goal-metric-delta ${m.good ? 'good' : 'bad'}`}>{m.delta}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="goal-bottom">
        <div className="goal-sources">
          <div className="goal-bottom-label">Consolidated from</div>
          <div className="goal-sources-list">
            {Object.entries(g.sources).length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--ink-5)' }}>no sources tagged yet</span>
            )}
            {Object.entries(g.sources).map(([s, c]) => (
              <div key={s} className="goal-source-chip">
                <SrcBadge s={s} />
                <span>{c}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="goal-highlights">
          <div className="goal-bottom-label">Recent</div>
          <ul>
            {g.highlights.slice(0, 2).map((h) => (
              <li
                key={h.id}
                className="goal-hl-item"
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenItem(h.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenItem(h.id);
                  }
                }}
              >
                <SrcBadge s={h.source} />
                <span className="goal-hl-when">{h.when}</span>
                <span className="goal-hl-text">{h.text}</span>
              </li>
            ))}
            {g.highlights.length === 0 && (
              <li>
                <span className="goal-hl-text" style={{ color: 'var(--ink-5)' }}>
                  No recent activity
                </span>
              </li>
            )}
          </ul>
        </div>
        {g.risks.length > 0 && (
          <div className="goal-risks">
            <div className="goal-bottom-label">Risks</div>
            <ul>
              {g.risks.slice(0, 2).map((r, i) => (
                <li key={i} className={`sev-${r.severity}`}>
                  <i className={`risk-dot sev-${r.severity}`} />
                  <span>{r.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </article>
  );
}

function NorthStar({ ns }: { ns: NonNullable<GoalDisplay['northStar']> }) {
  const positive = ns.delta >= 0;
  return (
    <div className="goal-ns">
      <div className="goal-ns-label">{ns.label}</div>
      <div className="goal-ns-row">
        <span className="goal-ns-val">
          {ns.value}
          <span className="goal-ns-unit">{ns.unit}</span>
        </span>
        <span className={`goal-ns-delta ${positive ? 'good' : 'bad'}`}>
          {positive ? '▲' : '▼'} {Math.abs(ns.delta)}%
        </span>
      </div>
      {ns.target != null && (
        <div className="goal-ns-target">
          target {ns.target}
          {ns.unit}
        </div>
      )}
    </div>
  );
}

function SrcBadge({ s }: { s: string }) {
  const map: Record<string, string> = {
    jira: 'JRA',
    slack: 'SLK',
    meetings: 'MTG',
    granola: 'MTG',
    notion: 'NOT',
    gmail: 'GML',
    github: 'GIT',
  };
  const key = s.toLowerCase();
  const label = map[key] ?? s.slice(0, 3).toUpperCase();
  return <span className={`src-badge src-${key}`}>{label}</span>;
}

function Sparkline({ data, width = 140, height = 36 }: { data: number[]; width?: number; height?: number }) {
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data);
  const stepX = width / Math.max(data.length - 1, 1);
  const points = data
    .map((d, i) => {
      const x = i * stepX;
      const y = height - ((d - min) / Math.max(max - min, 1)) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const area = `0,${height} ${points} ${width},${height}`;
  const last = data[data.length - 1];
  const lastX = (data.length - 1) * stepX;
  const lastY = height - ((last - min) / Math.max(max - min, 1)) * (height - 4) - 2;
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polygon points={area} className="sparkline-area" />
      <polyline points={points} className="sparkline-line" />
      <circle cx={lastX} cy={lastY} r={2.5} className="sparkline-dot" />
    </svg>
  );
}

/* ———————————— GoalDetailPage ———————————— */
function GoalDetailPage({
  g,
  tab,
  setTab,
  onClose,
  onOpenItem,
  onSaved,
  onDeleted,
}: {
  g: GoalDisplay;
  tab: DetailTab;
  setTab: (t: DetailTab) => void;
  onClose: () => void;
  onOpenItem: (id: string) => void;
  onSaved: (g: GoalDisplay) => void;
  onDeleted: () => void;
}) {
  return (
    <div className="detail-page" style={{ padding: 0, maxWidth: 'none' }}>
      <button className="detail-back" onClick={onClose}>
        <span className="arrow">←</span> Back to goals
      </button>
      <header className="detail-head">
        <div className="detail-head-top">
          <div className="detail-head-meta" style={{ margin: 0 }}>
            <span className={`goal-status status-${g.status}`}>{STATUS_LABEL[g.status]}</span>
            <span className="sep">·</span>
            <span>Owner {g.owner || '—'}</span>
            <span className="sep">·</span>
            <span>
              {g.items.total} items across {Object.keys(g.sources).length}{' '}
              {Object.keys(g.sources).length === 1 ? 'source' : 'sources'}
            </span>
          </div>
          <div className="detail-tabs detail-tabs-inline">
            <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>
              Overview
            </button>
            <button className={tab === 'items' ? 'active' : ''} onClick={() => setTab('items')}>
              Items <span className="tab-count">{g.items.total}</span>
            </button>
            <button className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>
              Configure
            </button>
          </div>
        </div>
        <h1 className="detail-head-title">{g.name}</h1>
        {g.description && (
          <div className="detail-head-desc">
            <Markdown>{g.description}</Markdown>
          </div>
        )}
      </header>

      {tab === 'overview' && (
        <OverviewTab g={g} setTab={setTab} onOpenItem={onOpenItem} />
      )}
      {tab === 'items' && <ItemsTab goalId={g.id} onOpenItem={onOpenItem} />}
      {tab === 'edit' && (
        <GoalEditor
          g={g}
          onSave={async (updated) => {
            await fetch('/api/config/goals', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: updated.id,
                name: updated.name,
                description: updated.description,
              }),
            });
            onSaved(updated);
            setTab('overview');
          }}
          onCancel={() => setTab('overview')}
          onDelete={async () => {
            if (!confirm(`Delete "${g.name}"? This cannot be undone.`)) return;
            await fetch(`/api/config/goals?id=${encodeURIComponent(g.id)}`, {
              method: 'DELETE',
            });
            onDeleted();
          }}
        />
      )}
    </div>
  );
}

function OverviewTab({
  g,
  setTab,
  onOpenItem,
}: {
  g: GoalDisplay;
  setTab: (t: DetailTab) => void;
  onOpenItem: (id: string) => void;
}) {
  return (
    <div className="detail-body">
      <div className="detail-main">
        <section className="detail-section">
          <h4>Leading metrics</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {g.metrics.map((m, i) => (
              <div
                key={i}
                style={{
                  padding: '10px 12px',
                  background: 'var(--bg)',
                  border: '1px solid var(--rule)',
                  borderRadius: 6,
                }}
              >
                <div className="goal-metric-label">{m.label}</div>
                <div className="goal-metric-row">
                  <span className="goal-metric-val">{m.value}</span>
                  <span className={`goal-metric-delta ${m.good ? 'good' : 'bad'}`}>{m.delta}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {g.highlights.length > 0 && (
          <section className="detail-section">
            <h4>Recent activity</h4>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {g.highlights.map((h) => (
                <li
                  key={h.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenItem(h.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenItem(h.id);
                    }
                  }}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto auto 1fr auto',
                    gap: 10,
                    alignItems: 'center',
                    fontSize: 13,
                    color: 'var(--ink-3)',
                    lineHeight: 1.45,
                    padding: '8px 10px',
                    margin: '0 -10px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    transition: 'background 0.12s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bone)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <SrcBadge s={h.source} />
                  <span className="goal-hl-when">{h.when}</span>
                  <span className="goal-hl-text">{h.text}</span>
                  <span style={{ color: 'var(--ink-5)', fontFamily: 'var(--mono)' }}>→</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {g.risks.length > 0 && (
          <section className="detail-section">
            <h4>
              Risks <span className="count">({g.risks.length})</span>
            </h4>
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {g.risks.map((r, i) => (
                <li
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'start',
                    gap: 10,
                    fontSize: 13,
                    color: 'var(--ink-3)',
                  }}
                >
                  <i className={`risk-dot sev-${r.severity}`} />
                  <span>{r.text}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <aside className="detail-side">
        {g.northStar && (
          <div className="side-card">
            <span className="side-card-label">North star</span>
            <span className="side-card-val">
              {g.northStar.value}
              {g.northStar.unit}
            </span>
            <span className="side-card-sub">
              target {g.northStar.target}
              {g.northStar.unit}
            </span>
          </div>
        )}
        <div className="side-card">
          <span className="side-card-label">Progress</span>
          <span className="side-card-val">{g.progress}%</span>
          <span className="side-card-sub">
            {g.items.done} of {g.items.total} items done
          </span>
        </div>
        {Object.keys(g.sources).length > 0 && (
          <section className="detail-section">
            <h4>Work consolidated</h4>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {Object.entries(g.sources).map(([s, c]) => (
                <button
                  key={s}
                  type="button"
                  className="goal-source-row"
                  onClick={() => setTab('items')}
                >
                  <SrcBadge s={s} />
                  <span className="goal-source-name">{s}</span>
                  <span className="goal-source-count">{c}</span>
                  <span className="goal-source-arrow">→</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}

/* ———————————— Items tab ———————————— */
interface GoalItem {
  id: string;
  source: string;
  source_id: string;
  item_type: string;
  title: string;
  author: string | null;
  status: string | null;
  priority: string | null;
  created_at: string;
  updated_at: string | null;
}

function ItemsTab({ goalId, onOpenItem }: { goalId: string; onOpenItem: (id: string) => void }) {
  const [items, setItems] = useState<GoalItem[] | null>(null);
  const [filter, setFilter] = useState<'all' | string>('all');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/goals/${encodeURIComponent(goalId)}/items`)
      .then((r) => r.json())
      .then((json: { items: GoalItem[] }) => {
        if (!cancelled) setItems(json.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [goalId]);

  const bySource = useMemo(() => {
    const grouped: Record<string, GoalItem[]> = {};
    for (const it of items ?? []) {
      const s = it.source.toLowerCase();
      if (!grouped[s]) grouped[s] = [];
      grouped[s].push(it);
    }
    return grouped;
  }, [items]);

  if (items === null) {
    return (
      <div className="items-list-wrap">
        <span style={{ fontSize: 13, color: 'var(--ink-4)' }}>Loading items…</span>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="items-empty">
        No items tracked under this goal yet. Add new work by tagging it with this goal&rsquo;s
        keywords.
      </div>
    );
  }

  const sources = Object.keys(bySource).sort();
  const visible = filter === 'all' ? items : items.filter((i) => i.source.toLowerCase() === filter);

  return (
    <div className="items-list-wrap">
      <div className="items-filter">
        <button
          type="button"
          className={`items-filter-btn ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All <span className="items-filter-count">{items.length}</span>
        </button>
        {sources.map((s) => (
          <button
            key={s}
            type="button"
            className={`items-filter-btn ${filter === s ? 'active' : ''}`}
            onClick={() => setFilter(s)}
          >
            <SrcBadge s={s} />
            <span style={{ textTransform: 'capitalize' }}>{s}</span>
            <span className="items-filter-count">{bySource[s].length}</span>
          </button>
        ))}
      </div>
      <div className="items-list">
        {visible.map((it) => (
          <button
            type="button"
            key={it.id}
            className="item-row"
            onClick={() => onOpenItem(it.id)}
          >
            <div className="item-row-left">
              <SrcBadge s={it.source} />
              <div className="item-row-body">
                <div className="item-row-title">
                  {it.title}
                  {it.priority && <span className="item-priority" data-level={it.priority.match(/^p\d/i)?.[0]?.toLowerCase()}>{it.priority}</span>}
                </div>
                <div className="item-row-meta">
                  {it.source_id && <span>{it.source_id}</span>}
                  {it.author && <span>· {it.author}</span>}
                  {it.updated_at && <span>· {relWhen(it.updated_at)}</span>}
                </div>
              </div>
            </div>
            {it.status && (
              <span className={`item-status-mini item-status-${it.status}`}>
                {it.status.replace(/_/g, ' ')}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function relWhen(iso: string) {
  const d = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.round(d / 7)}w ago`;
  return `${Math.round(d / 30)}mo ago`;
}

/* ———————————— Goal Editor ———————————— */
interface EditorState {
  name: string;
  description: string;
  owner: string;
  status: GoalDisplay['status'];
}

function GoalEditor({
  g,
  onSave,
  onCancel,
  onDelete,
}: {
  g: GoalDisplay;
  onSave: (g: GoalDisplay) => void | Promise<void>;
  onCancel: () => void;
  onDelete?: () => void | Promise<void>;
}) {
  const [form, setForm] = useState<EditorState>({
    name: g.name,
    description: g.description,
    owner: g.owner,
    status: g.status,
  });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof EditorState>(k: K, v: EditorState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setSaving(true);
    try {
      await onSave({
        ...g,
        name: form.name.trim() || '(untitled)',
        description: form.description.trim(),
        owner: form.owner.trim(),
        status: form.status,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="goal-editor">
      <div className="goal-editor-grid">
        <label className="field">
          <span>Name</span>
          <input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Goal name"
          />
        </label>
        <label className="field">
          <span>Owner</span>
          <input
            value={form.owner}
            onChange={(e) => set('owner', e.target.value)}
            placeholder="Person or team"
          />
        </label>
        <label className="field field-wide">
          <span>Description</span>
          <textarea
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="One sentence describing what this goal is"
            rows={3}
          />
        </label>
        <label className="field">
          <span>Status</span>
          <select value={form.status} onChange={(e) => set('status', e.target.value as GoalDisplay['status'])}>
            <option value="on-track">On track</option>
            <option value="watch">Watch</option>
            <option value="at-risk">At risk</option>
            <option value="behind">Behind</option>
            <option value="new">New</option>
          </select>
        </label>
      </div>
      <div className="goal-editor-actions">
        <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        {onDelete && (
          <button type="button" className="btn btn-danger" onClick={onDelete} disabled={saving}>
            Delete goal
          </button>
        )}
      </div>
    </div>
  );
}

/* ———————————— New Goal Dialog ———————————— */
function NewGoalDialog({
  goalLabel,
  goalsLabel,
  sourceLabel,
  onCreate,
  onCancel,
}: {
  goalLabel: string;
  goalsLabel: string;
  sourceLabel: string;
  onCreate: (g: GoalDisplay) => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const emptyGoal: GoalDisplay = {
    id: '',
    name: '',
    description: '',
    owner: '',
    status: 'new',
    progress: 0,
    items: { total: 0, done: 0, active: 0, stale: 0 },
    sources: {},
    velocity: Array(13).fill(0),
    metrics: [],
    highlights: [],
    risks: [],
    northStar: null,
  };

  return (
    <>
      <div className="modal-scrim open" onClick={onCancel} />
      <div
        className="modal"
        role="dialog"
        aria-label={`New ${goalLabel}`}
        style={{ width: 'min(620px, 94vw)' }}
      >
        <header className="modal-head">
          <div>
            <div className="modal-kicker">New {goalLabel.toLowerCase()}</div>
            <h2>Add {goalLabel.toLowerCase()}</h2>
            <p className="modal-lede">
              {goalsLabel} automatically pull in related work from configured {sourceLabel.toLowerCase()}s based on keywords.
            </p>
          </div>
          <button className="modal-close" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </header>
        <section className="modal-section">
          <GoalEditor
            g={emptyGoal}
            onCancel={onCancel}
            onSave={async (draft) => {
              const res = await fetch('/api/config/goals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  name: draft.name,
                  description: draft.description,
                  keywords: [],
                }),
              });
              const json = (await res.json()) as { id: string };
              onCreate({ ...draft, id: json.id });
            }}
          />
        </section>
      </div>
    </>
  );
}
