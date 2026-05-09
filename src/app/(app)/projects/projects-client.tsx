'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ProjectSummaryCard } from '@/lib/project-queries';
import { useWorkgraphState } from '@/components/workspace/workgraph-state';
import { ROLES } from '@/components/layout/topbar';
import { Markdown } from '@/components/chat/prompt-kit/markdown';

type Health = 'fire' | 'watch' | 'healthy' | 'quiet';
type Status = 'on-track' | 'at-risk' | 'stalled' | 'shipped';

interface DisplayCard {
  key: string;
  name: string;
  pillar: string;
  health: Health;
  status: Status;
  owner: string;
  ownerCount: number;
  blockers: number;
  pending: number;
  nextMilestone: string;
  nextDue: string | null;
  lastShip: string;
  sentiment: string;
  activity: number[];
  activityWeek: number;
}

const STATUS_LABEL: Record<Status, string> = {
  'on-track': 'On track',
  'at-risk': 'At risk',
  stalled: 'Stalled',
  shipped: 'Shipped',
};

const HEALTH_DOT: Record<Health, string> = {
  fire: 'var(--red)',
  watch: 'var(--amber)',
  healthy: 'var(--green)',
  quiet: 'var(--ink-4)',
};

function toHealth(h: ProjectSummaryCard['health_status']): Health {
  if (h === 'at_risk') return 'fire';
  if (h === 'needs_attention') return 'watch';
  return 'healthy';
}

function toStatus(c: ProjectSummaryCard): Status {
  if (c.health_status === 'at_risk') return 'at-risk';
  if (c.completion_pct >= 95) return 'shipped';
  if (c.stale_count > c.open_count / 2 && c.open_count > 0) return 'stalled';
  return 'on-track';
}

function mapCard(c: ProjectSummaryCard): DisplayCard {
  const health = toHealth(c.health_status);
  const status = toStatus(c);
  const pct = Math.round(c.completion_pct ?? 0);
  const sentiment =
    c.summary_snippet && c.summary_snippet.length > 0
      ? c.summary_snippet.replace(/\s+/g, ' ').trim()
      : `${pct}% done · ${c.velocity_delta_pct >= 0 ? '+' : ''}${c.velocity_delta_pct}% velocity`;
  const activity = Array.from({ length: 7 }, (_, i) =>
    Math.max(0, Math.round((c.velocity ?? 0) * (0.6 + (i / 6) * 0.8))),
  );
  return {
    key: c.key,
    name: c.name,
    pillar: c.key,
    health,
    status,
    owner: 'team',
    ownerCount: Math.max(1, c.pr_count ? Math.min(c.pr_count, 6) : 1),
    blockers: c.health_status === 'at_risk' ? 1 : 0,
    pending: c.stale_count > 5 ? 1 : 0,
    nextMilestone: `${c.completion_done} of ${c.completion_total} complete`,
    nextDue: c.stale_count > 0 ? `${c.stale_count} stale` : null,
    lastShip: `${c.velocity} closed · ${c.velocity_delta_pct >= 0 ? '+' : ''}${c.velocity_delta_pct}%`,
    sentiment: sentiment.length > 140 ? sentiment.slice(0, 137) + '…' : sentiment,
    activity,
    activityWeek: c.velocity ?? 0,
  };
}

export function ProjectsIndexClient({ initialCards }: { initialCards: ProjectSummaryCard[] }) {
  const [period, setPeriod] = useState('30d');
  const [cards, setCards] = useState(initialCards);
  const [createOpen, setCreateOpen] = useState(false);
  const { state, setState } = useWorkgraphState();
  const role = ROLES[state.role] ?? Object.values(ROLES)[0];
  const roleLabel = role?.label ?? 'Workspace User';

  useEffect(() => {
    if (period === '30d') {
      setCards(initialCards);
      return;
    }
    fetch(`/api/projects/index?period=${period}`)
      .then((r) => r.json())
      .then(setCards)
      .catch(() => {});
  }, [period, initialCards]);

  const items = useMemo(() => cards.map(mapCard), [cards]);
  const layout = state.projLayout;
  const fire = items.filter((i) => i.health === 'fire').length;
  const watch = items.filter((i) => i.health === 'watch').length;
  const healthy = items.filter((i) => i.health === 'healthy' || i.health === 'quiet').length;

  return (
    <div className="projects">
      <section className="page-header">
        <div className="page-header-left">
          <h2>Projects</h2>
          <p>
            {items.length} active project{items.length === 1 ? '' : 's'} · tracked on {state.source}
          </p>
        </div>
        <div className="page-header-right">
          {fire > 0 && (
            <div className="sum-pill risk">
              <span className="sum-pill-dot" />
              {fire} on fire
            </div>
          )}
          {watch > 0 && (
            <div className="sum-pill watch">
              <span className="sum-pill-dot" />
              {watch} watch
            </div>
          )}
          <div className="sum-pill on">
            <span className="sum-pill-dot" />
            {healthy} healthy
          </div>
          <PeriodPill value={period} onChange={setPeriod} />
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              border: '1px solid var(--rule)',
              background: 'var(--paper)',
              color: 'var(--ink)',
              fontSize: 12,
              fontWeight: 500,
              fontFamily: 'var(--mono)',
              cursor: 'pointer',
            }}
          >
            + New project
          </button>
        </div>
      </section>

      {createOpen && <NewProjectModal onClose={() => setCreateOpen(false)} />}

      <div className="proj-rolebar">
        <div className="proj-rolebar-left">
          <div className="proj-rolebar-label">Projects source</div>
          <div className="proj-source-pill">
            <span className="src-dot" /> {state.source}
            <span className="src-divider">·</span>
            <span className="src-count">{items.length} items</span>
          </div>
        </div>
        <div className="proj-rolebar-right">
          <div className="proj-rolebar-label">Role · {roleLabel.toLowerCase()}</div>
        </div>
      </div>

      <div className="proj-layoutbar">
        {(
          [
            { id: 'ledger', label: 'Ledger', hint: 'dense list' },
            { id: 'atlas', label: 'Atlas', hint: 'grouped by risk' },
          ] as const
        ).map((o) => (
          <button
            key={o.id}
            type="button"
            className={`proj-layout-btn ${layout === o.id ? 'on' : ''}`}
            onClick={() => setState({ projLayout: o.id })}
          >
            <span className="lbl">{o.label}</span>
            <span className="hint">{o.hint}</span>
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="goals-empty">
          No project data yet. Run a sync from Settings to populate work items.
        </div>
      ) : layout === 'ledger' ? (
        <Ledger items={items} atRiskOnTop={state.projAtRisk} />
      ) : (
        <Atlas items={items} />
      )}
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

function Spark({ data, w = 56, h = 16 }: { data: number[]; w?: number; h?: number }) {
  const max = Math.max(1, ...data);
  const step = w / Math.max(data.length - 1, 1);
  const pts = data.map((v, i) => `${i * step},${h - (v / max) * (h - 2) - 1}`).join(' ');
  return (
    <svg width={w} height={h} className="spark" aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.25} />
    </svg>
  );
}

function Ledger({ items, atRiskOnTop }: { items: DisplayCard[]; atRiskOnTop: boolean }) {
  const order: Record<Health, number> = { fire: 0, watch: 1, quiet: 2, healthy: 3 };

  const atRisk = atRiskOnTop
    ? items
        .filter((p) => p.health === 'fire' || p.health === 'watch')
        .sort((a, b) => order[a.health] - order[b.health])
    : [];

  const pool = atRiskOnTop
    ? items.filter((p) => p.health !== 'fire' && p.health !== 'watch')
    : items;

  const grouped: Record<string, DisplayCard[]> = {};
  pool.forEach((p) => {
    (grouped[p.pillar] ||= []).push(p);
  });
  const pillarNames = Object.keys(grouped).sort();

  return (
    <section className="ledger">
      <div className="ledger-head">
        <div className="col col-name">Project</div>
        <div className="col col-status">Status</div>
        <div className="col col-owner">Owner</div>
        <div className="col col-block">Blockers / Pending</div>
        <div className="col col-next">Next milestone</div>
        <div className="col col-ship">Last ship</div>
        <div className="col col-sent">Sentiment</div>
        <div className="col col-act">Activity · 7d</div>
      </div>

      {atRisk.length > 0 && (
        <>
          <div className="ledger-groupcap">
            <span className="gc-caret">▾</span>
            <span className="gc-label">Needs attention</span>
            <span> · {atRisk.length}</span>
          </div>
          {atRisk.map((p) => (
            <LedgerRow key={p.key} p={p} />
          ))}
        </>
      )}

      {pillarNames.map((pillar) => (
        <div key={pillar}>
          <div className="ledger-groupcap muted">
            <span className="gc-caret">▾</span>
            <span className="gc-label">{pillar}</span>
            <span> · {grouped[pillar].length}</span>
          </div>
          {grouped[pillar].map((p) => (
            <LedgerRow key={p.key} p={p} />
          ))}
        </div>
      ))}
    </section>
  );
}

function LedgerRow({ p }: { p: DisplayCard }) {
  return (
    <Link
      href={`/projects/${p.key}`}
      className="ledger-row"
      style={{ color: 'inherit', textDecoration: 'none' }}
    >
      <div className="col col-name">
        <div className="row-name">
          <span className="health-dot" style={{ background: HEALTH_DOT[p.health] }} />
          <span className="row-key">{p.key}</span>
          <span className="row-title">{p.name}</span>
        </div>
      </div>
      <div className="col col-status">
        <span className={`status-chip status-${p.status}`}>{STATUS_LABEL[p.status]}</span>
      </div>
      <div className="col col-owner">
        <div className="owner-name">{p.owner}</div>
        <div className="owner-team">+{Math.max(0, p.ownerCount - 1)}</div>
      </div>
      <div className="col col-block">
        <span className={`pill pill-block ${p.blockers ? 'hot' : ''}`}>{p.blockers} blk</span>
        <span className={`pill pill-pend ${p.pending ? 'warm' : ''}`}>{p.pending} dec</span>
      </div>
      <div className="col col-next">
        <div className="next-title">{p.nextMilestone}</div>
        {p.nextDue && (
          <div className={`next-due ${/overdue|stale/i.test(p.nextDue) ? 'bad' : ''}`}>
            {p.nextDue}
          </div>
        )}
      </div>
      <div className="col col-ship">
        <div className="ship-line">{p.lastShip}</div>
      </div>
      <div className="col col-sent">
        <div className="sent-text">
          <Markdown compact>{p.sentiment}</Markdown>
        </div>
      </div>
      <div className="col col-act">
        <div className="act-wrap" style={{ color: HEALTH_DOT[p.health] }}>
          <Spark data={p.activity} />
          <span className="act-n">{p.activityWeek}</span>
        </div>
      </div>
    </Link>
  );
}

const PROJECT_KEY_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const normalizedKey = key.trim().toUpperCase();
  const keyValid = PROJECT_KEY_PATTERN.test(normalizedKey);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!keyValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: normalizedKey, name: name.trim() || normalizedKey }),
      });
      if (res.status === 409) {
        setError(`A project with key "${normalizedKey}" already exists.`);
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(typeof j.error === 'string' ? j.error : `Failed (${res.status})`);
        return;
      }
      router.push(`/projects/${normalizedKey}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        style={{
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderRadius: 12,
          padding: 24,
          width: 420,
          maxWidth: '90vw',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>New project</h3>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>Key</span>
          <input
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="e.g. WG"
            style={{
              padding: '8px 10px',
              border: '1px solid var(--rule)',
              borderRadius: 6,
              fontFamily: 'var(--mono)',
              textTransform: 'uppercase',
            }}
          />
          <span style={{ fontSize: 11, color: keyValid || !key ? 'var(--ink-4)' : 'var(--red)' }}>
            Uppercase, alphanumeric + _/-, max 32 characters.
          </span>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>Name (optional)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={normalizedKey || 'Project name'}
            style={{
              padding: '8px 10px',
              border: '1px solid var(--rule)',
              borderRadius: 6,
            }}
          />
        </label>

        {error && (
          <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: '6px 12px',
              border: '1px solid var(--rule)',
              borderRadius: 6,
              background: 'transparent',
              cursor: submitting ? 'default' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!keyValid || submitting}
            style={{
              padding: '6px 12px',
              border: 0,
              borderRadius: 6,
              background: keyValid && !submitting ? 'var(--ink)' : 'var(--ink-4)',
              color: 'var(--paper)',
              cursor: keyValid && !submitting ? 'pointer' : 'default',
            }}
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Atlas({ items }: { items: DisplayCard[] }) {
  const groups: { key: Health; label: string }[] = [
    { key: 'fire', label: 'On fire' },
    { key: 'watch', label: 'Watch' },
    { key: 'quiet', label: 'Quiet' },
    { key: 'healthy', label: 'Healthy' },
  ];
  return (
    <div className="atlas">
      {groups.map((g) => {
        const list = items.filter((p) => p.health === g.key);
        if (list.length === 0) return null;
        return (
          <section key={g.key} className="atlas-group">
            <h3 className="atlas-grouph">
              <span className={`atlas-dot atlas-dot-${g.key}`} />
              {g.label}
              <span className="atlas-count">{list.length}</span>
            </h3>
            <div className="atlas-grid">
              {list.map((p) => (
                <Link
                  key={p.key}
                  href={`/projects/${p.key}`}
                  className="atlas-card"
                  style={{ color: 'inherit', textDecoration: 'none' }}
                >
                  <header className="atlas-card-head">
                    <div>
                      <div className="atlas-key">
                        {p.key} · {p.pillar}
                      </div>
                      <h4 className="atlas-name">{p.name}</h4>
                    </div>
                    <span className={`status-chip status-${p.status}`}>{STATUS_LABEL[p.status]}</span>
                  </header>
                  <div className="atlas-next">
                    <span className="eyebrow">Next</span>
                    <span className="v">{p.nextMilestone}</span>
                    {p.nextDue && (
                      <span className={`atlas-due ${/overdue|stale/i.test(p.nextDue) ? 'bad' : ''}`}>
                        {p.nextDue}
                      </span>
                    )}
                  </div>
                  <div className="atlas-meta">
                    <div>
                      <span className="eyebrow">Owner</span>
                      {p.owner}
                      <span className="plus"> +{Math.max(0, p.ownerCount - 1)}</span>
                    </div>
                    <div>
                      <span className="eyebrow">Blk</span>
                      {p.blockers}
                    </div>
                    <div>
                      <span className="eyebrow">Dec</span>
                      {p.pending}
                    </div>
                    <div>
                      <span className="eyebrow">7d</span>
                      <Spark data={p.activity} w={44} h={12} />
                    </div>
                  </div>
                  <footer className="atlas-foot">
                    <span className="sent">
                      <Markdown compact>{p.sentiment}</Markdown>
                    </span>
                    <span className="chev">→</span>
                  </footer>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
