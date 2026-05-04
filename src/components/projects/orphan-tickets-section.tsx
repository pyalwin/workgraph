'use client';

import { useEffect, useState, useCallback } from 'react';

// ─────────────────────────────────────────────
// Wire-format types (mirrors GET /api/orphan-tickets response)
// ─────────────────────────────────────────────

interface TicketCandidate {
  id: number;
  evidence_kind: 'pr' | 'branch' | 'commit' | string;
  tier_reached: 'A' | 'B' | 'C' | string;
  candidate_ref: string;
  score: number;
  signals: Record<string, number> | null;
  computed_at: string | null;
  dismissed_at: string | null;
  accepted_at: string | null;
}

interface OrphanTicket {
  issue_item_id: string;
  issue_key: string;
  title: string;
  status: string | null;
  project_key: string;
  candidates: TicketCandidate[];
}

interface ApiResponse {
  tickets: OrphanTicket[];
}

interface Props {
  /** Defaults to 'default' — the single seeded workspace in this local app. */
  workspaceId?: string;
  projectKey: string;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function tierStyle(tier: string): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: 3,
    fontFamily: 'var(--mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  };
  if (tier === 'A') return { ...base, background: '#d1fae5', color: '#065f46' };
  if (tier === 'B') return { ...base, background: '#fef3c7', color: '#92400e' };
  return { ...base, background: 'var(--bone-2)', color: 'var(--ink-4)' };
}

function scoreStyle(score: number): React.CSSProperties {
  const base: React.CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    fontWeight: 600,
    minWidth: 38,
  };
  if (score >= 0.75) return { ...base, color: '#065f46' };
  if (score >= 0.5) return { ...base, color: '#92400e' };
  return { ...base, color: 'var(--ink-4)' };
}

function EvidenceIcon({ kind }: { kind: string }) {
  // Minimal inline SVG icons — no external dependency
  const style: React.CSSProperties = { width: 14, height: 14, flexShrink: 0, color: 'var(--ink-4)' };
  if (kind === 'pr') {
    // Git merge icon
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={style} aria-label="pull request">
        <circle cx="4" cy="4" r="1.5" />
        <circle cx="12" cy="4" r="1.5" />
        <circle cx="4" cy="12" r="1.5" />
        <path d="M4 5.5v5M12 5.5C12 9 4 9 4 9" />
      </svg>
    );
  }
  if (kind === 'branch') {
    // Git branch icon
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={style} aria-label="branch">
        <circle cx="4" cy="4" r="1.5" />
        <circle cx="12" cy="4" r="1.5" />
        <circle cx="4" cy="12" r="1.5" />
        <path d="M4 5.5v5M12 5.5C12 9 8 9 4 9" />
      </svg>
    );
  }
  // commit — dot
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" style={style} aria-label="commit">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 2v4M8 10v4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function candidateRefLink(ref: string): React.ReactNode {
  // owner/repo#NN  → GitHub PR
  const prMatch = ref.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (prMatch) {
    const url = `https://github.com/${prMatch[1]}/pull/${prMatch[2]}`;
    return (
      <a href={url} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}>
        {ref}
      </a>
    );
  }
  // owner/repo@sha
  const shaMatch = ref.match(/^([^@]+)@([0-9a-f]{7,40})$/);
  if (shaMatch) {
    const url = `https://github.com/${shaMatch[1]}/commit/${shaMatch[2]}`;
    return (
      <a href={url} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}>
        {ref}
      </a>
    );
  }
  return <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>{ref}</span>;
}

function btn(variant: 'accept' | 'dismiss' | 'revoke' | 'subtle'): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: 11,
    padding: '3px 9px',
    borderRadius: 4,
    cursor: 'pointer',
    fontWeight: 600,
    border: '1px solid transparent',
    whiteSpace: 'nowrap',
  };
  if (variant === 'accept') {
    return { ...base, background: 'var(--ink)', color: 'var(--paper)', border: '1px solid var(--ink)' };
  }
  if (variant === 'dismiss') {
    return { ...base, background: 'transparent', color: 'var(--ink-4)', border: '1px solid var(--rule)' };
  }
  if (variant === 'revoke') {
    return { ...base, background: 'transparent', color: '#b13434', border: '1px solid #e2a0a0' };
  }
  // subtle
  return { ...base, background: 'transparent', color: 'var(--ink-5)', border: '1px solid var(--rule)' };
}

// ─────────────────────────────────────────────
// Candidate row
// ─────────────────────────────────────────────

function CandidateRow({
  candidate,
  ticketId,
  optimistic,
  onAction,
  isReadOnly,
}: {
  candidate: TicketCandidate;
  ticketId: string;
  optimistic: { id: number; action: 'accept' | 'dismiss' } | null;
  onAction: (candidateId: number, action: 'accept' | 'dismiss') => Promise<void>;
  isReadOnly?: boolean;
}) {
  const isThisOptimistic = optimistic?.id === candidate.id;
  const dimmed = isThisOptimistic && optimistic?.action === 'dismiss';

  return (
    <li
      style={{
        padding: '7px 10px',
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        opacity: dimmed ? 0.45 : 1,
        textDecoration: dimmed ? 'line-through' : 'none',
        transition: 'opacity 0.2s',
      }}
    >
      <span style={tierStyle(candidate.tier_reached)}>{candidate.tier_reached}</span>
      <EvidenceIcon kind={candidate.evidence_kind} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {candidateRefLink(candidate.candidate_ref)}
      </span>
      <span
        style={scoreStyle(candidate.score)}
        title={`Score: ${candidate.score}`}
      >
        {candidate.score.toFixed(2)}
      </span>
      {candidate.signals && (
        <span
          title={JSON.stringify(candidate.signals, null, 2)}
          style={{ fontSize: 10, color: 'var(--ink-5)', cursor: 'help', padding: '2px 4px', border: '1px solid var(--rule)', borderRadius: 3 }}
        >
          signals
        </span>
      )}
      {isReadOnly ? (
        <button
          type="button"
          disabled={isThisOptimistic}
          onClick={() => onAction(candidate.id, 'dismiss')}
          style={btn('revoke')}
        >
          Revoke
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={isThisOptimistic}
            onClick={() => onAction(candidate.id, 'accept')}
            style={btn('accept')}
          >
            Accept
          </button>
          <button
            type="button"
            disabled={isThisOptimistic}
            onClick={() => onAction(candidate.id, 'dismiss')}
            style={btn('dismiss')}
          >
            Dismiss
          </button>
        </>
      )}
    </li>
  );
}

// ─────────────────────────────────────────────
// Main section component
// ─────────────────────────────────────────────

export function OrphanTicketsSection({ workspaceId = 'default', projectKey }: Props) {
  const [tickets, setTickets] = useState<OrphanTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [inlineErrors, setInlineErrors] = useState<Record<string, string>>({});
  // Track optimistic updates: map of candidateId → pending action
  const [optimistic, setOptimistic] = useState<{ id: number; action: 'accept' | 'dismiss' } | null>(null);

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/orphan-tickets?workspaceId=${encodeURIComponent(workspaceId)}`);
      const json: ApiResponse = await res.json();
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      // Filter to only tickets matching this project
      const filtered = (json.tickets ?? []).filter((t) => t.project_key === projectKey);
      setTickets(filtered);
    } catch (err) {
      // Non-fatal: section renders empty
      setTickets([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, projectKey]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const handleAction = useCallback(
    async (ticketIssueId: string, candidateId: number, action: 'accept' | 'dismiss') => {
      // Optimistic update
      setOptimistic({ id: candidateId, action });
      setInlineErrors((prev) => {
        const next = { ...prev };
        delete next[String(candidateId)];
        return next;
      });
      try {
        const res = await fetch(`/api/orphan-tickets/${encodeURIComponent(ticketIssueId)}/match`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ candidate_id: candidateId, action }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
        // Refetch to confirm server state
        await fetchTickets();
      } catch (err) {
        setInlineErrors((prev) => ({ ...prev, [String(candidateId)]: (err as Error).message }));
      } finally {
        setOptimistic(null);
      }
    },
    [fetchTickets],
  );

  return (
    <section className="proj-section">
      <div className="proj-section-head">
        <div>
          <p className="proj-section-eyebrow">Almanac · Phase 3</p>
          <h2 className="proj-section-title">Find code for orphan tickets</h2>
        </div>
        <button
          type="button"
          className="proj-section-action"
          onClick={() => setCollapsed((v) => !v)}
          style={{ fontSize: 12 }}
        >
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </div>

      {!collapsed && (
        <div className="proj-section-body">
          {loading && (
            <p style={{ fontSize: 13, color: 'var(--ink-4)' }}>Loading…</p>
          )}

          {!loading && tickets.length === 0 && (
            <p style={{ fontSize: 13, color: 'var(--ink-4)' }}>
              No orphan tickets in this project.
            </p>
          )}

          {!loading && tickets.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {tickets.map((ticket) => {
                const autoLinked = ticket.candidates.filter((c) => c.accepted_at !== null);
                const reviewQueue = ticket.candidates.filter((c) => c.accepted_at === null && c.dismissed_at === null);

                return (
                  <li
                    key={ticket.issue_item_id}
                    style={{
                      padding: 14,
                      border: '1px solid var(--rule)',
                      borderRadius: 6,
                      background: 'var(--bone-2)',
                    }}
                  >
                    {/* Ticket header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', fontWeight: 600 }}>
                        {ticket.issue_key}
                      </span>
                      {ticket.status && (
                        <span style={{ fontSize: 10, padding: '2px 6px', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 3, color: 'var(--ink-4)' }}>
                          {ticket.status.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                    <p style={{ fontSize: 14, margin: '0 0 10px', color: 'var(--ink)', fontWeight: 500 }}>
                      {ticket.title}
                    </p>

                    {/* Auto-linked subsection */}
                    {autoLinked.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <p style={{ fontSize: 11, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-5)', margin: '0 0 5px' }}>
                          Auto-linked (≥0.75)
                        </p>
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                          {autoLinked.map((c) => (
                            <CandidateRow
                              key={c.id}
                              candidate={c}
                              ticketId={ticket.issue_item_id}
                              optimistic={optimistic}
                              onAction={(candidateId, action) => handleAction(ticket.issue_item_id, candidateId, action)}
                              isReadOnly
                            />
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Review queue */}
                    {reviewQueue.length > 0 && (
                      <div>
                        <p style={{ fontSize: 11, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-5)', margin: '0 0 5px' }}>
                          Candidates to review
                        </p>
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                          {reviewQueue.map((c) => (
                            <CandidateRow
                              key={c.id}
                              candidate={c}
                              ticketId={ticket.issue_item_id}
                              optimistic={optimistic}
                              onAction={(candidateId, action) => handleAction(ticket.issue_item_id, candidateId, action)}
                            />
                          ))}
                        </ul>
                      </div>
                    )}

                    {autoLinked.length === 0 && reviewQueue.length === 0 && (
                      <p style={{ fontSize: 12, color: 'var(--ink-5)', margin: 0 }}>
                        No candidates yet — the matcher has not run for this ticket.
                      </p>
                    )}

                    {/* Inline error(s) for candidates on this ticket */}
                    {ticket.candidates.some((c) => inlineErrors[String(c.id)]) && (
                      <p style={{ fontSize: 12, color: '#b13434', margin: '8px 0 0' }}>
                        {ticket.candidates
                          .filter((c) => inlineErrors[String(c.id)])
                          .map((c) => inlineErrors[String(c.id)])
                          .join(' · ')}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
