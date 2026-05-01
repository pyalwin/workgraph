'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, ChevronDown, ChevronUp, RefreshCw, X } from 'lucide-react';
import * as SiIcons from 'react-icons/si';
import type { IconType } from 'react-icons';
import { getPreset, presetFieldsToPayload, type ConnectorPreset } from '@/lib/connectors/presets';
import { connectors as connectorRegistry } from '@/lib/connectors/registry';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export interface SavedConnectorRow {
  slot: string;
  source: string;
  transport: 'http' | 'stdio';
  status: 'configured' | 'skipped' | 'error' | 'pending';
  config: {
    url?: string;
    command?: string;
    args?: string[];
    token?: string;
    options?: Record<string, unknown>;
  };
  lastError?: string | null;
  lastTestedAt?: string | null;
  lastSyncStartedAt?: string | null;
  lastSyncCompletedAt?: string | null;
  lastSyncStatus?: 'running' | 'success' | 'error' | null;
  lastSyncItems?: number | null;
  lastSyncError?: string | null;
  lastSyncLog?: string | null;
}

export interface ConnectorDetailPanelProps {
  workspaceId: string;
  source: string;
  saved: SavedConnectorRow | null;
  onChanged: () => void;
  onClose?: () => void;     // optional — renders an X in the header when provided
  className?: string;
}

interface DataStats {
  itemCount: number;
  oldestSyncedAt: string | null;
  newestSyncedAt: string | null;
  sharedWith: string[];
}

export function ConnectorDetailPanel({
  workspaceId,
  source,
  saved,
  onChanged,
  onClose,
  className = '',
}: ConnectorDetailPanelProps) {
  const preset = getPreset(source);
  const [values, setValues] = useState<Record<string, string>>({});
  const [installing, setInstalling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPatFallback, setShowPatFallback] = useState(false);
  const [dataStats, setDataStats] = useState<DataStats | null>(null);
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [discoveredCache, setDiscoveredCache] = useState<Record<string, { id: string; label: string; hint?: string }[]>>({});
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [confirmFullResync, setConfirmFullResync] = useState(false);

  useEffect(() => {
    const next: Record<string, string> = {};
    if (saved?.config?.options && preset) {
      for (const f of preset.fields) {
        if (f.type === 'password') continue;
        const v = (saved.config.options as Record<string, unknown>)[f.name];
        if (typeof v === 'string') next[f.name] = v;
      }
    }
    setValues(next);
    setError(null);
    setTestMsg(null);
    setShowAdvanced(false);
    setShowPatFallback(false);
  }, [source, saved, preset]);

  useEffect(() => {
    let cancelled = false;
    if (!saved) { setDataStats(null); return; }
    fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(saved.slot)}/data`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d.ok) setDataStats(d.stats); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [workspaceId, saved?.slot, saved?.lastSyncCompletedAt]);

  if (!preset) {
    return <div className={`p-6 text-sm text-red-600 ${className}`}>Unknown connector: {source}</div>;
  }

  const slotKey = saved?.slot || preset.source;
  const installed = saved?.status === 'configured';
  const supportedLists = connectorRegistry[source]?.supportedLists ?? [];
  const usesOAuth = (saved?.config?.options as any)?.oauth === true;
  const oauthAvailable = Boolean(preset.oauth);
  const oauthStartHref = oauthAvailable
    ? `/api/oauth/start?source=${encodeURIComponent(preset.source)}&workspace=${encodeURIComponent(workspaceId)}&slot=${encodeURIComponent(slotKey)}`
    : null;

  // Hydrate discovered cache from the saved row's options.discovered, if present.
  const savedDiscovered = (saved?.config?.options as any)?.discovered as Record<string, any[]> | undefined;

  const install = async () => {
    const missing = preset.fields.filter((f) => {
      if (!f.required) return false;
      if (installed && f.type === 'password') return false;
      return !(values[f.name] ?? '').trim();
    });
    if (missing.length) {
      setError(`Missing: ${missing.map((m) => m.label).join(', ')}`);
      return;
    }
    setInstalling(true);
    setError(null);
    setTestMsg(null);
    try {
      const payload = presetFieldsToPayload(preset, values);
      const body: any = { slot: slotKey, source: preset.source, transport: payload.transport };
      if (payload.url) body.url = payload.url;
      if (payload.token && payload.transport === 'http') body.token = payload.token;
      if (payload.command) body.command = payload.command;
      if (payload.args) body.args = payload.args;
      if (payload.options) body.options = payload.options;

      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Install failed');
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setInstalling(false);
    }
  };

  const sync = async (mode: 'incremental' | 'full' = 'incremental') => {
    setSyncing(true);
    try {
      const body: any = { action: 'sync' };
      if (mode === 'full') body.since = 'full';
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(slotKey)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
      const data = await res.json();
      if (!data.ok) setError(data.error || 'Failed to start sync');
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(slotKey)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'test' }) },
      );
      const data = await res.json();
      setTestMsg(data.ok ? '✓ Connected to MCP server' : `✗ ${data.error || 'Failed'}`);
    } catch (err: any) {
      setTestMsg(`✗ ${err.message}`);
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(slotKey)}`,
        { method: 'DELETE' },
      );
      setConfirmDisconnect(false);
      onChanged();
      onClose?.();
    } finally {
      setRemoving(false);
    }
  };

  const discoverList = async (listName: string) => {
    setDiscovering(listName);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(slotKey)}/discover?list=${encodeURIComponent(listName)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Discovery failed');
      setDiscoveredCache((prev) => ({ ...prev, [listName]: data.options }));
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDiscovering(null);
    }
  };

  const toggleScope = async (mapsToOption: string, id: string) => {
    if (!installed) return;
    const currentSelection = ((saved?.config?.options as any)?.[mapsToOption] as string[] | undefined) ?? [];
    const next = currentSelection.includes(id)
      ? currentSelection.filter((s) => s !== id)
      : [...currentSelection, id];

    // Persist via the install endpoint with merge semantics.
    setError(null);
    try {
      const updatedOptions = { ...(saved?.config?.options || {}), [mapsToOption]: next };
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slot: slotKey,
          source: preset.source,
          transport: saved?.transport ?? preset.transport,
          ...(saved?.config?.url ? { url: saved.config.url } : {}),
          ...(saved?.config?.command ? { command: saved.config.command } : {}),
          ...(saved?.config?.args ? { args: saved.config.args } : {}),
          options: updatedOptions,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed to save scope');
      onChanged();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const cleanup = async () => {
    const shared = dataStats?.sharedWith ?? [];
    setCleaning(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(slotKey)}/data`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Cleanup failed');
      setDataStats({ itemCount: 0, oldestSyncedAt: null, newestSyncedAt: null, sharedWith: shared });
      setConfirmCleanup(false);
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className={`flex flex-col bg-white flex-1 min-h-0 h-full ${className}`}>
      <header className="px-6 pt-5 pb-4 border-b border-black/[0.07] flex items-start gap-4 shrink-0">
        <DetailIcon preset={preset} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-semibold text-black truncate">{preset.label}</h2>
            {installed && <Pill tone="emerald">Installed</Pill>}
            {preset.badge === 'new' && <Pill tone="amber">New</Pill>}
            <Pill tone="muted">{capitalize(preset.category)}</Pill>
            <Pill tone={preset.status === 'one-click' ? 'emerald-soft' : 'amber-soft'}>
              {preset.status === 'one-click' ? 'One-click' : 'Guided'}
            </Pill>
          </div>
          <p className="text-sm text-[#555] mt-1.5 leading-relaxed">{preset.blurb}</p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 -mr-1 -mt-1 w-8 h-8 grid place-items-center rounded-full hover:bg-black/[0.05] text-[#555]"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 grid gap-6">
        {preset.features && preset.features.length > 0 && (
          <Section title="What you'll get">
            <ul className="grid gap-1.5 text-sm text-[#333]">
              {preset.features.map((f, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-emerald-600 mt-[3px]">▪</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {oauthStartHref && !usesOAuth && (
          <Section title={installed ? 'Switch to OAuth' : 'Connect with OAuth'}>
            <div className="grid gap-2 text-sm">
              <p className="text-[#555]">
                One-click sign-in with your {preset.label} account — no API tokens to paste, scoped permissions, refreshes automatically.
              </p>
              <a
                href={oauthStartHref}
                className="btn btn-primary self-start"
              >
                Connect with {preset.label} →
              </a>
              <small className="text-[11px] text-[#888]">
                You'll be redirected to {preset.label} to grant access, then back here.
              </small>
            </div>
          </Section>
        )}

        {usesOAuth && (
          <Section title="OAuth connection">
            <div className="text-xs px-3 py-2 rounded-md border bg-emerald-50 border-emerald-200 text-emerald-800">
              ✓ Connected via OAuth — tokens refresh automatically. To revoke, click Disconnect.
            </div>
          </Section>
        )}

        {!usesOAuth && (() => {
          // When OAuth is the recommended path, hide the credential form
          // by default — surface it as a collapsible "Use API token instead".
          // When there's no OAuth option, the form is the primary path.
          const sectionTitle = installed
            ? 'Manage credentials'
            : oauthAvailable
            ? 'Use API token instead'
            : 'Setup';
          const credentialFields = (
            <>
              {preset.setupSteps && preset.setupSteps.length > 0 && (
                <ol className="text-xs text-[#666] list-decimal pl-4 space-y-1 mb-3">
                  {preset.setupSteps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              )}
              {preset.authLink && (
                <a
                  href={preset.authLink.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:underline mb-4"
                >
                  {preset.authLink.label}
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
              <div className="grid gap-3">
                {preset.fields.map((f) => {
                  const isSecret = f.type === 'password';
                  const showOptional = installed && isSecret;
                  const placeholder = showOptional ? '•••• (leave blank to keep saved value)' : f.placeholder;
                  return (
                    <label key={f.name} className="grid gap-1">
                      <span className="text-xs text-[#444] font-medium">
                        {f.label}
                        {f.required && !showOptional && <span className="text-red-500"> *</span>}
                      </span>
                      <input
                        type={isSecret ? 'password' : 'text'}
                        className="h-10 px-3 rounded-md border border-black/10 bg-white text-sm focus:outline-none focus:border-black/40"
                        placeholder={placeholder}
                        value={values[f.name] ?? ''}
                        onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                      />
                      {f.helpText && <small className="text-[11px] text-[#888]">{f.helpText}</small>}
                    </label>
                  );
                })}
              </div>
            </>
          );

          // Collapsed-by-default when OAuth is the primary recommendation AND not yet installed.
          if (oauthAvailable && !installed) {
            return (
              <section>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-[#666] hover:text-black"
                  onClick={() => setShowPatFallback((v) => !v)}
                >
                  {showPatFallback ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  {sectionTitle}
                </button>
                {showPatFallback && (
                  <div className="mt-3 pt-3 border-t border-black/[0.06]">
                    <p className="text-xs text-[#888] mb-3">
                      OAuth is the recommended way to connect — but you can paste an API token if you prefer.
                    </p>
                    {credentialFields}
                  </div>
                )}
              </section>
            );
          }

          // Normal: shown directly (no OAuth alternative, OR already installed)
          return <Section title={sectionTitle}>{credentialFields}</Section>;
        })()}

        <section>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-[#666] hover:text-black"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            Advanced settings
          </button>
          {showAdvanced && (
            <div className="mt-2 text-xs text-[#666] bg-black/[0.02] p-3 rounded-md grid gap-3">
              <div className="grid gap-1.5 font-mono">
                <div><span className="text-[#999]">Source:</span> {preset.source}</div>
                <div><span className="text-[#999]">Transport:</span> {preset.transport}</div>
                {preset.http && <div className="break-all"><span className="text-[#999]">URL:</span> {preset.http.url}</div>}
                {preset.stdio && (
                  <div className="break-all">
                    <span className="text-[#999]">Command:</span> {preset.stdio.command} {preset.stdio.args.join(' ')}
                  </div>
                )}
              </div>
              {installed && (
                <BackfillFromControl
                  workspaceId={workspaceId}
                  slotKey={slotKey}
                  source={preset.source}
                  saved={saved}
                  transport={saved?.transport ?? preset.transport}
                  onChanged={onChanged}
                />
              )}
            </div>
          )}
        </section>

        {installed && supportedLists.length > 0 && (
          <Section title="Scope">
            {supportedLists.map((list) => {
              const cached = discoveredCache[list.id] || savedDiscovered?.[list.id] || [];
              const selected = ((saved?.config?.options as any)?.[list.mapsToOption] as string[] | undefined) ?? [];
              const isLoading = discovering === list.id;
              return (
                <div key={list.id} className="grid gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-[#333]">{list.label}</div>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs text-[#666] hover:text-black"
                      onClick={() => discoverList(list.id)}
                      disabled={isLoading || installing}
                      title="Fetch latest list from MCP"
                    >
                      <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
                      {cached.length > 0 ? 'Refresh' : 'Discover'}
                    </button>
                  </div>
                  {list.helpText && <small className="text-[11px] text-[#888]">{list.helpText}</small>}
                  {cached.length === 0 ? (
                    <div className="text-xs text-[#888] italic px-3 py-3 rounded-md bg-black/[0.02] border border-dashed border-black/10">
                      {isLoading ? 'Fetching from MCP…' : `No ${list.label.toLowerCase()} discovered yet — click Discover.`}
                    </div>
                  ) : (
                    <div className="max-h-48 overflow-y-auto rounded-md border border-black/10 bg-white divide-y divide-black/[0.05]">
                      {cached.map((opt) => {
                        const checked = selected.includes(opt.id);
                        return (
                          <label key={opt.id} className="flex items-start gap-2 px-3 py-2 hover:bg-black/[0.02] cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleScope(list.mapsToOption, opt.id)}
                              className="mt-0.5"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-[#222] truncate">{opt.label}</div>
                              {opt.hint && <div className="text-[11px] text-[#888] truncate">{opt.hint}</div>}
                            </div>
                            <span className="text-[10px] text-[#999] font-mono shrink-0">{opt.id}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {selected.length > 0 && (
                    <div className="text-[11px] text-[#666]">
                      {selected.length} selected · sync will scope to: {selected.slice(0, 5).join(', ')}{selected.length > 5 ? `, +${selected.length - 5} more` : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </Section>
        )}

        {installed && (
          <Section title="Sync">
            <div className="text-xs px-3 py-2 rounded-md border bg-black/[0.02] grid gap-1">
              {saved?.lastSyncStatus === 'running' && <div className="text-blue-700">⟳ Syncing now…</div>}
              {saved?.lastSyncStatus === 'success' && saved?.lastSyncCompletedAt && (
                <div className="text-emerald-700">
                  ✓ Last sync: {saved.lastSyncItems ?? 0} item{saved.lastSyncItems === 1 ? '' : 's'} · {new Date(saved.lastSyncCompletedAt).toLocaleString()}
                </div>
              )}
              {saved?.lastSyncStatus === 'error' && (
                <div className="text-red-700">
                  ✗ Last sync failed{saved?.lastSyncError ? `: ${saved.lastSyncError}` : ''}
                </div>
              )}
              {!saved?.lastSyncStatus && <div className="text-[#666]">No syncs yet — click Sync now to fetch data.</div>}
            </div>
            {saved?.lastSyncLog && (
              <details className="mt-2">
                <summary className="text-xs text-[#666] hover:text-black cursor-pointer">
                  Show log ({saved.lastSyncLog.split('\n').length} lines)
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto bg-black text-emerald-300 text-[11px] leading-snug p-3 rounded-md font-mono whitespace-pre-wrap break-words">
{saved.lastSyncLog}
                </pre>
              </details>
            )}

            <div className="flex items-center justify-between gap-2 mt-3 pt-2 border-t border-black/[0.06]">
              <small className="text-[11px] text-[#888]">
                Adding new scope (e.g. a new project)? Run a full resync to backfill it.
              </small>
              <button
                type="button"
                className="text-xs text-[#666] hover:text-black"
                onClick={() => setConfirmFullResync(true)}
                disabled={syncing || installing || saved?.lastSyncStatus === 'running'}
                title="Backfill all data from scratch (ignores last sync timestamp)"
              >
                Resync from scratch
              </button>
            </div>
          </Section>
        )}

        {installed && (
          <Section title="Data">
            <div className="text-xs px-3 py-2 rounded-md border bg-black/[0.02] grid gap-2">
              <div className="text-[#333]">
                {dataStats === null ? (
                  <span className="text-[#888]">Loading…</span>
                ) : dataStats.itemCount === 0 ? (
                  <span className="text-[#888]">No items synced yet for this source.</span>
                ) : (
                  <>
                    <strong>{dataStats.itemCount.toLocaleString()}</strong> item{dataStats.itemCount === 1 ? '' : 's'} stored
                    {dataStats.oldestSyncedAt && dataStats.newestSyncedAt && (
                      <span className="text-[#999]">
                        {' '}· first {new Date(dataStats.oldestSyncedAt).toLocaleDateString()}, latest {new Date(dataStats.newestSyncedAt).toLocaleDateString()}
                      </span>
                    )}
                  </>
                )}
              </div>
              {dataStats && dataStats.sharedWith.length > 0 && (
                <div className="text-[11px] px-2 py-1.5 rounded bg-amber-50 border border-amber-200 text-amber-800 leading-snug">
                  ⚠ Shared with {dataStats.sharedWith.length} other workspace{dataStats.sharedWith.length === 1 ? '' : 's'}
                  {' '}({dataStats.sharedWith.slice(0, 3).join(', ')}{dataStats.sharedWith.length > 3 ? `, +${dataStats.sharedWith.length - 3} more` : ''}).
                  {' '}Cleanup here removes the data from those workspaces too.
                </div>
              )}
              {dataStats && dataStats.itemCount > 0 && (
                <div className="flex items-center justify-between gap-2 pt-1">
                  <small className="text-[#888]">Removes synced items, versions, tags, links, and chunks.</small>
                  <button
                    type="button"
                    className="btn btn-ghost text-red-600 text-xs"
                    onClick={() => setConfirmCleanup(true)}
                    disabled={cleaning || syncing || installing}
                  >
                    {cleaning ? 'Cleaning…' : 'Clean up data'}
                  </button>
                </div>
              )}
            </div>
          </Section>
        )}

        {(testMsg || error || saved?.lastError) && (
          <section className="grid gap-2">
            {testMsg && (
              <div className={`text-xs px-3 py-2 rounded-md ${
                testMsg.startsWith('✓')
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-red-50 text-red-700 border border-red-200'
              }`}>
                {testMsg}
              </div>
            )}
            {error && (
              <div className="text-xs px-3 py-2 rounded-md bg-red-50 text-red-700 border border-red-200">{error}</div>
            )}
            {saved?.lastError && !error && (
              <div className="text-xs px-3 py-2 rounded-md bg-amber-50 text-amber-800 border border-amber-200">
                Last connection error: {saved.lastError}
              </div>
            )}
          </section>
        )}
      </div>

      <footer className="px-6 py-4 border-t border-black/[0.07] flex items-center gap-2 bg-white shrink-0">
        {installed && (
          <button
            type="button"
            className="btn btn-ghost text-red-600"
            onClick={() => setConfirmDisconnect(true)}
            disabled={removing || installing}
          >
            {removing ? 'Disconnecting…' : 'Disconnect'}
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {installed && (
            <>
              <button type="button" className="btn btn-ghost" onClick={test} disabled={testing || installing}>
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => sync('incremental')}
                disabled={syncing || installing || saved?.lastSyncStatus === 'running'}
                title="Run a sync now"
              >
                {syncing || saved?.lastSyncStatus === 'running' ? 'Syncing…' : 'Sync now'}
              </button>
            </>
          )}
          <button type="button" className="btn btn-primary" onClick={install} disabled={installing}>
            {installing ? (installed ? 'Updating…' : 'Installing…') : installed ? 'Update' : 'Install'}
          </button>
        </div>
      </footer>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        variant="danger"
        title={`Disconnect ${preset.label}?`}
        description={
          <span>
            This removes the connector configuration and any saved credentials/OAuth tokens.
            {' '}<strong>Synced data is kept</strong> — to remove that too, use "Clean up data" first.
          </span>
        }
        confirmLabel="Disconnect"
        busyLabel="Disconnecting…"
        busy={removing}
        onConfirm={remove}
      />

      <ConfirmDialog
        open={confirmFullResync}
        onOpenChange={setConfirmFullResync}
        title={`Resync ${preset.label} from scratch?`}
        description={
          <span>
            Ignores the incremental "last synced" timestamp and re-fetches everything matching your current scope.
            Use this after adding a new project/repo/channel to scope, or if the data looks incomplete.
            It does <strong>not</strong> wipe existing items — duplicates are deduplicated by id, and changed items are versioned.
          </span>
        }
        confirmLabel="Run full resync"
        busyLabel="Starting…"
        busy={syncing}
        onConfirm={async () => { await sync('full'); setConfirmFullResync(false); }}
      />

      <ConfirmDialog
        open={confirmCleanup}
        onOpenChange={setConfirmCleanup}
        variant="danger"
        title={`Delete ${(dataStats?.itemCount ?? 0).toLocaleString()} synced item${dataStats?.itemCount === 1 ? '' : 's'}?`}
        description={
          <>
            <p>
              This permanently removes items, version history, tags, links, and chunks from <strong>{preset.label}</strong>.
              The connector configuration stays — you can re-sync to pull data again.
            </p>
          </>
        }
        warning={
          dataStats && dataStats.sharedWith.length > 0
            ? `This data is shared with ${dataStats.sharedWith.length} other workspace${dataStats.sharedWith.length === 1 ? '' : 's'} (${dataStats.sharedWith.slice(0, 3).join(', ')}${dataStats.sharedWith.length > 3 ? `, +${dataStats.sharedWith.length - 3} more` : ''}). Cleanup here removes it from those workspaces too.`
            : undefined
        }
        confirmLabel="Delete data"
        busyLabel="Cleaning…"
        busy={cleaning}
        onConfirm={cleanup}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-[#888] font-semibold mb-2">{title}</h3>
      {children}
    </section>
  );
}

function Pill({ tone, children }: { tone: 'emerald' | 'amber' | 'muted' | 'emerald-soft' | 'amber-soft'; children: React.ReactNode }) {
  const cls = {
    emerald: 'bg-emerald-100 text-emerald-700',
    amber: 'bg-amber-100 text-amber-700',
    muted: 'bg-black/[0.05] text-[#555]',
    'emerald-soft': 'bg-emerald-50 text-emerald-700',
    'amber-soft': 'bg-amber-50 text-amber-700',
  }[tone];
  return <span className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 ${cls}`}>{children}</span>;
}

function DetailIcon({ preset }: { preset: ConnectorPreset }) {
  const Icon: IconType | undefined = preset.iconKey
    ? (SiIcons as unknown as Record<string, IconType>)[preset.iconKey]
    : undefined;
  if (!Icon) {
    return (
      <div
        className="shrink-0 w-12 h-12 rounded-xl grid place-items-center text-white font-semibold text-base tracking-tight"
        style={{ background: preset.brandHex }}
        aria-hidden
      >
        {preset.monogram}
      </div>
    );
  }
  return (
    <div className="shrink-0 w-12 h-12 rounded-xl grid place-items-center bg-white border border-black/[0.08]" aria-hidden>
      <Icon size={28} color={preset.brandHex} />
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface BackfillFromControlProps {
  workspaceId: string;
  slotKey: string;
  source: string;
  saved: SavedConnectorRow | null;
  transport: 'http' | 'stdio';
  onChanged: () => void;
}

function BackfillFromControl({ workspaceId, slotKey, source, saved, transport, onChanged }: BackfillFromControlProps) {
  const current = (saved?.config?.options as any)?.backfillFrom as string | undefined;
  const initialMode = current === 'all' ? 'all' : current ? 'custom' : 'default';
  const [mode, setMode] = useState<'default' | 'custom' | 'all'>(initialMode);
  const [date, setDate] = useState(current && current !== 'all' ? current : '2026-01-01');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // Re-sync local state if saved changes externally (e.g. after install/cleanup polling)
  useEffect(() => {
    const next = (saved?.config?.options as any)?.backfillFrom as string | undefined;
    setMode(next === 'all' ? 'all' : next ? 'custom' : 'default');
    if (next && next !== 'all') setDate(next);
  }, [saved?.config?.options]);

  const save = async () => {
    setSaving(true);
    setSavedMsg(null);
    try {
      const value = mode === 'all' ? 'all' : mode === 'custom' ? date : ''; // '' = remove the override
      const nextOptions = { ...(saved?.config?.options || {}) } as Record<string, unknown>;
      if (value) nextOptions.backfillFrom = value;
      else delete nextOptions.backfillFrom;

      const body: any = { slot: slotKey, source, transport, options: nextOptions };
      if (saved?.config?.url) body.url = saved.config.url;
      if (saved?.config?.command) body.command = saved.config.command;
      if (saved?.config?.args) body.args = saved.config.args;

      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Save failed');
      setSavedMsg('Saved — applies on next sync');
      onChanged();
    } catch (err: any) {
      setSavedMsg(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-2 pt-2 border-t border-black/[0.07]">
      <div className="font-sans text-[11px] uppercase tracking-wide text-[#888] font-semibold">Backfill window</div>
      <div className="font-sans flex items-center gap-3 flex-wrap text-xs text-[#444]">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" checked={mode === 'default'} onChange={() => setMode('default')} />
          Default (2026-01-01)
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" checked={mode === 'custom'} onChange={() => setMode('custom')} />
          From date:
          <input
            type="date"
            value={date}
            onChange={(e) => { setDate(e.target.value); setMode('custom'); }}
            className="h-7 px-1.5 rounded border border-black/10 text-xs font-sans"
          />
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} />
          Sync all history
        </label>
      </div>
      <div className="flex items-center gap-3 font-sans">
        <button
          type="button"
          className="btn btn-ghost text-xs !py-1"
          onClick={save}
          disabled={saving || (mode === 'custom' && !date)}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedMsg && (
          <small className={savedMsg.startsWith('Error') ? 'text-red-600' : 'text-emerald-700'}>
            {savedMsg}
          </small>
        )}
        <small className="text-[#888] ml-auto">
          Per-project incremental still wins for projects that already have items.
        </small>
      </div>
    </div>
  );
}
