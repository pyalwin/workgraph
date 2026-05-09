'use client';

/**
 * Backlog block — renders the project's todos + features inside the
 * Activity tab. AI-seeded items live in `project_backlog_items` with a
 * stable id; user actions (state changes, edits, manual adds) survive
 * regeneration.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

interface BacklogItem {
  id: string;
  kind: 'todo' | 'feature';
  title: string;
  description: string | null;
  source: 'almanac' | 'manual';
  state: 'open' | 'in_progress' | 'done' | 'dismissed';
  aiGenerated: boolean;
  evidence: { paths?: string[]; refs?: string[]; commits?: string[]; notes?: string } | null;
  createdAt: string;
  updatedAt: string;
}

type FilterKind = 'all' | 'todo' | 'feature';
type FilterState = 'open_inprogress' | 'all' | 'done' | 'dismissed';

const FILTER_LABELS: Record<FilterKind, string> = {
  all: 'All',
  todo: 'Todos',
  feature: 'Features',
};

const STATE_LABELS: Record<FilterState, string> = {
  open_inprogress: 'Open',
  all: 'All states',
  done: 'Done',
  dismissed: 'Dismissed',
};

const KIND_BADGE: Record<BacklogItem['kind'], { color: string; label: string }> = {
  todo: { color: 'var(--ink-2)', label: 'TODO' },
  feature: { color: 'var(--green)', label: 'FEATURE' },
};

export function ProjectBacklogBlock({ projectKey }: { projectKey: string }) {
  const [items, setItems] = useState<BacklogItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterKind, setFilterKind] = useState<FilterKind>('all');
  const [filterState, setFilterState] = useState<FilterState>('open_inprogress');
  const [addOpen, setAddOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectKey}/backlog`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const json = await res.json();
      setItems(json.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!items) return [];
    return items.filter((it) => {
      if (filterKind !== 'all' && it.kind !== filterKind) return false;
      if (filterState === 'open_inprogress') return it.state === 'open' || it.state === 'in_progress';
      if (filterState === 'done') return it.state === 'done';
      if (filterState === 'dismissed') return it.state === 'dismissed';
      return true; // 'all'
    });
  }, [items, filterKind, filterState]);

  async function patch(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/projects/${projectKey}/backlog/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) refresh();
  }

  async function destroy(id: string) {
    const res = await fetch(`/api/projects/${projectKey}/backlog/${id}`, { method: 'DELETE' });
    if (res.ok) refresh();
  }

  async function regenerate() {
    setRefreshing(true);
    try {
      await fetch(`/api/projects/${projectKey}/regenerate`, { method: 'POST' });
    } finally {
      setRefreshing(false);
      // Items appear asynchronously as the agent runs the job; poll once
      // after a beat so the UI updates without a manual refresh.
      setTimeout(refresh, 4000);
    }
  }

  return (
    <section className="proj-section">
      <div className="proj-section-head">
        <div>
          <p className="proj-section-eyebrow">Backlog</p>
          <h2 className="proj-section-title">Todos and possible features</h2>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="proj-section-action" onClick={regenerate} disabled={refreshing}>
            {refreshing ? 'Queuing…' : 'Regenerate'}
          </button>
          <button className="proj-section-action" onClick={() => setAddOpen(true)}>
            + Add
          </button>
        </div>
      </div>

      <div className="proj-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <FilterBar
          kind={filterKind}
          onKindChange={setFilterKind}
          state={filterState}
          onStateChange={setFilterState}
        />

        {loading && <p className="proj-empty">Loading backlog…</p>}
        {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p>}
        {!loading && filtered.length === 0 && !error && (
          <p className="proj-empty">
            {items && items.length > 0
              ? 'No items match this filter.'
              : 'No backlog yet. Click Regenerate to scan attached repos, or add an item manually.'}
          </p>
        )}

        {filtered.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filtered.map((it) => (
              <BacklogRow
                key={it.id}
                item={it}
                onToggleDone={() =>
                  patch(it.id, { state: it.state === 'done' ? 'open' : 'done' })
                }
                onMarkInProgress={() => patch(it.id, { state: 'in_progress' })}
                onDismiss={() => patch(it.id, { state: 'dismissed' })}
                onReopen={() => patch(it.id, { state: 'open' })}
                onDelete={() => destroy(it.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {addOpen && (
        <AddItemModal
          projectKey={projectKey}
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            refresh();
          }}
        />
      )}
    </section>
  );
}

function FilterBar({
  kind,
  onKindChange,
  state,
  onStateChange,
}: {
  kind: FilterKind;
  onKindChange: (k: FilterKind) => void;
  state: FilterState;
  onStateChange: (s: FilterState) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {(['all', 'todo', 'feature'] as FilterKind[]).map((k) => (
        <Chip key={k} active={kind === k} onClick={() => onKindChange(k)}>
          {FILTER_LABELS[k]}
        </Chip>
      ))}
      <span style={{ width: 1, background: 'var(--rule)', margin: '0 4px' }} />
      {(['open_inprogress', 'done', 'dismissed', 'all'] as FilterState[]).map((s) => (
        <Chip key={s} active={state === s} onClick={() => onStateChange(s)}>
          {STATE_LABELS[s]}
        </Chip>
      ))}
    </div>
  );
}

function Chip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '4px 10px',
        borderRadius: 999,
        border: '1px solid var(--rule)',
        background: active ? 'var(--ink)' : 'transparent',
        color: active ? 'var(--paper)' : 'var(--ink)',
        fontSize: 12,
        fontFamily: 'var(--mono)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function BacklogRow({
  item,
  onToggleDone,
  onMarkInProgress,
  onDismiss,
  onReopen,
  onDelete,
}: {
  item: BacklogItem;
  onToggleDone: () => void;
  onMarkInProgress: () => void;
  onDismiss: () => void;
  onReopen: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const isClosed = item.state === 'done' || item.state === 'dismissed';
  const badge = KIND_BADGE[item.kind];

  return (
    <li
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        border: '1px solid var(--rule)',
        borderRadius: 8,
        background: 'var(--paper)',
        opacity: isClosed ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <input
          type="checkbox"
          checked={item.state === 'done'}
          onChange={onToggleDone}
          style={{ marginTop: 3 }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                fontWeight: 600,
                padding: '2px 6px',
                borderRadius: 3,
                background: 'var(--bone-2)',
                color: badge.color,
                letterSpacing: 0.4,
              }}
            >
              {badge.label}
            </span>
            <span
              style={{
                fontSize: 14,
                fontWeight: 500,
                textDecoration: item.state === 'done' ? 'line-through' : 'none',
              }}
            >
              {item.title}
            </span>
            {item.state === 'in_progress' && (
              <span style={{ fontSize: 11, color: 'var(--amber)' }}>In progress</span>
            )}
            {item.state === 'dismissed' && (
              <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>Dismissed</span>
            )}
            {!item.aiGenerated && (
              <span style={{ fontSize: 11, color: 'var(--ink-4)', fontStyle: 'italic' }}>manual</span>
            )}
          </div>
          {item.description && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{
                marginTop: 4,
                background: 'transparent',
                border: 0,
                padding: 0,
                color: 'var(--ink-4)',
                fontSize: 12,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {expanded ? '▾' : '▸'} details
            </button>
          )}
          {expanded && item.description && (
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--ink-3)', whiteSpace: 'pre-wrap' }}>
              {item.description}
              {item.evidence?.paths && item.evidence.paths.length > 0 && (
                <div style={{ marginTop: 6, fontFamily: 'var(--mono)', fontSize: 11 }}>
                  {item.evidence.paths.slice(0, 5).map((p) => (
                    <div key={p} style={{ color: 'var(--ink-4)' }}>· {p}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            style={{
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 18,
              color: 'var(--ink-4)',
              padding: 4,
            }}
            aria-label="More actions"
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              onMouseLeave={() => setMenuOpen(false)}
              style={{
                position: 'absolute',
                right: 0,
                top: 24,
                background: 'var(--paper)',
                border: '1px solid var(--rule)',
                borderRadius: 6,
                boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                minWidth: 160,
                zIndex: 10,
              }}
            >
              {item.state !== 'in_progress' && item.state !== 'done' && (
                <MenuButton
                  onClick={() => {
                    setMenuOpen(false);
                    onMarkInProgress();
                  }}
                >
                  Mark in progress
                </MenuButton>
              )}
              {(item.state === 'done' || item.state === 'dismissed') && (
                <MenuButton
                  onClick={() => {
                    setMenuOpen(false);
                    onReopen();
                  }}
                >
                  Reopen
                </MenuButton>
              )}
              {item.state !== 'dismissed' && (
                <MenuButton
                  onClick={() => {
                    setMenuOpen(false);
                    onDismiss();
                  }}
                >
                  Dismiss
                </MenuButton>
              )}
              <MenuButton
                onClick={() => {
                  setMenuOpen(false);
                  if (confirm('Delete permanently?')) onDelete();
                }}
                danger
              >
                Delete
              </MenuButton>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function MenuButton({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '8px 12px',
        border: 0,
        background: 'transparent',
        cursor: 'pointer',
        fontSize: 13,
        color: danger ? 'var(--red)' : 'var(--ink)',
      }}
    >
      {children}
    </button>
  );
}

function AddItemModal({
  projectKey,
  onClose,
  onAdded,
}: {
  projectKey: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [kind, setKind] = useState<'todo' | 'feature'>('todo');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectKey}/backlog`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, title: title.trim(), description: description.trim() || null }),
      });
      if (res.status === 409) {
        setError('An item with this title already exists.');
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(typeof j.error === 'string' ? j.error : `Failed (${res.status})`);
        return;
      }
      onAdded();
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
          width: 480,
          maxWidth: '92vw',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>New backlog item</h3>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'todo' | 'feature')}
            style={{ padding: '8px 10px', border: '1px solid var(--rule)', borderRadius: 6 }}
          >
            <option value="todo">Todo</option>
            <option value="feature">Feature</option>
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>Title</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short imperative phrase"
            style={{ padding: '8px 10px', border: '1px solid var(--rule)', borderRadius: 6 }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>Description (optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ padding: '8px 10px', border: '1px solid var(--rule)', borderRadius: 6 }}
          />
        </label>

        {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}

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
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim() || submitting}
            style={{
              padding: '6px 12px',
              border: 0,
              borderRadius: 6,
              background: title.trim() && !submitting ? 'var(--ink)' : 'var(--ink-4)',
              color: 'var(--paper)',
              cursor: title.trim() && !submitting ? 'pointer' : 'default',
            }}
          >
            {submitting ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}
