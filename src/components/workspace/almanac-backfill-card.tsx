'use client';

import { useState } from 'react';
import { toast } from '@/components/shared/toast';

/**
 * AlmanacBackfillCard — Settings > AI panel (or Advanced panel).
 *
 * Mounts alongside LocalAgentCard in src/components/ai/ai-providers-section.tsx
 * (or wherever LocalAgentCard is rendered). Provides a one-click trigger for
 * the `almanac-code-events-backfill` Inngest function via POST /api/admin/almanac/backfill.
 */
export function AlmanacBackfillCard() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'idle' | 'queued' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setStatus('idle');
    setErrorMsg(null);

    try {
      const res = await fetch('/api/admin/almanac/backfill', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setStatus('queued');
      toast.success('Almanac backfill queued', {
        description: 'Jobs will be picked up by your paired local agent.',
      });
    } catch (err) {
      const msg = (err as Error).message;
      setErrorMsg(msg);
      setStatus('error');
      toast.error('Backfill failed to queue', { description: msg });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: 'grid',
        gap: '0.75rem',
        padding: '1rem 1.25rem',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        background: '#fff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <strong style={{ fontSize: '1rem' }}>Almanac (advanced)</strong>
          <p style={{ margin: '0.25rem 0 0', color: '#6b7280', fontSize: '0.85rem' }}>
            Manually trigger a code_events backfill for all configured GitHub repos. Jobs are
            dispatched to your paired local agent; the agent resolves each repo on disk and streams
            commit history to the server.
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: '0.85rem' }}
          onClick={run}
          disabled={busy}
        >
          {busy ? 'Queueing…' : 'Run code_events backfill'}
        </button>

        {status === 'queued' && (
          <span style={{ fontSize: '0.8rem', color: '#166534' }}>Queued</span>
        )}
        {status === 'error' && errorMsg && (
          <span style={{ fontSize: '0.8rem', color: '#b91c1c' }}>{errorMsg}</span>
        )}
      </div>
    </div>
  );
}
