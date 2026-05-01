'use client';

import { useEffect, useState } from 'react';

interface ProviderSummary {
  providerId: string;
  hasKey: boolean;
  baseUrl: string | null;
  updatedAt: string | null;
}

interface ProviderDef {
  id: string;
  label: string;
  envVar: string;
  helpUrl: string;
  helpText: string;
  supportsBaseUrl: boolean;
}

const SUPPORTED_PROVIDERS: ProviderDef[] = [
  {
    id: 'gateway',
    label: 'Vercel AI Gateway',
    envVar: 'AI_GATEWAY_API_KEY',
    helpUrl: 'https://vercel.com/dashboard/ai/api-keys',
    helpText:
      'Default provider — routes all enrichment, summaries, and decisions through the Vercel AI Gateway (default model: google/gemini-2.5-flash-lite). Key starts with vck_.',
    supportsBaseUrl: true,
  },
];

interface DraftState {
  apiKey: string;
  baseUrl: string;
}

const EMPTY_DRAFT: DraftState = { apiKey: '', baseUrl: '' };

export function AIProvidersSection() {
  const [summaries, setSummaries] = useState<Record<string, ProviderSummary>>({});
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [status, setStatus] = useState<{ providerId: string; message: string; tone: 'ok' | 'err' } | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch('/api/ai/providers');
      const data = await res.json();
      if (!res.ok) {
        setTopError(data?.error || 'Failed to load providers');
        return;
      }
      setTopError(null);
      const next: Record<string, ProviderSummary> = {};
      for (const p of (data.providers as ProviderSummary[]) ?? []) next[p.providerId] = p;
      setSummaries(next);
    } catch (err: any) {
      setTopError(err?.message || 'Failed to load providers');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function getDraft(id: string): DraftState {
    return drafts[id] ?? EMPTY_DRAFT;
  }

  function updateDraft(id: string, patch: Partial<DraftState>) {
    setDrafts((d) => ({ ...d, [id]: { ...getDraft(id), ...patch } }));
  }

  async function save(providerId: string) {
    setSaving(providerId);
    setStatus(null);
    const draft = getDraft(providerId);
    const body: Record<string, string | null | undefined> = {};
    if (draft.apiKey.length > 0) body.apiKey = draft.apiKey;
    if (draft.baseUrl.length > 0) body.baseUrl = draft.baseUrl;
    try {
      const res = await fetch(`/api/ai/providers/${providerId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({ providerId, message: data?.error || 'Save failed', tone: 'err' });
      } else {
        setStatus({ providerId, message: 'Saved', tone: 'ok' });
        setDrafts((d) => ({ ...d, [providerId]: EMPTY_DRAFT }));
        await load();
      }
    } catch (err: any) {
      setStatus({ providerId, message: err?.message || 'Save failed', tone: 'err' });
    } finally {
      setSaving(null);
    }
  }

  async function clearKey(providerId: string) {
    setSaving(providerId);
    setStatus(null);
    try {
      const res = await fetch(`/api/ai/providers/${providerId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({ providerId, message: data?.error || 'Clear failed', tone: 'err' });
      } else {
        setStatus({ providerId, message: 'Cleared', tone: 'ok' });
        setDrafts((d) => ({ ...d, [providerId]: EMPTY_DRAFT }));
        await load();
      }
    } catch (err: any) {
      setStatus({ providerId, message: err?.message || 'Clear failed', tone: 'err' });
    } finally {
      setSaving(null);
    }
  }

  return (
    <section style={{ display: 'grid', gap: '1.5rem' }}>
      <header>
        <h2 style={{ margin: 0, fontSize: '1.25rem' }}>AI Providers</h2>
        <p style={{ margin: '0.25rem 0 0', color: '#6b7280', fontSize: '0.9rem' }}>
          API keys you save here are encrypted at rest with <code>WORKGRAPH_SECRET_KEY</code> and used for every Claude /
          AI SDK call. If a key isn&apos;t configured here, the runtime falls back to the corresponding environment variable.
        </p>
      </header>

      {topError && (
        <div style={{ padding: '0.75rem 1rem', background: '#fee2e2', color: '#991b1b', borderRadius: 6, fontSize: '0.9rem' }}>
          {topError}
        </div>
      )}

      {loading ? (
        <p style={{ color: '#9ca3af' }}>Loading…</p>
      ) : (
        SUPPORTED_PROVIDERS.map((provider) => {
          const summary = summaries[provider.id];
          const draft = getDraft(provider.id);
          const isSaving = saving === provider.id;
          const providerStatus = status && status.providerId === provider.id ? status : null;
          const configured = !!summary?.hasKey;

          return (
            <div
              key={provider.id}
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
                  <strong style={{ fontSize: '1rem' }}>{provider.label}</strong>
                  <p style={{ margin: '0.25rem 0 0', color: '#6b7280', fontSize: '0.85rem' }}>{provider.helpText}</p>
                </div>
                <span
                  style={{
                    fontSize: '0.8rem',
                    padding: '0.15rem 0.55rem',
                    borderRadius: 999,
                    background: configured ? '#dcfce7' : '#f3f4f6',
                    color: configured ? '#166534' : '#6b7280',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {configured ? 'Key configured' : `Falls back to ${provider.envVar}`}
                </span>
              </div>

              <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.85rem' }}>
                <span style={{ color: '#374151' }}>API key</span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={configured ? 'Saved — paste a new key to replace' : `Paste your ${provider.label} API key`}
                  value={draft.apiKey}
                  onChange={(e) => updateDraft(provider.id, { apiKey: e.target.value })}
                  style={{
                    padding: '0.5rem 0.65rem',
                    border: '1px solid #d1d5db',
                    borderRadius: 6,
                    fontSize: '0.85rem',
                    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  }}
                />
                <span style={{ color: '#9ca3af', fontSize: '0.75rem' }}>
                  Get one at{' '}
                  <a href={provider.helpUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb' }}>
                    {provider.helpUrl.replace(/^https?:\/\//, '')}
                  </a>
                </span>
              </label>

              {provider.supportsBaseUrl && (
                <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.85rem' }}>
                  <span style={{ color: '#374151' }}>Base URL (optional)</span>
                  <input
                    type="text"
                    spellCheck={false}
                    placeholder={summary?.baseUrl ?? 'Leave blank for the provider default'}
                    value={draft.baseUrl}
                    onChange={(e) => updateDraft(provider.id, { baseUrl: e.target.value })}
                    style={{
                      padding: '0.5rem 0.65rem',
                      border: '1px solid #d1d5db',
                      borderRadius: 6,
                      fontSize: '0.85rem',
                      fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                    }}
                  />
                  {summary?.baseUrl && (
                    <span style={{ color: '#9ca3af', fontSize: '0.75rem' }}>Currently saved: {summary.baseUrl}</span>
                  )}
                </label>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => save(provider.id)}
                  disabled={isSaving || (draft.apiKey.length === 0 && draft.baseUrl.length === 0)}
                  style={{
                    padding: '0.45rem 0.9rem',
                    background: isSaving ? '#9ca3af' : '#111827',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontSize: '0.85rem',
                    cursor: isSaving ? 'wait' : 'pointer',
                  }}
                >
                  {isSaving ? 'Saving…' : 'Save'}
                </button>
                {configured && (
                  <button
                    type="button"
                    onClick={() => clearKey(provider.id)}
                    disabled={isSaving}
                    style={{
                      padding: '0.45rem 0.9rem',
                      background: 'transparent',
                      color: '#991b1b',
                      border: '1px solid #fecaca',
                      borderRadius: 6,
                      fontSize: '0.85rem',
                      cursor: 'pointer',
                    }}
                  >
                    Clear key
                  </button>
                )}
                {providerStatus && (
                  <span
                    style={{
                      fontSize: '0.85rem',
                      color: providerStatus.tone === 'ok' ? '#166534' : '#991b1b',
                    }}
                  >
                    {providerStatus.message}
                  </span>
                )}
                {summary?.updatedAt && (
                  <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#9ca3af' }}>
                    Updated {summary.updatedAt}
                  </span>
                )}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
