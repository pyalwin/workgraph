'use client';

import { useEffect, useState, useCallback } from 'react';

interface Candidate {
  item_id: string;
  source_id: string;
  title: string;
  status: string | null;
  url: string | null;
  project: string | null;
  score: number;
  signals: { embedding?: number; author?: number; repo?: number; temporal?: number } | null;
}

interface OrphanPr {
  trail_id: string;
  pr_ref: string;
  pr_url: string | null;
  repo: string | null;
  title: string | null;
  body: string | null;
  functional_summary: string | null;
  diff_summary: { additions?: number; deletions?: number; branch?: string } | null;
  occurred_at: string;
  actor: string | null;
  candidates: Candidate[];
}

interface Props {
  open: boolean;
  /** When set, server filters orphans to this repo. Coming from an orphan_pr_batch anomaly. */
  repoFilter?: string | null;
  /** When set, server filters candidates to this Jira project. */
  projectFilter?: string | null;
  onClose: () => void;
  /** Called after each successful action so the parent can refresh. */
  onChanged?: () => void;
}

export function OrphanPrReviewModal({
  open,
  repoFilter,
  projectFilter,
  onClose,
  onChanged,
}: Props) {
  const [orphans, setOrphans] = useState<OrphanPr[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // pr_ref currently being acted on
  const [error, setError] = useState<string | null>(null);
  const [showOnlyWithCandidates, setShowOnlyWithCandidates] = useState(true);

  const fetchOrphans = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (repoFilter) params.set('repo', repoFilter);
      if (projectFilter) params.set('project', projectFilter);
      if (showOnlyWithCandidates) params.set('has_candidates', 'true');
      const res = await fetch(`/api/orphan-prs?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setOrphans(json.orphans ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [repoFilter, projectFilter, showOnlyWithCandidates]);

  useEffect(() => {
    if (!open) return;
    fetchOrphans();
  }, [open, fetchOrphans]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const attach = async (prRef: string, candidate: Candidate) => {
    setBusy(prRef);
    setError(null);
    try {
      const encoded = encodeURIComponent(prRef);
      const res = await fetch(`/api/issue-trails/by-pr-ref/${encoded}/attach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issue_item_id: candidate.item_id }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      // Optimistic remove from the list — re-fetch for fresh data
      setOrphans((prev) => prev.filter((o) => o.pr_ref !== prRef));
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (prRef: string) => {
    setBusy(prRef);
    setError(null);
    try {
      const encoded = encodeURIComponent(prRef);
      const res = await fetch(`/api/issue-trails/by-pr-ref/${encoded}/dismiss-candidates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      // Hide it from this view (still orphan, just no candidates surfaced)
      setOrphans((prev) => prev.filter((o) => o.pr_ref !== prRef));
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.4)',
          zIndex: 100,
        }}
      />
      <div
        role="dialog"
        aria-label="Review orphan pull requests"
        style={{
          position: 'fixed',
          inset: '5% 8%',
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderRadius: 8,
          zIndex: 101,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--rule)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>Review orphan pull requests</h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--ink-4)' }}>
              {repoFilter && <span>Repo: <strong>{repoFilter}</strong> · </span>}
              {projectFilter && <span>Project: <strong>{projectFilter}</strong> · </span>}
              {orphans.length} PR{orphans.length === 1 ? '' : 's'} shown
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ fontSize: 12, color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={showOnlyWithCandidates}
                onChange={(e) => setShowOnlyWithCandidates(e.target.checked)}
              />
              Hide PRs without candidates
            </label>
            <button onClick={onClose} style={btn('subtle')} aria-label="Close">✕</button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          {loading && <p style={{ color: 'var(--ink-4)' }}>Loading…</p>}
          {error && <p style={{ color: '#b13434', fontSize: 13 }}>Error: {error}</p>}
          {!loading && orphans.length === 0 && (
            <p style={{ color: 'var(--ink-4)', fontSize: 13 }}>
              No orphan PRs to review here. Either everything has been attached or no candidates met the review threshold.
            </p>
          )}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {orphans.map((pr) => (
              <li
                key={pr.trail_id}
                style={{
                  padding: 14,
                  border: '1px solid var(--rule)',
                  borderRadius: 6,
                  background: 'var(--bone-2)',
                  opacity: busy === pr.pr_ref ? 0.6 : 1,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                  <div>
                    {pr.pr_url ? (
                      <a href={pr.pr_url} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)' }}>
                        {pr.pr_ref}
                      </a>
                    ) : (
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{pr.pr_ref}</span>
                    )}
                    {pr.actor && <span style={{ fontSize: 11, color: 'var(--ink-5)', marginLeft: 8 }}>by @{pr.actor}</span>}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--ink-5)' }}>{fmtDate(pr.occurred_at)}</span>
                </div>
                <p style={{ fontSize: 14, margin: '0 0 6px', color: 'var(--ink)', fontWeight: 600 }}>
                  {pr.title || '(no title)'}
                </p>
                {pr.functional_summary && (
                  <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '0 0 10px', fontStyle: 'italic' }}>
                    AI: {pr.functional_summary}
                  </p>
                )}
                {pr.diff_summary && (pr.diff_summary.additions != null || pr.diff_summary.deletions != null) && (
                  <p style={{ fontSize: 11, color: 'var(--ink-5)', margin: '0 0 10px', fontFamily: 'var(--mono)' }}>
                    +{pr.diff_summary.additions ?? '?'}/-{pr.diff_summary.deletions ?? '?'}
                    {pr.diff_summary.branch && <> · branch {pr.diff_summary.branch}</>}
                  </p>
                )}

                {pr.candidates.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--ink-5)', margin: 0 }}>
                    No candidates met the review threshold (≥0.4). The matcher had nothing plausible to suggest.
                  </p>
                ) : (
                  <>
                    <p style={{ fontSize: 11, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-5)', margin: '8px 0 6px' }}>
                      Candidates
                    </p>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {pr.candidates.map((cand) => (
                        <li
                          key={cand.item_id}
                          style={{
                            padding: '8px 10px',
                            background: 'var(--paper)',
                            border: '1px solid var(--rule)',
                            borderRadius: 4,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                          }}
                        >
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-5)', minWidth: 40 }}>
                            {Math.round(cand.score * 100)}%
                          </span>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', minWidth: 80 }}>
                            {cand.source_id}
                          </span>
                          <span style={{ flex: 1, fontSize: 13, color: 'var(--ink-2)' }}>
                            {cand.title}
                          </span>
                          {cand.status && (
                            <span style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bone-2)', borderRadius: 3, color: 'var(--ink-4)' }}>
                              {cand.status}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => attach(pr.pr_ref, cand)}
                            disabled={busy === pr.pr_ref}
                            style={btn('primary')}
                          >
                            Attach
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => dismiss(pr.pr_ref)}
                    disabled={busy === pr.pr_ref}
                    style={btn('subtle')}
                  >
                    None of these · keep as orphan
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

function btn(variant: 'primary' | 'subtle'): React.CSSProperties {
  if (variant === 'primary') {
    return {
      fontSize: 11,
      padding: '4px 10px',
      background: 'var(--ink)',
      color: 'var(--paper)',
      border: '1px solid var(--ink)',
      borderRadius: 4,
      cursor: 'pointer',
      fontWeight: 600,
    };
  }
  return {
    fontSize: 11,
    padding: '4px 10px',
    background: 'transparent',
    color: 'var(--ink-4)',
    border: '1px solid var(--rule)',
    borderRadius: 4,
    cursor: 'pointer',
  };
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}
