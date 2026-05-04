// v1 deliberately ships with click-action UX; drag-merge is a Phase 6.5 nice-to-have.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

interface UnitItem {
  id: string;
  name: string | null;
  description: string | null;
  status: string;
  jira_epic_key: string | null;
  detected_from: string;
  ticket_count: number;
  code_event_count: number;
  last_active_at: string | null;
}

interface SplitDialogState {
  unitId: string;
  unitName: string;
}

interface MergeDialogState {
  unitId: string;
  unitName: string;
}

export function UnitEditor({ projectKey }: { projectKey: string }) {
  const [units, setUnits] = useState<UnitItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New unit form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  // Inline rename state: unitId -> draft name
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Action menu open state
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  // Merge dialog
  const [mergeState, setMergeState] = useState<MergeDialogState | null>(null);
  const [mergeIntoId, setMergeIntoId] = useState('');
  const [merging, setMerging] = useState(false);

  // Split dialog
  const [splitState, setSplitState] = useState<SplitDialogState | null>(null);
  const [splitPathPattern, setSplitPathPattern] = useState('');
  const [splitMessage, setSplitMessage] = useState('');
  const [splitNewName, setSplitNewName] = useState('');
  const [splitNewDesc, setSplitNewDesc] = useState('');
  const [splitting, setSplitting] = useState(false);

  const fetchUnits = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/almanac/units?projectKey=${encodeURIComponent(projectKey)}`);
      if (!res.ok) {
        const j = await res.json() as { error?: string };
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      const json = await res.json() as { units: UnitItem[] };
      setUnits(json.units ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [projectKey]);

  useEffect(() => {
    fetchUnits();
  }, [fetchUnits]);

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpenId) return;
    const handler = () => setMenuOpenId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [menuOpenId]);

  // Focus inline edit input when it appears
  useEffect(() => {
    if (editingId) editInputRef.current?.focus();
  }, [editingId]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/almanac/units', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectKey, name: newName.trim(), description: newDesc.trim() || undefined }),
      });
      if (!res.ok) {
        const j = await res.json() as { error?: string };
        alert(j.error ?? 'Failed to create unit');
        return;
      }
      setNewName('');
      setNewDesc('');
      setShowNewForm(false);
      await fetchUnits();
    } finally {
      setCreating(false);
    }
  };

  const handleRename = async (unitId: string) => {
    const name = editingName.trim();
    if (!name) { setEditingId(null); return; }
    try {
      const res = await fetch(`/api/almanac/units/${encodeURIComponent(unitId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const j = await res.json() as { error?: string };
        alert(j.error ?? 'Rename failed');
        return;
      }
      setEditingId(null);
      await fetchUnits();
    } catch {
      alert('Rename failed');
    }
  };

  const handleArchive = async (unitId: string, unitName: string) => {
    if (!confirm(`Archive unit "${unitName}"? This hides it from the Almanac but preserves history.`)) return;
    const res = await fetch(`/api/almanac/units/${encodeURIComponent(unitId)}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json() as { error?: string };
      alert(j.error ?? 'Archive failed');
      return;
    }
    await fetchUnits();
  };

  const handleMerge = async () => {
    if (!mergeState || !mergeIntoId) return;
    setMerging(true);
    try {
      const res = await fetch(`/api/almanac/units/${encodeURIComponent(mergeState.unitId)}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ into: mergeIntoId }),
      });
      const j = await res.json() as { error?: string; code_events_remapped?: number };
      if (!res.ok) { alert(j.error ?? 'Merge failed'); return; }
      alert(`Merged — ${j.code_events_remapped ?? 0} code events remapped.`);
      setMergeState(null);
      setMergeIntoId('');
      await fetchUnits();
    } finally {
      setMerging(false);
    }
  };

  const handleSplit = async () => {
    if (!splitState || !splitNewName.trim()) return;
    if (!splitPathPattern.trim() && !splitMessage.trim()) {
      alert('Specify at least one filter: path pattern or message contains.');
      return;
    }
    setSplitting(true);
    try {
      const res = await fetch(`/api/almanac/units/${encodeURIComponent(splitState.unitId)}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filter: {
            pathPattern: splitPathPattern.trim() || undefined,
            messageContains: splitMessage.trim() || undefined,
          },
          newName: splitNewName.trim(),
          newDescription: splitNewDesc.trim() || undefined,
        }),
      });
      const j = await res.json() as { error?: string; code_events_moved?: number };
      if (!res.ok) { alert(j.error ?? 'Split failed'); return; }
      alert(`Split complete — ${j.code_events_moved ?? 0} code events moved to new unit.`);
      setSplitState(null);
      setSplitPathPattern('');
      setSplitMessage('');
      setSplitNewName('');
      setSplitNewDesc('');
      await fetchUnits();
    } finally {
      setSplitting(false);
    }
  };

  const otherActiveUnits = (currentId: string) =>
    units.filter((u) => u.id !== currentId && u.status === 'active');

  return (
    <div className="unit-editor-page">
      <div className="unit-editor-header">
        <div className="unit-editor-header-left">
          <Link href={`/projects/${projectKey}/almanac`} className="unit-editor-back">
            ← Almanac
          </Link>
          <div>
            <span className="unit-editor-project-key">{projectKey}</span>
            <h1 className="unit-editor-title">Functional Units</h1>
          </div>
        </div>
        <button
          type="button"
          className="unit-editor-new-btn"
          onClick={() => setShowNewForm(true)}
        >
          + New unit
        </button>
      </div>

      {showNewForm && (
        <div className="unit-editor-new-form">
          <input
            className="unit-editor-input"
            placeholder="Unit name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowNewForm(false); }}
            autoFocus
          />
          <input
            className="unit-editor-input"
            placeholder="Description (optional)"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
          />
          <div className="unit-editor-form-actions">
            <button type="button" className="unit-editor-btn-primary" onClick={handleCreate} disabled={creating || !newName.trim()}>
              {creating ? 'Creating…' : 'Create'}
            </button>
            <button type="button" className="unit-editor-btn-ghost" onClick={() => setShowNewForm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading && <div className="unit-editor-loading">Loading…</div>}
      {error && <div className="unit-editor-error">{error}</div>}

      {!loading && units.length === 0 && !error && (
        <div className="unit-editor-empty">No functional units yet. Create one above.</div>
      )}

      {units.length > 0 && (
        <div className="unit-editor-table-wrap">
          <table className="unit-editor-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Tickets</th>
                <th>Code events</th>
                <th>Last active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {units.map((unit) => (
                <tr key={unit.id} className={`unit-editor-row unit-editor-row--${unit.status}`}>
                  <td className="unit-editor-name-cell">
                    {editingId === unit.id ? (
                      <input
                        ref={editInputRef}
                        className="unit-editor-inline-input"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={() => handleRename(unit.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRename(unit.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                      />
                    ) : (
                      <span
                        className="unit-editor-name"
                        onClick={() => { setEditingId(unit.id); setEditingName(unit.name ?? ''); }}
                        title="Click to rename"
                      >
                        {unit.name ?? <em className="unit-editor-unnamed">unnamed</em>}
                      </span>
                    )}
                    {unit.jira_epic_key && (
                      <span className="unit-editor-epic-tag">{unit.jira_epic_key}</span>
                    )}
                  </td>
                  <td>
                    <span className={`unit-editor-status unit-editor-status--${unit.status}`}>
                      {unit.status}
                    </span>
                  </td>
                  <td className="unit-editor-num">{unit.ticket_count}</td>
                  <td className="unit-editor-num">{unit.code_event_count}</td>
                  <td className="unit-editor-date">
                    {unit.last_active_at
                      ? new Date(unit.last_active_at).toLocaleDateString()
                      : '—'}
                  </td>
                  <td className="unit-editor-actions-cell">
                    <div className="unit-editor-menu-wrap">
                      <button
                        type="button"
                        className="unit-editor-menu-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuOpenId(menuOpenId === unit.id ? null : unit.id);
                        }}
                      >
                        ⋯
                      </button>
                      {menuOpenId === unit.id && (
                        <div className="unit-editor-dropdown" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="unit-editor-dropdown-item"
                            onClick={() => {
                              setEditingId(unit.id);
                              setEditingName(unit.name ?? '');
                              setMenuOpenId(null);
                            }}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            className="unit-editor-dropdown-item"
                            onClick={() => {
                              setMergeState({ unitId: unit.id, unitName: unit.name ?? unit.id });
                              setMergeIntoId('');
                              setMenuOpenId(null);
                            }}
                          >
                            Merge into…
                          </button>
                          <button
                            type="button"
                            className="unit-editor-dropdown-item"
                            onClick={() => {
                              setSplitState({ unitId: unit.id, unitName: unit.name ?? unit.id });
                              setSplitNewName('');
                              setSplitPathPattern('');
                              setSplitMessage('');
                              setSplitNewDesc('');
                              setMenuOpenId(null);
                            }}
                          >
                            Split…
                          </button>
                          <button
                            type="button"
                            className="unit-editor-dropdown-item unit-editor-dropdown-item--danger"
                            onClick={() => { handleArchive(unit.id, unit.name ?? unit.id); setMenuOpenId(null); }}
                          >
                            Archive
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Merge dialog */}
      {mergeState && (
        <div className="unit-editor-modal-backdrop" onClick={() => setMergeState(null)}>
          <div className="unit-editor-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="unit-editor-modal-title">Merge &ldquo;{mergeState.unitName}&rdquo; into…</h2>
            <p className="unit-editor-modal-hint">
              All code events will be remapped to the surviving unit.
            </p>
            <select
              className="unit-editor-select"
              value={mergeIntoId}
              onChange={(e) => setMergeIntoId(e.target.value)}
            >
              <option value="">— select surviving unit —</option>
              {otherActiveUnits(mergeState.unitId).map((u) => (
                <option key={u.id} value={u.id}>{u.name ?? u.id}</option>
              ))}
            </select>
            <div className="unit-editor-form-actions">
              <button
                type="button"
                className="unit-editor-btn-primary"
                onClick={handleMerge}
                disabled={merging || !mergeIntoId}
              >
                {merging ? 'Merging…' : 'Merge'}
              </button>
              <button type="button" className="unit-editor-btn-ghost" onClick={() => setMergeState(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Split dialog */}
      {splitState && (
        <div className="unit-editor-modal-backdrop" onClick={() => setSplitState(null)}>
          <div className="unit-editor-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="unit-editor-modal-title">Split &ldquo;{splitState.unitName}&rdquo;</h2>
            <p className="unit-editor-modal-hint">
              Matching code events will be moved to a new unit. Specify at least one filter.
            </p>
            <label className="unit-editor-label">Path pattern (partial match)</label>
            <input
              className="unit-editor-input"
              placeholder="e.g. src/auth or .prisma"
              value={splitPathPattern}
              onChange={(e) => setSplitPathPattern(e.target.value)}
            />
            <label className="unit-editor-label">Commit message contains</label>
            <input
              className="unit-editor-input"
              placeholder="e.g. auth: or [KAN-12]"
              value={splitMessage}
              onChange={(e) => setSplitMessage(e.target.value)}
            />
            <label className="unit-editor-label">New unit name *</label>
            <input
              className="unit-editor-input"
              placeholder="Name for the new unit"
              value={splitNewName}
              onChange={(e) => setSplitNewName(e.target.value)}
            />
            <label className="unit-editor-label">New unit description</label>
            <input
              className="unit-editor-input"
              placeholder="Optional"
              value={splitNewDesc}
              onChange={(e) => setSplitNewDesc(e.target.value)}
            />
            <div className="unit-editor-form-actions">
              <button
                type="button"
                className="unit-editor-btn-primary"
                onClick={handleSplit}
                disabled={splitting || !splitNewName.trim()}
              >
                {splitting ? 'Splitting…' : 'Split'}
              </button>
              <button type="button" className="unit-editor-btn-ghost" onClick={() => setSplitState(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
