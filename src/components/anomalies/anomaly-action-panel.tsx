'use client';

import { useMemo, useState } from 'react';

interface AnomalyEvidence {
  id: string;
  source_id: string;
  title: string;
  url: string | null;
}

export interface AnomalyForActionPanel {
  id: string;
  kind: string;
  severity: number;
  explanation: string | null;
  evidence: AnomalyEvidence[];
  scope: string;
  action_item_id?: string | null;
  jira_issue_key?: string | null;
  handled_at?: string | null;
  dismissed_by_user?: number;
}

interface Props {
  anomaly: AnomalyForActionPanel;
  /** Used as default project key for Jira ticket creation. */
  projectKey: string;
  /** Optional pre-known issue types from the project. Falls back to ['Task','Bug','Story']. */
  issueTypes?: string[];
  /** Called after a successful action so the parent can refresh data. */
  onActioned: () => void;
}

const DEFAULT_ISSUE_TYPES = ['Task', 'Bug', 'Story'];
const PRIORITIES = ['p0', 'p1', 'p2', 'p3'];

function buildDefaultTitle(a: AnomalyForActionPanel): string {
  // The kind is structural ("incomplete_impl") and the explanation is the
  // human language. A good default ticket title leads with the action.
  const subject = a.evidence[0]?.source_id ?? a.kind.replace(/_/g, ' ');
  const explanation = (a.explanation ?? a.kind).split('.')[0].slice(0, 110);
  return `${a.kind.replace(/_/g, ' ')}: ${explanation}${subject && !explanation.includes(subject) ? ` (${subject})` : ''}`.slice(0, 160);
}

function buildDefaultBody(a: AnomalyForActionPanel): string {
  const lines: string[] = [];
  if (a.explanation) lines.push(a.explanation);
  lines.push('');
  lines.push(`Detected by: workgraph anomaly scan (${a.kind}, severity ${Math.round(a.severity * 100)}%).`);
  if (a.evidence.length > 0) {
    lines.push('');
    lines.push('Evidence:');
    for (const ev of a.evidence) {
      const link = ev.url ? `${ev.source_id} — ${ev.title} (${ev.url})` : `${ev.source_id} — ${ev.title}`;
      lines.push(`- ${link}`);
    }
  }
  return lines.join('\n');
}

type Mode = 'closed' | 'action_item' | 'jira_ticket';

export function AnomalyActionPanel({ anomaly, projectKey, issueTypes, onActioned }: Props) {
  const [mode, setMode] = useState<Mode>('closed');
  const [busy, setBusy] = useState<'action_item' | 'jira_ticket' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handled = !!anomaly.handled_at;
  const dismissed = anomaly.dismissed_by_user === 1 && !anomaly.action_item_id && !anomaly.jira_issue_key;

  const defaultTitle = useMemo(() => buildDefaultTitle(anomaly), [anomaly]);
  const defaultBody = useMemo(() => buildDefaultBody(anomaly), [anomaly]);

  // Form state — we keep a single shared title/body since both action items
  // and tickets describe the same thing. Action items don't need a body, but
  // we still let the user write one for a notes field.
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState(defaultBody);
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState<string>('p2');
  const [jiraProject, setJiraProject] = useState(projectKey);
  const [jiraIssueType, setJiraIssueType] = useState((issueTypes ?? DEFAULT_ISSUE_TYPES)[0]);
  const [dismissAfter, setDismissAfter] = useState(true);

  // Already handled — render a tight summary chip instead of the form.
  if (handled) {
    return (
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 8 }}>
        {anomaly.action_item_id && (
          <span style={{ background: '#0f8a4a', color: '#fff', padding: '2px 8px', borderRadius: 999, fontWeight: 600, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            ✓ Action item created
          </span>
        )}
        {anomaly.jira_issue_key && (
          <span style={{ background: '#0f8a4a', color: '#fff', padding: '2px 8px', borderRadius: 999, fontWeight: 600, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            ✓ {anomaly.jira_issue_key}
          </span>
        )}
        {dismissed && (
          <span style={{ background: 'var(--ink-5)', color: '#fff', padding: '2px 8px', borderRadius: 999, fontWeight: 600, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Dismissed
          </span>
        )}
        <span style={{ color: 'var(--ink-5)' }}>{fmtDate(anomaly.handled_at!)}</span>
      </div>
    );
  }

  const submitActionItem = async () => {
    setBusy('action_item');
    setError(null);
    try {
      const res = await fetch(`/api/anomalies/${anomaly.id}/action-item`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: title.trim() || defaultTitle,
          handled_note: body.trim() || null,
          assignee: assignee.trim() || null,
          user_priority: priority || null,
          dismiss: dismissAfter,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      onActioned();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const submitJiraTicket = async () => {
    setBusy('jira_ticket');
    setError(null);
    try {
      const res = await fetch(`/api/anomalies/${anomaly.id}/jira-ticket`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          summary: title.trim() || defaultTitle,
          description: body.trim() || defaultBody,
          project_key: jiraProject.trim().toUpperCase(),
          issue_type: jiraIssueType,
          dismiss: dismissAfter,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      onActioned();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async () => {
    setBusy('dismiss');
    setError(null);
    try {
      const res = await fetch(`/api/anomalies/${anomaly.id}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      onActioned();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (mode === 'closed') {
    return (
      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => setMode('action_item')}
          style={btnStyle('ghost')}
          disabled={busy !== null}
        >
          + Action Item
        </button>
        <button
          type="button"
          onClick={() => setMode('jira_ticket')}
          style={btnStyle('ghost')}
          disabled={busy !== null}
        >
          + Jira Ticket
        </button>
        <button
          type="button"
          onClick={dismiss}
          style={btnStyle('subtle')}
          disabled={busy !== null}
        >
          {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
        </button>
        {error && <span style={{ fontSize: 11, color: '#b13434' }}>{error}</span>}
      </div>
    );
  }

  // Form panel — same fields, slightly different submit
  const isJira = mode === 'jira_ticket';
  return (
    <div
      style={{
        marginTop: 10,
        padding: 12,
        background: 'var(--bone-2)',
        border: '1px solid var(--rule)',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-5)' }}>
          {isJira ? 'New Jira Ticket' : 'New Action Item'} — review &amp; submit
        </span>
        <button type="button" onClick={() => setMode('closed')} style={btnStyle('subtle')} disabled={busy !== null}>
          Cancel
        </button>
      </div>

      <label style={labelStyle}>{isJira ? 'Summary' : 'Action item text'}</label>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        style={inputStyle}
        disabled={busy !== null}
      />

      <label style={labelStyle}>{isJira ? 'Description' : 'Notes (optional)'}</label>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12 }}
        disabled={busy !== null}
      />

      {isJira ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <label style={labelStyle}>Project key</label>
            <input
              type="text"
              value={jiraProject}
              onChange={(e) => setJiraProject(e.target.value.toUpperCase())}
              style={inputStyle}
              disabled={busy !== null}
            />
          </div>
          <div>
            <label style={labelStyle}>Issue type</label>
            <select
              value={jiraIssueType}
              onChange={(e) => setJiraIssueType(e.target.value)}
              style={inputStyle}
              disabled={busy !== null}
            >
              {(issueTypes ?? DEFAULT_ISSUE_TYPES).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <label style={labelStyle}>Assignee (optional)</label>
            <input
              type="text"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder="email or handle"
              style={inputStyle}
              disabled={busy !== null}
            />
          </div>
          <div>
            <label style={labelStyle}>Priority</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              style={inputStyle}
              disabled={busy !== null}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{p.toUpperCase()}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <input
          type="checkbox"
          checked={dismissAfter}
          onChange={(e) => setDismissAfter(e.target.checked)}
          disabled={busy !== null}
        />
        Mark anomaly handled / dismiss after submit
      </label>

      {error && (
        <p style={{ fontSize: 12, color: '#b13434', margin: 0 }}>
          {error}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        <button
          type="button"
          onClick={isJira ? submitJiraTicket : submitActionItem}
          style={btnStyle('primary')}
          disabled={busy !== null || title.trim().length === 0}
        >
          {busy === mode
            ? (isJira ? 'Creating ticket…' : 'Saving…')
            : (isJira ? 'Create Jira Ticket' : 'Save Action Item')}
        </button>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  fontFamily: 'var(--mono)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--ink-5)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  fontSize: 13,
  background: 'var(--paper)',
  border: '1px solid var(--rule)',
  borderRadius: 4,
  fontFamily: 'inherit',
  color: 'var(--ink-2)',
};

function btnStyle(variant: 'primary' | 'ghost' | 'subtle'): React.CSSProperties {
  if (variant === 'primary') {
    return {
      fontSize: 12,
      padding: '6px 12px',
      background: 'var(--ink)',
      color: 'var(--paper)',
      border: '1px solid var(--ink)',
      borderRadius: 4,
      cursor: 'pointer',
      fontWeight: 600,
    };
  }
  if (variant === 'ghost') {
    return {
      fontSize: 11,
      padding: '4px 10px',
      background: 'var(--paper)',
      color: 'var(--ink-2)',
      border: '1px solid var(--rule)',
      borderRadius: 4,
      cursor: 'pointer',
      fontFamily: 'inherit',
    };
  }
  return {
    fontSize: 11,
    padding: '4px 10px',
    background: 'transparent',
    color: 'var(--ink-4)',
    border: '1px solid transparent',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}
