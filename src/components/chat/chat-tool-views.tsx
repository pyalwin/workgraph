'use client';

import Link from 'next/link';
import type { UIMessagePart, UIDataTypes, UITools } from 'ai';

type ToolPart = Extract<UIMessagePart<UIDataTypes, UITools>, { type: `tool-${string}` }>;

interface ToolDispatchProps {
  part: ToolPart;
}

const STATE_LABEL: Record<string, string> = {
  'input-streaming': 'Calling',
  'input-available': 'Calling',
  'output-available': 'Done',
  'output-error': 'Failed',
  'output-denied': 'Denied',
  'approval-requested': 'Pending approval',
  'approval-responded': 'Approved',
};

export function ToolPartView({ part }: ToolDispatchProps) {
  const toolName = part.type.slice('tool-'.length);
  const state = part.state ?? 'unknown';

  if (state !== 'output-available') {
    return (
      <div className={`tool-card tool-pending tool-state-${state}`}>
        <ToolIcon name={toolName} />
        <div className="tool-pending-text">
          <span className="tool-pending-label">{STATE_LABEL[state] ?? state}</span>
          <span className="tool-pending-name">{prettyName(toolName)}</span>
        </div>
        {state === 'input-streaming' || state === 'input-available' ? (
          <span className="tool-spinner" aria-hidden />
        ) : null}
        {state === 'output-error' && 'errorText' in part && part.errorText && (
          <span className="tool-error">{part.errorText}</span>
        )}
      </div>
    );
  }

  const output = part.output as unknown;
  if (!output) return null;

  switch (toolName) {
    case 'listProjects':
      return <ProjectsList output={output as ProjectsOut} />;
    case 'getProject':
      return <ProjectDetail output={output as ProjectDetailOut} />;
    case 'findProject':
      return <ProjectChip output={output as FindProjectOut} />;
    case 'listItems':
      return <ItemsList output={output as ItemsOut} />;
    case 'listPRs':
      return <PRsList output={output as PRsOut} />;
    case 'countItems':
    case 'countPRs':
      return <StatNumber output={output as CountOut} toolName={toolName} />;
    case 'groupItems':
      return <GroupBars output={output as GroupOut} />;
    case 'listDecisions':
      return <DecisionsList output={output as DecisionsOut} />;
    case 'searchKnowledge':
      return <SearchResults output={output as SearchOut} />;
    case 'runQuery':
      return <QueryTable output={output as QueryOut} />;
    case 'createNote':
      return <NoteCreated output={output as NoteOut} />;
    default:
      return (
        <div className="tool-card">
          <ToolIcon name={toolName} />
          <span className="tool-pending-name">{prettyName(toolName)}</span>
        </div>
      );
  }
}

function ToolIcon({ name }: { name: string }) {
  const initial = name.match(/^[a-z]/i)?.[0]?.toUpperCase() ?? '·';
  return <span className="tool-icon">{initial}</span>;
}

function prettyName(name: string): string {
  return name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

// ───── tool output types ─────

interface ProjectsOut {
  count: number;
  projects: Array<{
    key: string;
    name: string;
    health: 'healthy' | 'needs_attention' | 'at_risk';
    summary_snippet: string | null;
    completion_pct: number;
    completion_total: number;
    velocity: number;
    open_count: number;
    stale_count: number;
    pr_count: number;
  }>;
}

interface ProjectDetailOut {
  project: { key: string; name: string; total_tickets: number; total_prs: number };
  health: { status: string; summary?: string | null };
  ticket_count: number;
  tickets_by_status: Record<string, number>;
  recent_tickets: Array<{ source_id: string; title: string; status: string }>;
  action_items: Array<{ title: string; owner?: string | null }>;
  okrs: Array<{ title?: string; key_results?: Array<{ text: string }> }>;
}

interface FindProjectOut {
  found: boolean;
  key?: string;
  name?: string;
  query?: string;
  available?: Array<{ key: string; name: string }>;
}

interface ItemsOut {
  count: number;
  items: Array<{
    id: string;
    source: string;
    source_id: string;
    item_type: string;
    title: string;
    status: string | null;
    url: string | null;
  }>;
}

interface PRsOut {
  count: number;
  prs: Array<{
    pr_ref: string;
    pr_url: string | null;
    repo: string | null;
    state: string | null;
    actor: string | null;
    title: string | null;
    occurred_at: string;
  }>;
}

interface CountOut {
  count: number;
  filters?: Record<string, string | undefined>;
  state?: string;
  matched?: string;
}

interface GroupOut {
  groupBy: string;
  rows: Array<{ bucket: string | null; c: number }>;
}

interface DecisionsOut {
  count: number;
  decisions: Array<{ id: string; title: string; decided_at: string; summary: unknown }>;
}

interface SearchOut {
  count: number;
  results: Array<{
    id: string;
    title: string;
    source: string;
    source_id: string;
    item_type: string;
    url: string | null;
    excerpt: string;
  }>;
}

interface QueryOut {
  count?: number;
  rows?: Array<Record<string, unknown>>;
  error?: string;
}

interface NoteOut {
  id: string;
  source_id: string;
  title: string;
}

// ───── components ─────

function ProjectsList({ output }: { output: ProjectsOut }) {
  return (
    <div className="tool-grid">
      {output.projects.map((p) => (
        <Link key={p.key} href={`/projects/${p.key}`} className="proj-card">
          <div className="proj-card-head">
            <span className="proj-card-key">{p.key}</span>
            <HealthDot status={p.health} />
          </div>
          <div className="proj-card-name">{p.name}</div>
          {p.summary_snippet && (
            <div className="proj-card-summary">{p.summary_snippet}</div>
          )}
          <div className="proj-card-stats">
            <Stat label="Done" value={`${p.completion_pct}%`} />
            <Stat label="Open" value={p.open_count.toString()} />
            <Stat label="PRs" value={p.pr_count.toString()} />
          </div>
        </Link>
      ))}
    </div>
  );
}

function ProjectDetail({ output }: { output: ProjectDetailOut }) {
  const statusEntries = Object.entries(output.tickets_by_status);
  return (
    <div className="tool-card-lg">
      <div className="tool-card-lg-head">
        <Link href={`/projects/${output.project.key}`} className="tool-card-lg-title">
          {output.project.name}
        </Link>
        <span className="tool-card-lg-key">{output.project.key}</span>
      </div>
      {output.health?.summary && (
        <p className="tool-card-lg-summary">{output.health.summary}</p>
      )}
      <div className="tool-card-lg-stats">
        <BigStat label="Tickets" value={output.ticket_count} />
        <BigStat label="PRs" value={output.project.total_prs} />
      </div>
      {statusEntries.length > 0 && (
        <div className="tool-status-row">
          {statusEntries.map(([k, v]) => (
            <span key={k} className={`tool-status-pill state-${k}`}>
              {k.replace(/_/g, ' ')} <strong>{v}</strong>
            </span>
          ))}
        </div>
      )}
      {output.recent_tickets.length > 0 && (
        <div className="tool-section">
          <div className="tool-section-head">Recent tickets</div>
          <ul className="tool-list">
            {output.recent_tickets.map((t) => (
              <li key={t.source_id}>
                <span className="tool-list-id">{t.source_id}</span>
                <span className="tool-list-title">{t.title}</span>
                <span className={`tool-list-state state-${t.status}`}>{t.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ProjectChip({ output }: { output: FindProjectOut }) {
  if (!output.found) {
    return (
      <div className="tool-card tool-card-warn">
        <span className="tool-card-warn-text">
          No match for &ldquo;{output.query}&rdquo;.
          {output.available && output.available.length > 0 && ' Available: '}
          {output.available?.map((p) => p.name).join(', ')}
        </span>
      </div>
    );
  }
  return (
    <Link href={`/projects/${output.key}`} className="proj-chip">
      <span className="proj-chip-key">{output.key}</span>
      <span className="proj-chip-name">{output.name}</span>
      <span className="proj-chip-arrow">→</span>
    </Link>
  );
}

function ItemsList({ output }: { output: ItemsOut }) {
  return (
    <div className="tool-card-lg">
      <div className="tool-card-lg-head">
        <span className="tool-card-lg-title">{output.count} items</span>
      </div>
      <ul className="tool-list">
        {output.items.map((i) => {
          const inner = (
            <>
              <span className={`tool-list-source src-${i.source}`}>{i.source}</span>
              <span className="tool-list-id">{i.source_id}</span>
              <span className="tool-list-title">{i.title}</span>
              {i.status && <span className={`tool-list-state state-${i.status}`}>{i.status}</span>}
            </>
          );
          return (
            <li key={i.id}>
              {i.url ? (
                <a href={i.url} target="_blank" rel="noopener noreferrer">{inner}</a>
              ) : inner}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PRsList({ output }: { output: PRsOut }) {
  return (
    <div className="tool-card-lg">
      <div className="tool-card-lg-head">
        <span className="tool-card-lg-title">{output.count} PRs</span>
      </div>
      <ul className="tool-list">
        {output.prs.map((p) => {
          const inner = (
            <>
              <span className="tool-list-source src-github">GH</span>
              <span className="tool-list-id">{p.pr_ref}</span>
              <span className="tool-list-title">{p.title || p.repo}</span>
              {p.state && <span className={`tool-list-state state-${p.state}`}>{p.state}</span>}
            </>
          );
          return (
            <li key={p.pr_ref}>
              {p.pr_url ? (
                <a href={p.pr_url} target="_blank" rel="noopener noreferrer">{inner}</a>
              ) : inner}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StatNumber({ output, toolName }: { output: CountOut; toolName: string }) {
  const filterText = toolName === 'countPRs'
    ? [output.state, output.matched && output.matched !== 'any' ? output.matched : null]
        .filter(Boolean).join(' · ')
    : Object.entries(output.filters ?? {})
        .filter(([, v]) => !!v)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ');
  return (
    <div className="tool-stat">
      <div className="tool-stat-num">{output.count.toLocaleString()}</div>
      <div className="tool-stat-label">
        {toolName === 'countPRs' ? 'PRs' : 'items'}
        {filterText && <span className="tool-stat-filter"> · {filterText}</span>}
      </div>
    </div>
  );
}

function GroupBars({ output }: { output: GroupOut }) {
  const max = Math.max(...output.rows.map((r) => r.c), 1);
  return (
    <div className="tool-card-lg">
      <div className="tool-card-lg-head">
        <span className="tool-card-lg-title">By {output.groupBy}</span>
      </div>
      <div className="tool-bars">
        {output.rows.map((r, i) => (
          <div key={i} className="tool-bar-row">
            <span className="tool-bar-label">{r.bucket ?? '(none)'}</span>
            <div className="tool-bar-track">
              <div className="tool-bar-fill" style={{ width: `${(r.c / max) * 100}%` }} />
            </div>
            <span className="tool-bar-count">{r.c}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DecisionsList({ output }: { output: DecisionsOut }) {
  return (
    <div className="tool-card-lg">
      <div className="tool-card-lg-head">
        <span className="tool-card-lg-title">{output.count} decisions</span>
      </div>
      <ul className="tool-decisions">
        {output.decisions.map((d) => (
          <li key={d.id}>
            <div className="tool-decision-title">{d.title}</div>
            <div className="tool-decision-meta">{formatDate(d.decided_at)}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SearchResults({ output }: { output: SearchOut }) {
  if (output.count === 0) {
    return <div className="tool-card tool-card-warn">No matches.</div>;
  }
  return (
    <div className="tool-card-lg">
      <div className="tool-card-lg-head">
        <span className="tool-card-lg-title">{output.count} matches</span>
      </div>
      <ul className="tool-search">
        {output.results.map((r) => {
          const head = (
            <>
              <span className={`tool-list-source src-${r.source}`}>{r.source}</span>
              <span className="tool-list-id">{r.source_id}</span>
              <span className="tool-search-title">{r.title}</span>
            </>
          );
          return (
            <li key={r.id}>
              {r.url ? (
                <a href={r.url} target="_blank" rel="noopener noreferrer" className="tool-search-head">{head}</a>
              ) : <div className="tool-search-head">{head}</div>}
              {r.excerpt && <div className="tool-search-excerpt">{r.excerpt}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function QueryTable({ output }: { output: QueryOut }) {
  if (output.error) {
    return <div className="tool-card tool-card-warn">Query error: {output.error}</div>;
  }
  const rows = output.rows ?? [];
  if (rows.length === 0) {
    return <div className="tool-card tool-card-warn">Query returned 0 rows.</div>;
  }
  const cols = Object.keys(rows[0]);
  return (
    <div className="tool-card-lg">
      <div className="tool-card-lg-head">
        <span className="tool-card-lg-title">{rows.length} rows</span>
      </div>
      <div className="tool-table-wrap">
        <table className="tool-table">
          <thead>
            <tr>
              {cols.map((c) => <th key={c}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 25).map((row, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c}>{formatCell(row[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NoteCreated({ output }: { output: NoteOut }) {
  return (
    <div className="tool-note">
      <span className="tool-note-icon">✓</span>
      <div className="tool-note-body">
        <div className="tool-note-title">Note saved</div>
        <div className="tool-note-text">{output.title}</div>
      </div>
    </div>
  );
}

// ───── tiny helpers ─────

function HealthDot({ status }: { status: ProjectsOut['projects'][0]['health'] }) {
  const cls = status === 'healthy' ? 'ok' : status === 'at_risk' ? 'warn' : 'mid';
  return <span className={`health-dot health-${cls}`} title={status} />;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="proj-card-stat">
      <span className="proj-card-stat-value">{value}</span>
      <span className="proj-card-stat-label">{label}</span>
    </div>
  );
}

function BigStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="big-stat">
      <span className="big-stat-value">{typeof value === 'number' ? value.toLocaleString() : value}</span>
      <span className="big-stat-label">{label}</span>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatCell(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v).slice(0, 60);
}
