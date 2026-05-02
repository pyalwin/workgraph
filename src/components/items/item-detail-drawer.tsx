'use client';

import { useEffect, useState } from 'react';
import { Markdown } from '@/components/chat/prompt-kit/markdown';

interface GapAnalysis {
  status: 'complete' | 'partial' | 'gap' | 'unknown';
  shipped: string[];
  missing: string[];
  notes: string;
}

interface WorkItem {
  id: string;
  source: string;
  source_id: string;
  item_type: string;
  title: string;
  body: string | null;
  summary: string | null;
  author: string | null;
  status: string | null;
  priority: string | null;
  url: string | null;
  created_at: string;
  updated_at: string | null;
  pr_summary: string | null;
  pr_summary_generated_at: string | null;
  gap_analysis: GapAnalysis | null;
  gap_analysis_generated_at: string | null;
}

interface LinkedItem {
  linked_item_id: string;
  link_type: string;
  title: string;
  source: string;
  source_id: string;
  item_type: string;
  status: string | null;
  url: string | null;
  created_at: string;
}

interface PrTrailEntry {
  id: string;
  pr_ref: string;
  pr_url: string | null;
  repo: string | null;
  kind: 'pr_opened' | 'pr_review' | 'pr_merged' | 'pr_closed';
  actor: string | null;
  title: string | null;
  body: string | null;
  state: string | null;
  diff_summary: { additions?: number; deletions?: number; branch?: string } | null;
  occurred_at: string;
  match_status: 'matched' | 'unmatched' | 'ai_matched';
  match_confidence: number | null;
  functional_summary?: string | null;
}

interface PrDecision {
  id: string;
  trail_id: string | null;
  text: string;
  rationale: string | null;
  actor: string | null;
  decided_at: string | null;
  ai_confidence: number | null;
  derived_from: string;
}

interface PrAnomaly {
  id: string;
  kind: 'impl_drift' | 'incomplete_impl' | 'unmerged_long';
  severity: number;
  explanation: string;
  detected_at: string;
}

interface ItemDetailResponse {
  item: WorkItem;
  versions: unknown[];
  linkedItems: LinkedItem[];
  goals: { name: string }[];
  workstreams: unknown[];
  decisions: unknown[];
  prTrail: PrTrailEntry[];
  prDecisions: PrDecision[];
  prAnomalies: PrAnomaly[];
}

const SOURCE_LABEL: Record<string, string> = {
  jira: 'Jira',
  slack: 'Slack',
  granola: 'Granola',
  meetings: 'Granola',
  notion: 'Notion',
  gmail: 'Gmail',
  github: 'GitHub',
};

const SOURCE_CODE: Record<string, string> = {
  jira: 'JRA',
  slack: 'SLK',
  granola: 'MTG',
  meetings: 'MTG',
  notion: 'NOT',
  gmail: 'GML',
  github: 'GIT',
};

export function ItemDetailDrawer({
  itemId,
  onClose,
}: {
  itemId: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<ItemDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const open = !!itemId;

  useEffect(() => {
    if (!itemId) {
      setData(null);
      return;
    }
    setLoading(true);
    fetch(`/api/items/${itemId}`)
      .then((r) => r.json())
      .then((json: ItemDetailResponse) => setData(json))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [itemId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={`drawer-scrim ${open ? 'open' : ''}`} onClick={onClose} />
      <aside className={`drawer wide ${open ? 'open' : ''}`} role="dialog" aria-label="Item details">
        <button
          className="drawer-close"
          style={{ position: 'absolute', top: 14, right: 14, zIndex: 2 }}
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
        {loading && (
          <div className="drawer-body">
            <span style={{ fontSize: 13, color: 'var(--ink-4)' }}>Loading…</span>
          </div>
        )}
        {!loading && data && <ItemDetailBody data={data} />}
        {!loading && !data && open && (
          <div className="drawer-body">
            <span style={{ fontSize: 13, color: 'var(--ink-4)' }}>Could not load this item.</span>
          </div>
        )}
      </aside>
    </>
  );
}

function ItemDetailBody({ data }: { data: ItemDetailResponse }) {
  const { item, linkedItems, goals, prTrail, prDecisions, prAnomalies } = data;
  const src = item.source.toLowerCase();
  const srcLabel = SOURCE_LABEL[src] ?? item.source;
  const srcCode = SOURCE_CODE[src] ?? item.source.slice(0, 3).toUpperCase();
  const isJira = src === 'jira';
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenInfo, setRegenInfo] = useState<string | null>(null);

  const handleRegen = async () => {
    setRegenLoading(true);
    setRegenInfo(null);
    try {
      const res = await fetch(`/api/items/${item.id}/refresh-trail-summary`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setRegenInfo(`Failed: ${json.error ?? 'unknown'}`);
      } else {
        setRegenInfo(
          `Updated · ${json.trailCount ?? 0} trail entries · ${json.decisionCount ?? 0} decisions · ${json.anomalyCount ?? 0} anomalies`,
        );
        // Best-effort refresh — re-fetch the item details on next open.
        // (We don't have a setData up here without lifting state; reload-on-next-open is fine.)
      }
    } catch (err: any) {
      setRegenInfo(`Failed: ${err?.message ?? String(err)}`);
    }
    setRegenLoading(false);
  };

  return (
    <>
      <div className="drawer-head" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
        <span className="drawer-kicker">
          {srcLabel} · {item.item_type} · {item.source_id}
        </span>
      </div>
      <div className="drawer-body">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <span className={`src-badge src-${src}`}>{srcCode}</span>
          {item.status && (
            <span className={`lw-state state-${item.status}`}>{item.status.replace(/_/g, ' ')}</span>
          )}
          {item.priority && <PriorityPill value={item.priority} />}
        </div>

        <h2>{item.title}</h2>

        <div
          className="item-detail-kv"
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '8px 14px',
            padding: '12px 14px',
            background: 'var(--bone-2)',
            border: '1px solid var(--rule)',
            borderRadius: 6,
            marginTop: 14,
            marginBottom: 18,
          }}
        >
          <KV k="Source" v={srcLabel} />
          <KV k="Type" v={item.item_type} mono />
          {item.author && <KV k="Author" v={item.author} />}
          {item.status && (
            <KVNode k="Status">
              <span className={`lw-state state-${item.status}`}>
                {item.status.replace(/_/g, ' ')}
              </span>
            </KVNode>
          )}
          {item.priority && (
            <KVNode k="Priority">
              <PriorityPill value={item.priority} />
            </KVNode>
          )}
          <KV k="Created" v={fmtDate(item.created_at)} />
          {item.updated_at && <KV k="Updated" v={fmtDate(item.updated_at)} />}
          {goals.length > 0 && <KV k="Goals" v={goals.map((g) => g.name).join(' · ')} />}
        </div>

        {(item.summary || item.body) && (
          <div className="drawer-section">
            <h4>{item.summary ? 'Summary' : 'Description'}</h4>
            <div
              style={{
                fontSize: 14,
                lineHeight: 1.6,
                color: 'var(--ink-2)',
                padding: 16,
                background: 'var(--bg)',
                border: '1px solid var(--rule)',
                borderRadius: 8,
              }}
            >
              <Markdown>{item.summary || item.body || ''}</Markdown>
            </div>
          </div>
        )}

        {linkedItems.length > 0 && (
          <div className="drawer-section">
            <h4>
              Linked work <span style={{ color: 'var(--ink-5)' }}>· {linkedItems.length}</span>
            </h4>
            <ul className="item-linked">
              {linkedItems.slice(0, 25).map((l) => {
                const ls = l.source.toLowerCase();
                return (
                  <li key={l.linked_item_id}>
                    <span className={`src-badge src-${ls}`}>
                      {SOURCE_CODE[ls] ?? l.source.slice(0, 3).toUpperCase()}
                    </span>
                    <span className="lw-id">{l.source_id}</span>
                    <span className="lw-title">{l.title}</span>
                    {l.status && (
                      <span className={`lw-state state-${l.status}`}>
                        {l.status.replace(/_/g, ' ')}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {isJira && (item.pr_summary || prTrail.length > 0) && (
          <div className="drawer-section">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <h4>How was this addressed</h4>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {item.pr_summary_generated_at && (
                  <span style={{ fontSize: 11, color: 'var(--ink-5)' }}>
                    updated {fmtDate(item.pr_summary_generated_at)}
                  </span>
                )}
                <button
                  className="btn btn-ghost"
                  onClick={handleRegen}
                  disabled={regenLoading}
                  style={{ fontSize: 12, padding: '4px 10px' }}
                >
                  {regenLoading ? 'Regenerating…' : 'Regenerate'}
                </button>
              </div>
            </div>
            {item.pr_summary ? (
              <div
                style={{
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: 'var(--ink-2)',
                  padding: 16,
                  background: 'var(--bg)',
                  border: '1px solid var(--rule)',
                  borderRadius: 8,
                }}
              >
                <Markdown>{item.pr_summary}</Markdown>
              </div>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--ink-4)' }}>
                No summary yet. PRs are linked but the AI hasn&apos;t synthesized them yet — try Regenerate.
              </p>
            )}
            {regenInfo && (
              <p style={{ fontSize: 11, color: 'var(--ink-5)', marginTop: 8 }}>{regenInfo}</p>
            )}
          </div>
        )}

        {isJira && item.gap_analysis && (item.gap_analysis.status !== 'unknown' || item.gap_analysis.shipped.length > 0 || item.gap_analysis.missing.length > 0) && (() => {
          // Build a trail-id → PR ref/url map so any leftover [trail:UUID]
          // citations (older data, or model drift past the new prompt) render
          // as clickable PR chips instead of bare UUIDs.
          const trailMap = new Map<string, { pr_ref: string; pr_url: string | null }>();
          for (const t of prTrail) trailMap.set(t.id, { pr_ref: t.pr_ref, pr_url: t.pr_url });
          return (
            <div className="drawer-section">
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                <h4>Fulfillment</h4>
                <GapStatusPill status={item.gap_analysis.status} />
              </div>
              {item.gap_analysis.notes && (
                <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 8, marginBottom: 14 }}>
                  {renderWithTrailRefs(item.gap_analysis.notes, trailMap)}
                </p>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <ShippedMissingList
                  heading={`Shipped (${item.gap_analysis.shipped.length})`}
                  items={item.gap_analysis.shipped}
                  tone="good"
                  emptyText="None of the asked work landed in the linked PRs."
                  trailMap={trailMap}
                />
                <ShippedMissingList
                  heading={`Missing (${item.gap_analysis.missing.length})`}
                  items={item.gap_analysis.missing}
                  tone="warn"
                  emptyText="Nothing flagged as missing."
                  trailMap={trailMap}
                />
              </div>
            </div>
          );
        })()}

        {isJira && prAnomalies.length > 0 && (
          <div className="drawer-section">
            <h4>
              Implementation anomalies{' '}
              <span style={{ color: 'var(--ink-5)' }}>· {prAnomalies.length}</span>
            </h4>
            <ul className="item-pr-anomalies">
              {prAnomalies.map((a) => (
                <li key={a.id} className="item-pr-anomaly">
                  <span className={`tracker-anomaly-kind tracker-anomaly-${a.kind}`}>
                    {a.kind.replace(/_/g, ' ')}
                  </span>
                  <span className="item-pr-anomaly-text">{a.explanation}</span>
                  <span className="item-pr-anomaly-sev">sev {Math.round(a.severity * 100)}%</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {isJira && prTrail.length > 0 && (
          <div className="drawer-section">
            <h4>
              PR trail <span style={{ color: 'var(--ink-5)' }}>· {prTrail.length} events</span>
            </h4>
            <ul className="item-pr-trail">
              {prTrail.map((t) => (
                <li key={t.id} className={`item-pr-trail-entry kind-${t.kind}`}>
                  <span className="trail-kind">{t.kind.replace('pr_', '')}</span>
                  {t.pr_url ? (
                    <a className="trail-pr-ref" href={t.pr_url} target="_blank" rel="noreferrer">
                      {t.pr_ref}
                    </a>
                  ) : (
                    <span className="trail-pr-ref">{t.pr_ref}</span>
                  )}
                  {t.actor && <span className="trail-actor">@{t.actor}</span>}
                  {t.state && (
                    <span className={`trail-state state-${t.state.replace(/_/g, '-').toLowerCase()}`}>
                      {t.state.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  )}
                  <span className="trail-time">{fmtDate(t.occurred_at)}</span>
                  {t.diff_summary && (t.diff_summary.additions != null || t.diff_summary.deletions != null) && (
                    <span className="trail-diff">
                      +{t.diff_summary.additions ?? '?'}/-{t.diff_summary.deletions ?? '?'}
                    </span>
                  )}
                  {t.match_status === 'ai_matched' && (
                    <span className="trail-ai-tag" title={`AI-matched (confidence ${t.match_confidence ?? '?'})`}>
                      ai-matched
                    </span>
                  )}
                  {t.functional_summary && t.kind === 'pr_opened' && (
                    <p style={{ flexBasis: '100%', fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>
                      {t.functional_summary}
                    </p>
                  )}
                  {t.body && t.kind === 'pr_review' && (
                    <details className="trail-body">
                      <summary>review notes</summary>
                      <pre>{t.body}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {isJira && prDecisions.length > 0 && (
          <div className="drawer-section">
            <h4>
              Decisions <span style={{ color: 'var(--ink-5)' }}>· {prDecisions.length}</span>
            </h4>
            <ul className="item-pr-decisions">
              {prDecisions.map((d) => (
                <li key={d.id} className="item-pr-decision">
                  <p className="decision-text">{d.text}</p>
                  {d.rationale && <p className="decision-rationale">{d.rationale}</p>}
                  <div className="decision-meta">
                    {d.actor && <span>@{d.actor}</span>}
                    {d.decided_at && <span>{fmtDate(d.decided_at)}</span>}
                    {d.ai_confidence != null && (
                      <span title="AI confidence">conf {Math.round(d.ai_confidence * 100)}%</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="drawer-actions">
        {item.url && (
          <a className="btn btn-primary" href={item.url} target="_blank" rel="noreferrer">
            Open in {srcLabel}
          </a>
        )}
      </div>
    </>
  );
}

function KVNode({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'contents' }}>
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--ink-5)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          alignSelf: 'center',
        }}
      >
        {k}
      </span>
      <span style={{ alignSelf: 'center' }}>{children}</span>
    </div>
  );
}

function KV({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <KVNode k={k}>
      <span
        style={{
          fontSize: 13,
          color: 'var(--ink-2)',
          fontFamily: mono ? 'var(--mono)' : 'inherit',
        }}
      >
        {v}
      </span>
    </KVNode>
  );
}

function PriorityPill({ value }: { value: string }) {
  const level = (value.match(/^p\d/i)?.[0] ?? '').toLowerCase();
  return (
    <span className="item-priority" data-level={level || undefined}>
      {value}
    </span>
  );
}

function fmtDate(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function GapStatusPill({ status }: { status: GapAnalysis['status'] }) {
  const label =
    status === 'complete' ? 'Complete'
    : status === 'partial' ? 'Partially Shipped'
    : status === 'gap' ? 'Implementation Gap'
    : 'Unknown';
  // Tone palette matches the existing anomaly chips so the page stays calm.
  const bg =
    status === 'complete' ? '#0f8a4a'
    : status === 'partial' ? '#c4790a'
    : status === 'gap' ? '#b13434'
    : 'var(--ink-5)';
  return (
    <span
      style={{
        background: bg,
        color: '#fff',
        fontSize: 10,
        fontWeight: 600,
        padding: '3px 8px',
        borderRadius: 999,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >
      {label}
    </span>
  );
}

function ShippedMissingList({
  heading,
  items,
  tone,
  emptyText,
  trailMap,
}: {
  heading: string;
  items: string[];
  tone: 'good' | 'warn';
  emptyText: string;
  trailMap: Map<string, { pr_ref: string; pr_url: string | null }>;
}) {
  const accent = tone === 'good' ? '#0f8a4a' : '#c4790a';
  return (
    <div>
      <h5 style={{ fontSize: 11, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-5)', margin: '0 0 6px 0' }}>
        {heading}
      </h5>
      {items.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--ink-5)', margin: 0 }}>{emptyText}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((line, i) => (
            <li
              key={i}
              style={{
                fontSize: 13,
                lineHeight: 1.45,
                color: 'var(--ink-2)',
                paddingLeft: 10,
                borderLeft: `2px solid ${accent}`,
              }}
            >
              {renderWithTrailRefs(line, trailMap)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Matches "[trail:<uuid>]" citations the model occasionally embeds inside
// gap_analysis prose. We resolve each to a PR chip so the UUID becomes
// useful (clickable, scannable) instead of noise.
const TRAIL_REF_REGEX = /\[trail:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

function renderWithTrailRefs(
  text: string,
  trailMap: Map<string, { pr_ref: string; pr_url: string | null }>,
): React.ReactNode {
  if (!text) return text;
  if (!TRAIL_REF_REGEX.test(text)) return text;
  TRAIL_REF_REGEX.lastIndex = 0; // reset after the test() above
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = TRAIL_REF_REGEX.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const trail = trailMap.get(m[1].toLowerCase());
    if (trail) {
      const repoSegment = trail.pr_ref.split('/').pop() ?? trail.pr_ref; // "repo#123" instead of full owner/repo#123
      const chip = (
        <span
          key={key++}
          style={{
            display: 'inline-block',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            padding: '1px 6px',
            margin: '0 2px',
            background: 'var(--bone-2)',
            border: '1px solid var(--rule)',
            borderRadius: 4,
            color: 'var(--ink-2)',
            verticalAlign: 'baseline',
          }}
        >
          {trail.pr_url ? (
            <a href={trail.pr_url} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
              {repoSegment}
            </a>
          ) : (
            repoSegment
          )}
        </span>
      );
      parts.push(chip);
    } else {
      // Trail isn't in our map (stale citation). Suppress the UUID entirely
      // — surfacing a bare UUID adds zero value to the reader.
      parts.push(<span key={key++} style={{ fontSize: 11, color: 'var(--ink-5)' }}>(unknown PR)</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
