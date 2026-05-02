'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Settings, Search, X } from 'lucide-react';
import * as SiIcons from 'react-icons/si';
import type { IconType } from 'react-icons';
import { CONNECTOR_PRESETS, type ConnectorPreset, type ConnectorCategory } from '@/lib/connectors/presets';
import type { SavedConnectorRow } from '@/components/connectors/connector-detail-panel';

type SortKey = 'popular' | 'name' | 'recent';
type Filter = 'all' | 'suggested' | 'installed' | ConnectorCategory;

interface ConnectorDirectoryProps {
  workspaceId: string;
  // Source ids that the active workspace's preset suggests, in order. The
  // directory uses these to drive the "Suggested" filter and the popularity
  // ordering when no other filter is active.
  suggestedSources?: string[];
  // Caller decides what happens when a card is clicked (open a panel, navigate, etc.).
  onSelectSource: (source: string) => void;
  // Optional: which source's card should render in the "active/selected" state.
  selectedSource?: string | null;
  // Bump to force a reload of saved connector state (e.g. after install/cleanup).
  refreshNonce?: number;
}

interface SavedRow {
  slot: string;
  source: string;
  transport: 'http' | 'stdio';
  status: 'configured' | 'skipped' | 'error' | 'pending';
  config: any;
  lastError?: string | null;
  updatedAt?: string;
  lastSyncStartedAt?: string | null;
  lastSyncCompletedAt?: string | null;
  lastSyncStatus?: 'running' | 'success' | 'error' | null;
  lastSyncItems?: number | null;
  lastSyncError?: string | null;
  lastSyncLog?: string | null;
}

const CATEGORY_LABEL: Record<ConnectorCategory, string> = {
  tracker: 'Trackers',
  code: 'Code',
  communication: 'Communication',
  document: 'Docs',
  meeting: 'Meetings',
};

export function ConnectorDirectory({
  workspaceId,
  suggestedSources = [],
  onSelectSource,
  selectedSource = null,
  refreshNonce = 0,
}: ConnectorDirectoryProps) {
  const allPresets = useMemo<ConnectorPreset[]>(() => {
    const seen = new Set<ConnectorPreset>();
    for (const p of Object.values(CONNECTOR_PRESETS)) seen.add(p);
    return Array.from(seen);
  }, []);

  const [saved, setSaved] = useState<Record<string, SavedRow>>({});
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>(suggestedSources.length > 0 ? 'suggested' : 'all');
  const [sort, setSort] = useState<SortKey>('popular');

  const loadSaved = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/connectors`);
      const data = await res.json();
      if (!data.ok) return;
      const next: Record<string, SavedRow> = {};
      for (const c of data.configs as SavedRow[]) next[c.source] = c;
      setSaved(next);
    } catch {
      // non-fatal
    }
  }, [workspaceId]);

  useEffect(() => {
    loadSaved();
  }, [loadSaved, refreshNonce]);

  // Poll while any connector is currently syncing.
  useEffect(() => {
    const anyRunning = Object.values(saved).some((s) => s.lastSyncStatus === 'running');
    if (!anyRunning) return;
    const t = setInterval(loadSaved, 2500);
    return () => clearInterval(t);
  }, [saved, loadSaved]);

  const suggestedSet = useMemo(() => new Set(suggestedSources), [suggestedSources]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = allPresets;
    if (filter === 'suggested') list = list.filter((p) => suggestedSet.has(p.source));
    else if (filter === 'installed') list = list.filter((p) => saved[p.source]?.status === 'configured');
    else if (filter !== 'all') list = list.filter((p) => p.category === filter);
    if (q) {
      list = list.filter(
        (p) =>
          p.label.toLowerCase().includes(q)
          || p.blurb.toLowerCase().includes(q)
          || p.source.toLowerCase().includes(q),
      );
    }
    list = [...list].sort((a, b) => {
      if (sort === 'name') return a.label.localeCompare(b.label);
      if (sort === 'recent') {
        const aTime = saved[a.source]?.updatedAt || '';
        const bTime = saved[b.source]?.updatedAt || '';
        return bTime.localeCompare(aTime);
      }
      // popular: suggested first, then by popularity rank, then alphabetical
      const aSuggested = suggestedSet.has(a.source) ? 0 : 1;
      const bSuggested = suggestedSet.has(b.source) ? 0 : 1;
      if (aSuggested !== bSuggested) return aSuggested - bSuggested;
      const aPop = a.popularity ?? 99;
      const bPop = b.popularity ?? 99;
      if (aPop !== bPop) return aPop - bPop;
      return a.label.localeCompare(b.label);
    });
    return list;
  }, [allPresets, filter, search, sort, saved, suggestedSet]);

  const installedCount = Object.values(saved).filter((s) => s.status === 'configured').length;

  const filterChips: { key: Filter; label: string; count?: number }[] = [
    { key: 'all', label: 'All', count: allPresets.length },
    ...(suggestedSources.length > 0 ? [{ key: 'suggested' as Filter, label: 'Suggested', count: suggestedSources.length }] : []),
    ...(installedCount > 0 ? [{ key: 'installed' as Filter, label: 'Installed', count: installedCount }] : []),
    { key: 'tracker', label: 'Trackers' },
    { key: 'code', label: 'Code' },
    { key: 'communication', label: 'Communication' },
    { key: 'document', label: 'Docs' },
    { key: 'meeting', label: 'Meetings' },
  ];

  return (
    <div className="grid gap-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#888]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search connectors..."
          className="w-full h-11 pl-9 pr-9 rounded-xl border border-black/10 bg-white text-sm focus:outline-none focus:border-black/30"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#888] hover:text-black"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex flex-wrap gap-1.5">
          {filterChips.map((c) => {
            const active = filter === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setFilter(c.key)}
                className={[
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
                  active
                    ? 'border-black bg-black text-white'
                    : 'border-black/15 bg-white text-[#444] hover:border-black/40',
                ].join(' ')}
              >
                <span>{c.label}</span>
                {c.count !== undefined && (
                  <span className={active ? 'opacity-80' : 'text-[#999]'}>{c.count}</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2 text-xs text-[#666]">
          <label className="flex items-center gap-1.5">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="h-8 rounded-md border border-black/10 bg-white px-2 text-xs"
            >
              <option value="popular">Most popular</option>
              <option value="name">Name (A–Z)</option>
              <option value="recent">Recently installed</option>
            </select>
          </label>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-sm text-[#999] py-8 text-center border border-dashed border-black/10 rounded-xl">
          No connectors match. Try clearing the search or filter.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 auto-rows-min">
          {filtered.map((preset) => (
            <ConnectorCard
              key={preset.source}
              preset={preset}
              suggested={suggestedSet.has(preset.source)}
              saved={saved[preset.source] || null}
              active={selectedSource === preset.source}
              onClick={() => onSelectSource(preset.source)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ConnectorCardProps {
  preset: ConnectorPreset;
  suggested: boolean;
  saved: SavedRow | null;
  active?: boolean;
  onClick: () => void;
}

function ConnectorCard({ preset, suggested, saved, active, onClick }: ConnectorCardProps) {
  const installed = saved?.status === 'configured';
  const skipped = saved?.status === 'skipped';
  const syncing = saved?.lastSyncStatus === 'running';
  const syncErr = saved?.lastSyncStatus === 'error';

  let subline: { text: string; tone: 'muted' | 'good' | 'warn' | 'accent' } | null = null;
  if (installed && syncing) subline = { text: 'Syncing…', tone: 'accent' };
  else if (installed && syncErr) subline = { text: `Sync failed${saved?.lastSyncError ? `: ${truncate(saved.lastSyncError, 40)}` : ''}`, tone: 'warn' };
  else if (installed && saved?.lastSyncCompletedAt)
    subline = {
      text: `${saved.lastSyncItems ?? 0} item${saved.lastSyncItems === 1 ? '' : 's'} · ${relTime(saved.lastSyncCompletedAt)}`,
      tone: 'good',
    };
  else if (installed) subline = { text: 'Installed', tone: 'good' };
  else if (skipped) subline = { text: 'Skipped', tone: 'muted' };
  else if (suggested) subline = { text: 'Suggested', tone: 'accent' };
  else if (preset.popularity && preset.popularity <= 5) subline = { text: `#${preset.popularity} popular`, tone: 'muted' };

  const sublineClass = subline
    ? subline.tone === 'good'
      ? 'text-emerald-700'
      : subline.tone === 'warn'
      ? 'text-amber-700'
      : subline.tone === 'accent'
      ? 'text-blue-600'
      : 'text-[#888]'
    : '';

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'group text-left rounded-xl border bg-white transition-colors p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-black/30',
        active
          ? 'border-black ring-2 ring-black/20'
          : installed
          ? 'border-emerald-300 bg-emerald-50/30 hover:bg-emerald-50/60'
          : 'border-black/10 hover:border-black/30 hover:bg-black/[0.01]',
      ].join(' ')}
      aria-label={installed ? `Manage ${preset.label}` : `Install ${preset.label}`}
      aria-current={active ? 'true' : undefined}
    >
      <div className="flex items-start gap-3">
        <ConnectorIcon preset={preset} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-sm text-black truncate">{preset.label}</h3>
            {preset.badge === 'new' && (
              <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-amber-100 text-amber-700">
                New
              </span>
            )}
            {preset.badge === 'trending' && (
              <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-purple-100 text-purple-700">
                ↗ Trending
              </span>
            )}
            {preset.status === 'guided' && !installed && (
              <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-amber-50 text-amber-700">
                Guided
              </span>
            )}
          </div>
          {subline && <div className={`text-[11px] mt-0.5 ${sublineClass}`}>{subline.text}</div>}
        </div>
        <span
          className={[
            'shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full transition-colors',
            installed
              ? 'border border-emerald-300 text-emerald-700 group-hover:bg-emerald-50'
              : 'border border-black/10 text-[#444] group-hover:border-black/40 group-hover:text-black',
          ].join(' ')}
          aria-hidden
        >
          {installed ? <Settings className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
        </span>
      </div>
      <p className="text-xs text-[#666] mt-2 leading-relaxed">{preset.blurb}</p>
    </button>
  );
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function ConnectorIcon({ preset }: { preset: ConnectorPreset }) {
  const Icon: IconType | undefined = preset.iconKey
    ? (SiIcons as unknown as Record<string, IconType>)[preset.iconKey]
    : undefined;

  if (!Icon) {
    return (
      <div
        className="shrink-0 w-10 h-10 rounded-lg grid place-items-center text-white font-semibold text-[13px] tracking-tight"
        style={{ background: preset.brandHex }}
        aria-hidden
      >
        {preset.monogram}
      </div>
    );
  }

  return (
    <div
      className="shrink-0 w-10 h-10 rounded-lg grid place-items-center bg-white border border-black/[0.06]"
      aria-hidden
    >
      <Icon size={22} color={preset.brandHex} />
    </div>
  );
}
