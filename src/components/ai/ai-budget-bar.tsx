'use client';

import { useEffect, useState } from 'react';
import { toast } from '@/components/shared/toast';

type Provider = 'auto' | 'gateway' | 'openrouter';

interface QuotaResponse {
  period: string;
  activeProvider: 'gateway' | 'openrouter';
  enforced: boolean;
  cost: {
    limitUsdMicros: number | null;
    usedUsdMicros: number;
    remainingUsdMicros: number | null;
  };
  calls: {
    limit: number | null;
    used: number;
    remaining: number | null;
  };
  totals: { tokensIn: number; tokensOut: number };
  byTask: Array<{ task: string; callCount: number }>;
}

const PROVIDER_OPTIONS: { id: Provider; label: string; subtitle: string }[] = [
  { id: 'auto', label: 'Auto', subtitle: 'Pick from configured keys' },
  { id: 'gateway', label: 'Vercel AI Gateway', subtitle: 'Operator default' },
  { id: 'openrouter', label: 'OpenRouter', subtitle: 'BYOK — your bill' },
];

function formatUsd(micros: number): string {
  if (micros <= 0) return '$0.00';
  const dollars = micros / 1_000_000;
  if (dollars < 0.01) return '<$0.01';
  return `$${dollars.toFixed(2)}`;
}

/**
 * Top of Settings → AI: shows which provider is active, lets user override,
 * and renders a budget bar for the operator-paid free tier (only meaningful
 * when Gateway is active — BYOK paths show "unlimited").
 *
 * The budget is denominated in USD ("credits") and computed from per-call
 * token counts × per-model pricing. A secondary call-count cap exists as
 * anti-abuse but is hidden from the UI unless it's the binding constraint.
 */
export function AIBudgetBar() {
  const [pref, setPref] = useState<Provider>('auto');
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [savingPref, setSavingPref] = useState(false);

  const refresh = async () => {
    const [pRes, qRes] = await Promise.all([
      fetch('/api/ai/active-provider').catch((err: Error) => err),
      fetch('/api/user/quota').catch((err: Error) => err),
    ]);

    if (pRes instanceof Error || qRes instanceof Error) {
      toast.error('Couldn’t load AI usage', {
        description: (pRes instanceof Error ? pRes : (qRes as Error)).message,
      });
      return;
    }

    if (pRes.ok) {
      const data = await pRes.json();
      if (data?.provider) setPref(data.provider as Provider);
    } else {
      toast.warning('Couldn’t load active provider', { description: `HTTP ${pRes.status}` });
    }

    if (qRes.ok) {
      setQuota(await qRes.json());
    } else {
      toast.warning('Couldn’t load free-tier usage', { description: `HTTP ${qRes.status}` });
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const setProvider = async (next: Provider) => {
    if (next === pref) return;
    setSavingPref(true);
    try {
      const res = await fetch('/api/ai/active-provider', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setPref(next);
      toast.success(`Active provider set to ${next}`);
      await refresh();
    } catch (err) {
      toast.error('Couldn’t change active provider', { description: (err as Error).message });
    } finally {
      setSavingPref(false);
    }
  };

  // Determine the binding metric. Cost is primary; if cost is unlimited but
  // calls are limited, fall back to calls. If both unlimited, show "Unmetered".
  const costLimit = quota?.cost.limitUsdMicros ?? null;
  const costUsed = quota?.cost.usedUsdMicros ?? 0;
  const callLimit = quota?.calls.limit ?? null;
  const callUsed = quota?.calls.used ?? 0;

  const costPct = costLimit === null ? 0 : Math.min(100, Math.round((costUsed / Math.max(1, costLimit)) * 100));
  const callPct = callLimit === null ? 0 : Math.min(100, Math.round((callUsed / Math.max(1, callLimit)) * 100));
  const bindingPct = Math.max(costPct, callPct);
  const barColor = bindingPct < 70 ? '#10b981' : bindingPct < 90 ? '#f59e0b' : '#dc2626';

  const isUnmetered = !quota || (costLimit === null && callLimit === null) || quota.activeProvider !== 'gateway';
  const exceeded =
    quota?.enforced &&
    ((costLimit !== null && costUsed >= costLimit) || (callLimit !== null && callUsed >= callLimit));

  return (
    <div
      style={{
        display: 'grid',
        gap: '0.85rem',
        padding: '1rem 1.25rem',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        background: '#fff',
      }}
    >
      <div style={{ display: 'grid', gap: '0.4rem' }}>
        <div style={{ fontSize: '0.85rem', color: '#374151', fontWeight: 600 }}>Active provider</div>
        <div
          role="radiogroup"
          aria-label="AI provider preference"
          style={{
            display: 'inline-flex',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            overflow: 'hidden',
            background: '#f9fafb',
            opacity: savingPref ? 0.6 : 1,
            transition: 'opacity 100ms',
          }}
        >
          {PROVIDER_OPTIONS.map((opt) => {
            const selected = pref === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setProvider(opt.id)}
                disabled={savingPref}
                style={{
                  padding: '0.45rem 0.85rem',
                  background: selected ? '#111827' : 'transparent',
                  color: selected ? '#fff' : '#374151',
                  border: 'none',
                  borderRight: '1px solid #e5e7eb',
                  cursor: savingPref ? 'wait' : 'pointer',
                  fontSize: '0.85rem',
                  fontWeight: selected ? 600 : 400,
                  display: 'grid',
                  textAlign: 'left',
                  gap: '0.1rem',
                  minWidth: 140,
                }}
              >
                <span>{opt.label}</span>
                <span style={{ fontSize: '0.7rem', color: selected ? 'rgba(255,255,255,0.7)' : '#9ca3af' }}>
                  {opt.subtitle}
                </span>
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
          Resolved: <strong style={{ color: '#374151' }}>{quota?.activeProvider ?? '—'}</strong>
          {' · '}Period: <code>{quota?.period ?? '—'}</code>
        </div>
      </div>

      <div style={{ display: 'grid', gap: '0.4rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div style={{ fontSize: '0.85rem', color: '#374151', fontWeight: 600 }}>
            Free-tier credits this month
          </div>
          <div style={{ fontSize: '0.8rem', color: '#6b7280' }}>
            {isUnmetered ? (
              <span>Unmetered (BYOK active)</span>
            ) : costLimit !== null ? (
              <span>
                <strong style={{ color: '#111827' }}>{formatUsd(costUsed)}</strong> of {formatUsd(costLimit)} credits
              </span>
            ) : (
              <span>
                <strong style={{ color: '#111827' }}>{callUsed}</strong> / {callLimit} calls
              </span>
            )}
          </div>
        </div>
        <div style={{ height: 8, background: '#f3f4f6', borderRadius: 999, overflow: 'hidden' }}>
          <div
            style={{
              width: isUnmetered ? '100%' : `${bindingPct}%`,
              height: '100%',
              background: isUnmetered ? '#d1d5db' : barColor,
              transition: 'width 200ms, background 200ms',
            }}
          />
        </div>
        {!isUnmetered && (
          <div style={{ fontSize: '0.7rem', color: '#9ca3af' }}>
            {callUsed} call{callUsed === 1 ? '' : 's'} this month
            {quota?.totals
              ? ` · ${(quota.totals.tokensIn + quota.totals.tokensOut).toLocaleString()} tokens`
              : ''}
          </div>
        )}
        {exceeded && (
          <div
            style={{
              fontSize: '0.8rem',
              padding: '0.5rem 0.75rem',
              background: '#fef2f2',
              color: '#991b1b',
              border: '1px solid #fecaca',
              borderRadius: 6,
            }}
          >
            You&apos;ve hit the free-tier cap. Add an OpenRouter key below to keep going on your own
            subscription, or install the Local Agent to use your Claude / Codex / Gemini CLIs.
          </div>
        )}
      </div>
    </div>
  );
}
