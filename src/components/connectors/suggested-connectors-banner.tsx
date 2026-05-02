'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useWorkgraphState } from '@/components/workspace/workgraph-state';
import { WORKSPACE_PRESETS } from '@/components/workspace/workspace-onboarding';
import { optionsForSlot } from '@/lib/connectors/preset-mapping';
import { CONNECTOR_PRESETS } from '@/lib/connectors/presets';

interface SavedRow {
  source: string;
  status: 'configured' | 'skipped' | 'error' | 'pending';
}

export function SuggestedConnectorsBanner() {
  const { activeWorkspace } = useWorkgraphState();
  const [installed, setInstalled] = useState<Record<string, SavedRow>>({});
  const [dismissed, setDismissed] = useState(false);

  const dismissKey = `wg-banner-dismissed-${activeWorkspace.id}`;

  const suggestedSources = useMemo<string[]>(() => {
    const preset = WORKSPACE_PRESETS.find((p) => p.id === activeWorkspace.preset)
      ?? WORKSPACE_PRESETS.find((p) => p.id === 'custom-workspace')!;
    const out: string[] = [];
    for (const slot of preset.connectors) {
      const opt = optionsForSlot(slot).find((o) => o.status === 'available');
      if (opt) out.push(opt.source);
    }
    return out;
  }, [activeWorkspace.preset]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/connectors`);
      const data = await res.json();
      if (!data.ok) return;
      const next: Record<string, SavedRow> = {};
      for (const c of data.configs) next[c.source] = { source: c.source, status: c.status };
      setInstalled(next);
    } catch {
      // non-fatal
    }
  }, [activeWorkspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(dismissKey) === '1');
    } catch {
      setDismissed(false);
    }
  }, [dismissKey]);

  const missing = suggestedSources.filter((s) => !installed[s] || installed[s].status !== 'configured');
  if (dismissed || missing.length === 0) return null;

  const dismiss = () => {
    try { localStorage.setItem(dismissKey, '1'); } catch { /* ignore */ }
    setDismissed(true);
  };

  const previewLabels = missing
    .slice(0, 4)
    .map((s) => CONNECTOR_PRESETS[s]?.label || s);
  const more = missing.length - previewLabels.length;

  return (
    <div className="suggested-banner" role="status">
      <div className="suggested-banner-icon">
        <Sparkles className="w-4 h-4" />
      </div>
      <div className="suggested-banner-body">
        <div className="suggested-banner-title">
          {missing.length} suggested {missing.length === 1 ? 'connector' : 'connectors'} for {activeWorkspace.name}
        </div>
        <div className="suggested-banner-sub">
          {previewLabels.join(' · ')}{more > 0 ? ` · +${more} more` : ''}
        </div>
      </div>
      <Link href="/settings?tab=connectors" className="btn btn-primary btn-sm">
        Install
      </Link>
      <button
        type="button"
        className="suggested-banner-dismiss"
        onClick={dismiss}
        aria-label="Dismiss"
        title="Dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
