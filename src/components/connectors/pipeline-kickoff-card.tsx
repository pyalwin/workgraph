'use client';

import { useState } from 'react';
import { Card, CardContent, CardTitle } from '@/components/ui/card';

interface KickResult {
  ok: boolean;
  chunked: { items: number; chunks: number } | null;
  embedded: { embedded: number; skipped: number; failed: number } | null;
  enriched: { scanned: number; enriched: number; failed: number } | null;
  matcher: {
    scanned: number;
    matched: number;
    reviewable: number;
    moved_issue_ids: number;
  } | null;
  anomaly_scan: 'queued' | 'skipped' | null;
  duration_ms: number;
  errors: string[];
}

export function PipelineKickoffCard() {
  const [busy, setBusy] = useState(false);
  const [skipAnomalies, setSkipAnomalies] = useState(false);
  const [result, setResult] = useState<KickResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const kick = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/admin/kick-pipeline', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skip_anomalies: skipAnomalies }),
      });
      const json = (await res.json()) as KickResult & { error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(json);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="pt-[22px]">
        <CardTitle className="mb-2">Pipeline kickoff</CardTitle>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 14, lineHeight: 1.5 }}>
          Runs chunk-and-embed → orphan-PR enrichment → unmatched-PR matcher inline, then queues an
          anomaly scan. Use this after a sync to materialise the embedding index, attach orphan PRs
          that have a confident match, and surface candidates for the rest. The crons do this on
          their own cadence — this just shortens the loop while testing.
        </p>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--ink-3)',
            marginBottom: 10,
          }}
        >
          <input
            type="checkbox"
            checked={skipAnomalies}
            onChange={(e) => setSkipAnomalies(e.target.checked)}
            disabled={busy}
          />
          Skip anomaly scan (faster)
        </label>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <button
            type="button"
            onClick={kick}
            disabled={busy}
            style={{
              padding: '7px 14px',
              fontSize: 13,
              fontWeight: 600,
              background: 'var(--ink)',
              color: 'var(--paper)',
              border: 'none',
              borderRadius: 5,
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            {busy ? 'Running…' : 'Kick pipeline now'}
          </button>
          {busy && (
            <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>
              This may take 30s–2min depending on backlog.
            </span>
          )}
        </div>

        {error && (
          <p style={{ fontSize: 12, color: '#b13434', margin: '8px 0' }}>
            Error: {error}
          </p>
        )}

        {result && <KickResultPanel result={result} />}
      </CardContent>
    </Card>
  );
}

function KickResultPanel({ result }: { result: KickResult }) {
  const seconds = (result.duration_ms / 1000).toFixed(1);
  return (
    <div
      style={{
        padding: 12,
        border: '1px solid var(--rule)',
        borderRadius: 5,
        background: 'var(--bone-2)',
        fontSize: 12,
        fontFamily: 'var(--mono)',
        lineHeight: 1.6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <strong>{result.ok ? '✓ Done' : '⚠ Completed with errors'}</strong>
        <span style={{ color: 'var(--ink-5)' }}>{seconds}s</span>
      </div>
      <Row label="chunked"  value={result.chunked  ? `${result.chunked.items} item(s) → ${result.chunked.chunks} chunk(s)` : '—'} />
      <Row label="embedded" value={result.embedded ? `${result.embedded.embedded} embedded · ${result.embedded.failed} failed` : '—'} />
      <Row label="enriched" value={result.enriched ? `${result.enriched.enriched}/${result.enriched.scanned} orphan PRs` : '—'} />
      <Row label="matcher"  value={result.matcher  ? `${result.matcher.matched} auto-attached · ${result.matcher.reviewable} need review` : '—'} />
      <Row label="anomalies" value={result.anomaly_scan === 'queued' ? 'queued (running async)' : result.anomaly_scan ?? '—'} />
      {result.errors.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', color: '#b13434' }}>{result.errors.length} error(s)</summary>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {result.errors.slice(0, 10).map((e, i) => (
              <li key={i} style={{ wordBreak: 'break-word' }}>{e}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <span style={{ minWidth: 90, color: 'var(--ink-5)' }}>{label}</span>
      <span style={{ color: 'var(--ink-2)' }}>{value}</span>
    </div>
  );
}
