'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from '@/components/shared/toast';

/**
 * RunAlmanacSyncCard — Settings > AI panel.
 *
 * One-click trigger for the entire Almanac pipeline. Emits all 6 Inngest
 * events with cumulative delays (Phase 1 → 1.6 → 2 → 3 → 4 → 7) and then
 * polls /api/admin/almanac/sync-status every 5s to render a per-phase
 * progress block until the user navigates away.
 */

interface SyncStatus {
  workspaceId: string;
  phase1_extract: {
    events_total: number;
    backfill_repos: { repo: string; total_events: number; last_run_at: string | null; last_status: string | null; last_error: string | null }[];
  };
  phase1_6_classify: { events_classified: number; events_signal: number };
  phase2_units: { units_total: number; units_named: number; events_unit_assigned: number };
  phase3_match: { candidates_total: number; candidates_accepted: number; events_linked: number };
  phase4_narrate: { sections_total: number; sections_narrated: number };
  phase7_rag: { chunks_total: number; chunks_embedded: number };
  agent_jobs: { by_status: Record<string, number> };
}

export function RunAlmanacSyncCard() {
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [resolvedWorkspace, setResolvedWorkspace] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchStatus();
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchStatus() {
    try {
      const ws = resolvedWorkspace ?? 'default';
      const res = await fetch(`/api/admin/almanac/sync-status?workspaceId=${encodeURIComponent(ws)}`);
      if (!res.ok) return;
      const data = (await res.json()) as SyncStatus;
      setStatus(data);
    } catch {
      // ignore
    }
  }

  function startPolling() {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(fetchStatus, 5000);
  }

  async function runSync() {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/almanac/sync-all', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Empty body — server auto-discovers the workspace that has a
        // configured GitHub connector (see resolveWorkspaceId in
        // /api/admin/almanac/sync-all/route.ts).
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        started_at?: string;
        workspaceId?: string;
        diagnostics?: {
          connectors_in_workspace?: number;
          online_agents?: number;
          paired_agents?: number;
          hint?: string | null;
        };
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setStartedAt(data.started_at ?? new Date().toISOString());
      setResolvedWorkspace(data.workspaceId ?? 'default');
      setDiagnostic(data.diagnostics?.hint ?? null);
      setRunning(true);
      startPolling();
      toast.success(`Almanac sync queued (workspace: ${data.workspaceId})`, {
        description: data.diagnostics?.hint ?? 'All 6 phases will run over the next ~12 minutes.',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Sync failed to queue', { description: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={cardStyle}>
      <header style={headerStyle}>
        <div>
          <h3 style={titleStyle}>Run Almanac sync</h3>
          <p style={subStyle}>
            Triggers the full 6-phase pipeline: extract → classify → cluster → match
            → narrate → embed. Requires a paired online agent + a connected GitHub repo.
          </p>
        </div>
        <button
          type="button"
          onClick={runSync}
          disabled={busy}
          style={buttonStyle(busy)}
        >
          {busy ? 'Queuing…' : running ? 'Run again' : 'Run sync'}
        </button>
      </header>

      {startedAt && (
        <p style={timestampStyle}>
          Started {new Date(startedAt).toLocaleTimeString()}
          {resolvedWorkspace && <> · workspace <code style={inlineCodeStyle}>{resolvedWorkspace}</code></>}
          {' — auto-refresh every 5s.'}
        </p>
      )}

      {diagnostic && (
        <div style={warningStyle}>
          ⚠ {diagnostic}
        </div>
      )}

      <div style={gridStyle}>
        <PhaseRow
          label="Phase 1 · code_events"
          metrics={status ? [
            ['events extracted', status.phase1_extract.events_total],
            ['repos seen',       status.phase1_extract.backfill_repos.length],
          ] : null}
        />
        <PhaseRow
          label="Phase 1.6 · noise classifier"
          metrics={status ? [
            ['classified', status.phase1_6_classify.events_classified],
            ['signal',     status.phase1_6_classify.events_signal],
          ] : null}
        />
        <PhaseRow
          label="Phase 2 · functional units"
          metrics={status ? [
            ['units',          status.phase2_units.units_total],
            ['named',          status.phase2_units.units_named],
            ['events linked',  status.phase2_units.events_unit_assigned],
          ] : null}
        />
        <PhaseRow
          label="Phase 3 · ticket matcher"
          metrics={status ? [
            ['candidates',  status.phase3_match.candidates_total],
            ['accepted',    status.phase3_match.candidates_accepted],
            ['code linked', status.phase3_match.events_linked],
          ] : null}
        />
        <PhaseRow
          label="Phase 4 · narratives"
          metrics={status ? [
            ['sections',  status.phase4_narrate.sections_total],
            ['narrated',  status.phase4_narrate.sections_narrated],
          ] : null}
        />
        <PhaseRow
          label="Phase 7 · RAG"
          metrics={status ? [
            ['chunks',   status.phase7_rag.chunks_total],
            ['embedded', status.phase7_rag.chunks_embedded],
          ] : null}
        />
      </div>

      {status?.agent_jobs.by_status && Object.keys(status.agent_jobs.by_status).length > 0 && (
        <p style={agentJobsStyle}>
          <strong>Agent jobs:</strong>{' '}
          {Object.entries(status.agent_jobs.by_status)
            .map(([s, n]) => `${s}=${n}`)
            .join(', ')}
        </p>
      )}

      {status?.phase1_extract.backfill_repos.some((r) => r.last_status === 'error') && (
        <details style={errorDetailsStyle}>
          <summary>Backfill errors ({status.phase1_extract.backfill_repos.filter((r) => r.last_status === 'error').length})</summary>
          <ul style={errorListStyle}>
            {status.phase1_extract.backfill_repos
              .filter((r) => r.last_status === 'error')
              .map((r) => (
                <li key={r.repo}>
                  <code>{r.repo}</code>: {r.last_error ?? 'unknown'}
                </li>
              ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function PhaseRow({
  label,
  metrics,
}: {
  label: string;
  metrics: [string, number][] | null;
}) {
  return (
    <div style={phaseRowStyle}>
      <div style={phaseLabelStyle}>{label}</div>
      <div style={phaseMetricsStyle}>
        {metrics === null ? (
          <span style={skelStyle}>…</span>
        ) : (
          metrics.map(([name, n]) => (
            <span key={name} style={metricStyle}>
              <span style={metricCountStyle}>{n}</span>{' '}
              <span style={metricLabelStyle}>{name}</span>
            </span>
          ))
        )}
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: 20,
  border: '1px solid var(--ink-2, #e5e5e5)',
  borderRadius: 8,
  background: 'var(--bg-1, #fff)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  marginBottom: 12,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  marginBottom: 4,
  fontSize: 15,
  fontWeight: 600,
};

const subStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'var(--ink-4, #666)',
  lineHeight: 1.4,
};

const buttonStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 500,
  color: disabled ? '#aaa' : '#fff',
  background: disabled ? '#eee' : '#111',
  border: 'none',
  borderRadius: 6,
  cursor: disabled ? 'wait' : 'pointer',
  flexShrink: 0,
});

const timestampStyle: React.CSSProperties = {
  margin: '0 0 12px',
  fontSize: 12,
  color: 'var(--ink-3, #888)',
};

const inlineCodeStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: '0.92em',
  background: 'var(--bg-2, #f5f5f5)',
  padding: '1px 5px',
  borderRadius: 3,
};

const warningStyle: React.CSSProperties = {
  margin: '0 0 12px',
  padding: '8px 12px',
  fontSize: 13,
  color: '#92400e',
  background: '#fef3c7',
  borderRadius: 6,
  border: '1px solid #fde68a',
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr',
  gap: 6,
  marginTop: 8,
};

const phaseRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '8px 0',
  borderTop: '1px solid var(--ink-1, #f0f0f0)',
};

const phaseLabelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--ink-5, #333)',
};

const phaseMetricsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 14,
  fontSize: 12,
};

const metricStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 4,
};

const metricCountStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontWeight: 600,
  color: 'var(--ink-5, #222)',
};

const metricLabelStyle: React.CSSProperties = {
  color: 'var(--ink-3, #888)',
};

const skelStyle: React.CSSProperties = {
  color: 'var(--ink-2, #ccc)',
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
};

const agentJobsStyle: React.CSSProperties = {
  margin: '12px 0 0',
  fontSize: 12,
  color: 'var(--ink-4, #666)',
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
};

const errorDetailsStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 12,
  color: 'var(--ink-4, #666)',
};

const errorListStyle: React.CSSProperties = {
  margin: '8px 0 0',
  paddingLeft: 16,
  color: '#b00020',
};
