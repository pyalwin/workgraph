'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useWorkgraphState, type Theme } from '@/components/workspace/workgraph-state';
import { ConnectorDirectory } from '@/components/connectors/connector-directory';
import { ConnectorDetailPanel, type SavedConnectorRow } from '@/components/connectors/connector-detail-panel';
import { WORKSPACE_PRESETS, type WorkspacePreset } from '@/components/workspace/workspace-onboarding';
import { optionsForSlot } from '@/lib/connectors/preset-mapping';
import { SettingsAdvancedSection } from '@/components/settings/settings-advanced-section';
import { AIProvidersSection } from '@/components/ai/ai-providers-section';
import { AITaskBackendsSection } from '@/components/ai/ai-task-backends-section';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

type Tab = 'profile' | 'connectors' | 'workspaces' | 'ai' | 'advanced';

const TABS: { id: Tab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'ai', label: 'AI' },
  { id: 'advanced', label: 'Advanced' },
];

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tabParam = (searchParams.get('tab') as Tab) || 'profile';
  const tab: Tab = TABS.some((t) => t.id === tabParam) ? tabParam : 'profile';

  const setTab = (next: Tab) => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set('tab', next);
    if (next !== 'connectors') sp.delete('source');
    router.replace(`${pathname}?${sp.toString()}`);
  };

  return (
    <div className="settings-page">
      <header className="settings-page-head">
        <h1>Settings</h1>
        <p>Configure your workspace, connectors, and integrations.</p>
      </header>

      <nav className="settings-page-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`settings-page-tab ${tab === t.id ? 'on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="settings-page-body">
        {tab === 'profile' && <ProfileTab />}
        {tab === 'connectors' && <ConnectorsTab />}
        {tab === 'workspaces' && <WorkspacesTab onJumpToConnectors={() => setTab('connectors')} />}
        {tab === 'ai' && (
          <>
            <AIProvidersSection />
            <AITaskBackendsSection />
          </>
        )}
        {tab === 'advanced' && <SettingsAdvancedSection />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Profile tab                                                         */
/* ------------------------------------------------------------------ */

function ProfileTab() {
  const { state, setState, activeWorkspace } = useWorkgraphState();
  const [pickRole, setPickRole] = useState(state.role);
  const [pickSource, setPickSource] = useState(state.source);
  const [pickTheme, setPickTheme] = useState<Theme>(state.theme);
  const [pickDark, setPickDark] = useState(state.dark);

  useEffect(() => {
    setPickRole(state.role);
    setPickSource(state.source);
    setPickTheme(state.theme);
    setPickDark(state.dark);
  }, [state]);

  const roles = activeWorkspace.ui?.roles?.length
    ? activeWorkspace.ui.roles
    : [{ id: 'workspace_user', label: 'Workspace User', description: 'Uses this workspace', primarySource: state.source }];
  const role = roles.find((r) => r.id === pickRole) ?? roles[0];
  const terminology = activeWorkspace.ui?.terminology ?? {};
  const sources = [...new Set(roles.map((r) => r.primarySource).filter((s): s is string => Boolean(s)))];

  const apply = () => {
    setState({ role: pickRole, source: pickSource, theme: pickTheme, dark: pickDark });
  };

  return (
    <div className="settings-tab-pad grid gap-6">
      <section className="modal-section" style={{ borderBottom: 'none', padding: 0 }}>
        <div className="modal-section-head">
          <h3>Role</h3>
          <span className="modal-hint">{roles.length} configured</span>
        </div>
        <div className="role-grid">
          {roles.map((r) => {
            const on = pickRole === r.id;
            return (
              <button
                key={r.id}
                type="button"
                className={`role-card ${on ? 'on' : ''}`}
                onClick={() => {
                  setPickRole(r.id);
                  if (r.primarySource) setPickSource(r.primarySource);
                }}
              >
                <div className="role-card-head">
                  <span className="role-card-label">{r.label}</span>
                  {on && <span className="role-card-check">●</span>}
                </div>
                <div className="role-card-sub">{r.description || 'Configured workspace role'}</div>
                {r.primarySource && (
                  <div className="role-card-srcs">
                    <span className="role-card-src primary">{r.primarySource}</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="modal-section" style={{ borderBottom: 'none', padding: 0 }}>
        <div className="modal-section-head">
          <h3>Primary {terminology.source?.toLowerCase() || 'source'}</h3>
        </div>
        <div className="source-row">
          {(sources.length ? sources : [pickSource]).map((s) => (
            <button
              key={s}
              type="button"
              className={`source-chip ${pickSource === s ? 'on' : ''}`}
              onClick={() => setPickSource(s)}
            >
              <span className="source-chip-dot" />
              {s}
              {s === role.primarySource && <span className="source-chip-default">default</span>}
            </button>
          ))}
        </div>
      </section>

      <section className="modal-section" style={{ borderBottom: 'none', padding: 0 }}>
        <div className="modal-section-head">
          <h3>Appearance</h3>
        </div>
        <div className="appearance-row">
          <div className="appearance-group">
            <div className="appearance-label">Theme</div>
            <div className="appearance-choices">
              {([{ id: 'warm', label: 'Warm', sub: 'Bone + paper' }, { id: 'mono', label: 'Mono', sub: 'Black + white' }] as const).map((t) => (
                <button key={t.id} type="button" className={`appearance-chip ${pickTheme === t.id ? 'on' : ''}`} onClick={() => setPickTheme(t.id)}>
                  <span className={`appearance-swatch swatch-${t.id}${pickDark ? ' is-dark' : ''}`} aria-hidden><i /><i /></span>
                  <span className="appearance-chip-text">
                    <span className="appearance-chip-label">{t.label}</span>
                    <span className="appearance-chip-sub">{t.sub}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="appearance-group">
            <div className="appearance-label">Mode</div>
            <div className="appearance-choices">
              {([{ id: false, label: 'Light' }, { id: true, label: 'Dark' }] as const).map((m) => (
                <button key={String(m.id)} type="button" className={`appearance-chip ${pickDark === m.id ? 'on' : ''}`} onClick={() => setPickDark(m.id)}>
                  <span className={`appearance-swatch swatch-${m.id ? 'dark' : 'light'}`} aria-hidden><i /><i /></span>
                  <span className="appearance-chip-text">
                    <span className="appearance-chip-label">{m.label}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <button className="btn btn-primary" onClick={apply}>Apply changes</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Connectors tab — master/detail                                      */
/* ------------------------------------------------------------------ */

function ConnectorsTab() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { activeWorkspace } = useWorkgraphState();

  const presetConnectors = useMemo(() => {
    const preset = WORKSPACE_PRESETS.find((p) => p.id === activeWorkspace.preset)
      ?? WORKSPACE_PRESETS.find((p) => p.id === 'custom-workspace')!;
    return preset.connectors;
  }, [activeWorkspace.preset]);

  const suggestedSources = useMemo<string[]>(() => {
    const out: string[] = [];
    for (const slot of presetConnectors) {
      const opt = optionsForSlot(slot).find((o) => o.status === 'available');
      if (opt) out.push(opt.source);
    }
    return out;
  }, [presetConnectors]);

  const selected = searchParams.get('source');
  const [savedRow, setSavedRow] = useState<SavedConnectorRow | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // When the selected source changes, fetch its full saved row (for the panel).
  useEffect(() => {
    if (!selected) { setSavedRow(null); return; }
    let cancelled = false;
    fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/connectors`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const row = (d.configs || []).find((c: any) => c.source === selected);
        setSavedRow(row || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeWorkspace.id, selected, refreshNonce]);

  const setSelected = (source: string | null) => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set('tab', 'connectors');
    if (source) sp.set('source', source);
    else sp.delete('source');
    router.replace(`${pathname}?${sp.toString()}`);
  };

  const handleChanged = () => setRefreshNonce((n) => n + 1);

  return (
    <div className="settings-connectors-grid">
      <div className="settings-connectors-list">
        <ConnectorDirectory
          workspaceId={activeWorkspace.id}
          suggestedSources={suggestedSources}
          onSelectSource={setSelected}
          selectedSource={selected}
          refreshNonce={refreshNonce}
        />
        <CrossrefControl workspaceId={activeWorkspace.id} onChanged={handleChanged} />
      </div>
      <aside className="settings-connectors-panel">
        {selected ? (
          <ConnectorDetailPanel
            workspaceId={activeWorkspace.id}
            source={selected}
            saved={savedRow}
            onChanged={handleChanged}
            onClose={() => setSelected(null)}
          />
        ) : (
          <div className="settings-connectors-empty">
            <div className="settings-connectors-empty-title">Pick a connector</div>
            <div className="settings-connectors-empty-sub">
              Click any card on the left to configure, install, sync, or clean up its data.
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Workspaces tab                                                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Cross-source link recompute control                                 */
/* ------------------------------------------------------------------ */

function CrossrefControl({ workspaceId, onChanged }: { workspaceId: string; onChanged: () => void }) {
  const [busy, setBusy] = useState<'incremental' | 'full' | null>(null);
  const [result, setResult] = useState<{ items?: number; links?: number; mode?: string; error?: string } | null>(null);
  const [confirmFull, setConfirmFull] = useState(false);

  const run = async (mode: 'incremental' | 'full') => {
    setBusy(mode);
    setResult(null);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/crossref?mode=${mode}`,
        { method: 'POST' },
      );
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'crossref failed');
      setResult({ items: data.items, links: data.links, mode });
      onChanged();
    } catch (err: any) {
      setResult({ error: err.message });
    } finally {
      setBusy(null);
      setConfirmFull(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-black/[0.07] bg-white p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[#222]">Cross-source relationships</div>
          <div className="text-xs text-[#666] mt-0.5">
            Find references between items across connectors (PR ↔ Jira ticket, Slack thread ↔ ticket, Notion doc ↔ PR).
            Auto-runs after each sync for new items — recompute manually after enabling new connectors or backfilling history.
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            className="btn btn-ghost text-xs"
            onClick={() => run('incremental')}
            disabled={busy !== null}
          >
            {busy === 'incremental' ? 'Linking…' : 'Recompute (recent)'}
          </button>
          <button
            type="button"
            className="btn btn-ghost text-xs"
            onClick={() => setConfirmFull(true)}
            disabled={busy !== null}
            title="Drop existing soft links and recompute everything"
          >
            {busy === 'full' ? 'Linking…' : 'Recompute all'}
          </button>
        </div>
      </div>
      {result && (
        <div className={`mt-3 text-xs px-3 py-2 rounded-md ${
          result.error
            ? 'bg-red-50 text-red-700 border border-red-200'
            : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
        }`}>
          {result.error
            ? `✗ ${result.error}`
            : `✓ ${result.mode === 'full' ? 'Full recompute' : 'Recent recompute'}: processed ${result.items ?? 0} items, ${result.links ?? 0} links upserted`}
        </div>
      )}

      <ConfirmDialog
        open={confirmFull}
        onOpenChange={setConfirmFull}
        title="Recompute all cross-source links?"
        description={
          <span>
            Drops existing <code>mentions</code> / <code>references</code> / <code>discusses</code> / <code>executes</code> /
            {' '}<code>related_code</code> links and rebuilds them across the entire workspace. Structural links
            (<code>in_repo</code>, <code>in_project</code>, <code>child_of</code>, <code>has_release</code>) are kept.
            Takes minutes for large workspaces.
          </span>
        }
        confirmLabel="Recompute all"
        busyLabel="Linking…"
        busy={busy === 'full'}
        onConfirm={() => run('full')}
      />
    </div>
  );
}

function WorkspacesTab({ onJumpToConnectors }: { onJumpToConnectors: () => void }) {
  const { state, setState, workspaces, activeWorkspace, refreshWorkspaces } = useWorkgraphState();
  const [creatingPreset, setCreatingPreset] = useState<string | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmDeleteWorkspace = workspaces.find((w) => w.id === confirmDeleteId);

  const enabledIds = useMemo(
    () => new Set(workspaces.filter((w) => w.enabled !== false).map((w) => w.id)),
    [workspaces],
  );

  const createWorkspace = async (preset: WorkspacePreset) => {
    setCreatingPreset(preset.id);
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: preset.name, preset: preset.id }),
      });
      const data = await res.json();
      if (data.workspace) {
        await refreshWorkspaces();
        const role = data.workspace.ui?.roles?.[0];
        setState({
          workspaceId: data.workspace.id,
          role: role?.id || 'owner',
          source: role?.primarySource || 'Primary System',
        });
        onJumpToConnectors();
      }
    } finally {
      setCreatingPreset(null);
    }
  };

  const requestDelete = (workspaceId: string) => {
    if (workspaceId === 'default') return;
    setConfirmDeleteId(workspaceId);
  };

  const performDelete = async () => {
    const workspaceId = confirmDeleteId;
    if (!workspaceId) return;
    setDeletingWorkspace(workspaceId);
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed to delete');
      const remaining = (data.workspaces || workspaces).filter((c: any) => c.id !== workspaceId && c.enabled !== false);
      await refreshWorkspaces();
      if (state.workspaceId === workspaceId && remaining[0]) {
        const next = remaining[0];
        const role = next.ui?.roles?.[0];
        setState({ workspaceId: next.id, role: role?.id || 'owner', source: role?.primarySource || 'Primary System' });
      }
      setConfirmDeleteId(null);
    } finally {
      setDeletingWorkspace(null);
    }
  };

  return (
    <div className="settings-tab-pad grid gap-4">
      <div className="modal-section-head">
        <h3>Active workspace</h3>
      </div>
      <div className="workspace-active-card">
        <div>
          <div className="workspace-active-name">{activeWorkspace.name}</div>
          <div className="workspace-active-preset">{activeWorkspace.preset}</div>
        </div>
        <button className="btn btn-ghost" onClick={onJumpToConnectors}>Manage connectors →</button>
      </div>

      <div className="modal-section-head">
        <h3>All workspaces</h3>
        <span className="modal-hint">{workspaces.filter((w) => w.enabled !== false).length} active</span>
      </div>
      <div className="config-preset-list">
        {WORKSPACE_PRESETS.map((preset) => {
          const existing = workspaces.find((w) => w.preset === preset.id && w.enabled !== false);
          const alreadyEnabled = enabledIds.has(preset.id) || Boolean(existing);
          const isActive = activeWorkspace.preset === preset.id;
          return (
            <div key={preset.id} className={`config-preset-row ${isActive ? 'on' : ''}`}>
              <button
                type="button"
                className="config-preset"
                disabled={creatingPreset === preset.id}
                onClick={() => {
                  if (existing) {
                    setState({ workspaceId: existing.id });
                    return;
                  }
                  createWorkspace(preset);
                }}
              >
                <span>{preset.name}</span>
                <small>{alreadyEnabled ? 'Configured workspace available' : preset.workflow}</small>
                <em>{creatingPreset === preset.id ? 'Creating...' : alreadyEnabled ? (isActive ? 'Active' : 'Switch') : 'Add'}</em>
              </button>
              {existing && existing.id !== 'default' && (
                <button
                  type="button"
                  className="config-delete-mini"
                  onClick={() => requestDelete(existing.id)}
                  disabled={deletingWorkspace === existing.id}
                >
                  {deletingWorkspace === existing.id ? '...' : 'Delete'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={(open) => !open && setConfirmDeleteId(null)}
        variant="danger"
        title={`Delete workspace${confirmDeleteWorkspace ? ` "${confirmDeleteWorkspace.name}"` : ''}?`}
        description={
          <span>
            This removes the workspace configuration, its connector setups, and any saved
            credentials/OAuth tokens. <strong>Imported source data is kept</strong> — clean it up
            from each connector first if you want to remove that too.
          </span>
        }
        confirmLabel="Delete workspace"
        busyLabel="Deleting…"
        busy={deletingWorkspace === confirmDeleteId}
        onConfirm={performDelete}
      />
    </div>
  );
}
