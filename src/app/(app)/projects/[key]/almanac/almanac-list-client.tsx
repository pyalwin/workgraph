'use client';

/**
 * AlmanacListClient
 *
 * Shows all almanac docs for a project with a "Generate new" button.
 * The generate button opens an inline form to pick repo + ref, then
 * POSTs /api/almanac/docs and navigates to the doc detail page.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface DocRow {
  id: string;
  repo_key: string;
  ref: string;
  status: string;
  created_at: string;
  completed_at: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  outlining: 'Outlining',
  drafting: 'Drafting',
  complete: 'Complete',
  failed: 'Failed',
};

const STATUS_COLOR: Record<string, string> = {
  outlining: 'var(--amber)',
  drafting: 'var(--amber)',
  complete: 'var(--green)',
  failed: 'var(--red)',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 9px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: `color-mix(in srgb, ${STATUS_COLOR[status] ?? 'var(--ink-5)'} 12%, transparent)`,
        color: STATUS_COLOR[status] ?? 'var(--ink-5)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

interface AgentStatus {
  paired: boolean;
  online: boolean;
  ready: boolean;
  issues: string[];
  agent: {
    id: string;
    hostname: string | null;
    platform: string | null;
    version: string | null;
    lastSeenAt: string | null;
    claudeAvailable: boolean;
    claudeVersion: string | null;
  } | null;
}

interface GenerateFormProps {
  projectKey: string;
  onCancel: () => void;
  onCreated: (docId: string) => void;
}

function GenerateForm({ projectKey, onCancel, onCreated }: GenerateFormProps) {
  const [repoKey, setRepoKey] = useState('');
  const [ref, setRef] = useState('main');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // Fetch agent status on mount and refresh every 15s while the form is open.
  useEffect(() => {
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const res = await fetch(
          `/api/almanac/agent-status?projectKey=${encodeURIComponent(projectKey)}`,
        );
        if (!res.ok) {
          if (!cancelled) setStatusLoading(false);
          return;
        }
        const json = (await res.json()) as AgentStatus;
        if (!cancelled) {
          setAgentStatus(json);
          setStatusLoading(false);
        }
      } catch {
        if (!cancelled) setStatusLoading(false);
      }
    };
    void fetchStatus();
    const interval = setInterval(fetchStatus, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [projectKey]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedRepo = repoKey.trim();
    if (!trimmedRepo) { setError('Repository is required (e.g. owner/name)'); return; }
    if (!trimmedRepo.includes('/')) { setError('Use format: owner/repo'); return; }
    if (!agentStatus?.ready) { setError('Agent is not ready — see status above.'); return; }

    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/almanac/docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectKey, repoKey: trimmedRepo, ref: ref.trim() || 'main' }),
      });
      const data = (await res.json()) as { doc_id?: string; error?: string };
      if (!res.ok || !data.doc_id) {
        setError(data.error ?? 'Failed to create doc');
        setBusy(false);
        return;
      }
      onCreated(data.doc_id);
    } catch {
      setError('Network error — please try again');
      setBusy(false);
    }
  };

  const ready = !!agentStatus?.ready;
  const submitDisabled = busy || !ready;

  return (
    <div style={formStyles.card}>
      <div style={formStyles.head}>
        <span style={formStyles.title}>Generate almanac doc</span>
        <button type="button" onClick={onCancel} style={formStyles.closeBtn} aria-label="Cancel">✕</button>
      </div>
      <AgentStatusBanner status={agentStatus} loading={statusLoading} />
      <form onSubmit={handleSubmit} style={formStyles.form}>
        <div style={formStyles.field}>
          <label style={formStyles.label} htmlFor="al-repo">Repository</label>
          <input
            id="al-repo"
            type="text"
            value={repoKey}
            onChange={(e) => setRepoKey(e.target.value)}
            placeholder="owner/repo"
            style={formStyles.input}
            disabled={busy}
            autoFocus
          />
          <span style={formStyles.hint}>GitHub repo in owner/name format</span>
        </div>
        <div style={formStyles.field}>
          <label style={formStyles.label} htmlFor="al-ref">Branch / ref</label>
          <input
            id="al-ref"
            type="text"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="main"
            style={formStyles.input}
            disabled={busy}
          />
        </div>

        {error && <div style={formStyles.error}>{error}</div>}

        <div style={formStyles.actions}>
          <button type="button" onClick={onCancel} style={formStyles.cancelBtn} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            style={{ ...formStyles.submitBtn, opacity: submitDisabled ? 0.5 : 1 }}
            disabled={submitDisabled}
            title={!ready ? 'Agent must be ready before generating' : undefined}
          >
            {busy ? 'Creating…' : 'Generate'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Agent status banner                                                  */
/* ------------------------------------------------------------------ */

function AgentStatusBanner({
  status,
  loading,
}: {
  status: AgentStatus | null;
  loading: boolean;
}) {
  if (loading && !status) {
    return (
      <div style={bannerStyles.checking}>Checking agent status…</div>
    );
  }
  if (!status) return null;

  if (status.ready && status.agent) {
    const label = status.agent.hostname
      ? `Agent ready — ${status.agent.hostname}${status.agent.platform ? ` · ${status.agent.platform}` : ''}`
      : 'Agent ready';
    return (
      <div style={bannerStyles.ready}>
        <span aria-hidden style={{ ...bannerStyles.dot, background: 'var(--green)' }} />
        <span>{label}</span>
        {status.agent.claudeVersion && (
          <span style={bannerStyles.muted}>· Claude CLI {status.agent.claudeVersion}</span>
        )}
      </div>
    );
  }

  // Not ready — render the most actionable issue with a remediation hint.
  if (!status.paired) {
    return (
      <div style={bannerStyles.warn}>
        <span aria-hidden style={{ ...bannerStyles.dot, background: 'var(--amber)' }} />
        <div style={bannerStyles.body}>
          <strong>No local agent paired for this workspace.</strong>
          <p style={bannerStyles.text}>
            Almanac generation runs on a machine you control. Install the agent and pair it before generating.
          </p>
          <pre style={bannerStyles.cmd}>npm i -g @workgraph/agent && workgraph login</pre>
        </div>
      </div>
    );
  }

  if (!status.online) {
    return (
      <div style={bannerStyles.warn}>
        <span aria-hidden style={{ ...bannerStyles.dot, background: 'var(--amber)' }} />
        <div style={bannerStyles.body}>
          <strong>Agent is offline.</strong>
          <p style={bannerStyles.text}>
            {status.agent?.hostname ? `${status.agent.hostname} ` : ''}
            hasn&apos;t checked in recently. Start the runner with{' '}
            <code style={bannerStyles.codeInline}>workgraph run</code> on that machine.
          </p>
        </div>
      </div>
    );
  }

  if (status.agent && !status.agent.claudeAvailable) {
    return (
      <div style={bannerStyles.warn}>
        <span aria-hidden style={{ ...bannerStyles.dot, background: 'var(--amber)' }} />
        <div style={bannerStyles.body}>
          <strong>Claude CLI not detected on the agent.</strong>
          <p style={bannerStyles.text}>
            Install Claude CLI and authenticate, then the agent will pick it up on its next heartbeat.
          </p>
          <pre style={bannerStyles.cmd}>claude /login</pre>
        </div>
      </div>
    );
  }

  // Generic fallback — show whatever issues the server reported.
  return (
    <div style={bannerStyles.warn}>
      <span aria-hidden style={{ ...bannerStyles.dot, background: 'var(--amber)' }} />
      <div style={bannerStyles.body}>
        <strong>Agent not ready.</strong>
        <ul style={bannerStyles.issueList}>
          {status.issues.map((i, idx) => (
            <li key={idx}>{i}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const bannerStyles = {
  ready: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    marginBottom: 14,
    background: 'rgba(47, 107, 61, 0.06)',
    border: '1px solid rgba(47, 107, 61, 0.18)',
    borderRadius: 6,
    fontSize: 13,
    color: 'var(--ink-2)',
  } as React.CSSProperties,

  warn: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '10px 14px',
    marginBottom: 14,
    background: 'rgba(180, 90, 30, 0.06)',
    border: '1px solid rgba(180, 90, 30, 0.22)',
    borderRadius: 6,
    fontSize: 13,
    color: 'var(--ink-2)',
  } as React.CSSProperties,

  checking: {
    padding: '8px 12px',
    marginBottom: 14,
    fontSize: 12,
    color: 'var(--ink-4)',
    fontStyle: 'italic',
  } as React.CSSProperties,

  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
    marginTop: 5,
  } as React.CSSProperties,

  body: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,

  text: {
    margin: 0,
    fontSize: 12,
    color: 'var(--ink-3)',
    lineHeight: 1.5,
  } as React.CSSProperties,

  cmd: {
    margin: '4px 0 0',
    padding: '6px 10px',
    background: 'var(--bone-2)',
    border: '1px solid var(--rule)',
    borderRadius: 4,
    fontSize: 12,
    fontFamily: 'var(--mono)',
    color: 'var(--ink-2)',
    overflowX: 'auto' as const,
  } as React.CSSProperties,

  codeInline: {
    fontFamily: 'var(--mono)',
    fontSize: '0.92em',
    background: 'var(--bone-2)',
    padding: '0 4px',
    borderRadius: 3,
  } as React.CSSProperties,

  muted: {
    fontSize: 12,
    color: 'var(--ink-5)',
  } as React.CSSProperties,

  issueList: {
    margin: '4px 0 0',
    paddingLeft: 18,
    fontSize: 12,
    color: 'var(--ink-3)',
    lineHeight: 1.5,
  } as React.CSSProperties,
} as const;

const formStyles = {
  card: {
    background: 'var(--paper)',
    border: '1px solid var(--rule-2)',
    borderRadius: 10,
    padding: '20px 24px',
    marginBottom: 24,
    boxShadow: '0 2px 12px rgba(21,20,15,0.07)',
  } as React.CSSProperties,
  head: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  } as React.CSSProperties,
  title: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--ink)',
  } as React.CSSProperties,
  closeBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--ink-4)',
    fontSize: 16,
    lineHeight: 1,
    padding: '2px 4px',
  } as React.CSSProperties,
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 14,
  } as React.CSSProperties,
  field: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  } as React.CSSProperties,
  label: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--ink-3)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  } as React.CSSProperties,
  input: {
    padding: '8px 10px',
    border: '1px solid var(--rule-2)',
    borderRadius: 6,
    fontSize: 13,
    background: 'var(--bone)',
    color: 'var(--ink)',
    fontFamily: 'var(--mono)',
    outline: 'none',
    width: '100%',
  } as React.CSSProperties,
  hint: {
    fontSize: 11,
    color: 'var(--ink-5)',
  } as React.CSSProperties,
  error: {
    padding: '8px 12px',
    background: 'rgba(180,48,27,0.07)',
    border: '1px solid rgba(180,48,27,0.2)',
    borderRadius: 6,
    fontSize: 13,
    color: 'var(--red)',
  } as React.CSSProperties,
  actions: {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
  } as React.CSSProperties,
  cancelBtn: {
    padding: '8px 16px',
    background: 'var(--bone-2)',
    border: '1px solid var(--rule)',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    color: 'var(--ink-2)',
  } as React.CSSProperties,
  submitBtn: {
    padding: '8px 16px',
    background: 'var(--ink)',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    color: 'var(--paper)',
    transition: 'opacity 0.15s',
  } as React.CSSProperties,
} as const;

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export function AlmanacListClient({ projectKey }: { projectKey: string }) {
  const router = useRouter();
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const fetchDocs = useCallback(async () => {
    const res = await fetch(`/api/almanac/docs?projectKey=${encodeURIComponent(projectKey)}`);
    const data = (await res.json()) as { docs?: DocRow[] };
    setDocs(data.docs ?? []);
    setLoading(false);
  }, [projectKey]);

  useEffect(() => {
    void fetchDocs();
  }, [fetchDocs]);

  const handleCreated = (docId: string) => {
    router.push(`/projects/${projectKey.toLowerCase()}/almanac/${docId}`);
  };

  return (
    <div className="proj-page">
      <Link href={`/projects/${projectKey.toLowerCase()}`} className="proj-back">
        <span className="arrow">←</span> Back to project
      </Link>

      <header className="proj-header" style={{ marginBottom: 24 }}>
        <div className="proj-header-row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <p style={{ fontSize: 12, color: 'var(--ink-4)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 4 }}>
              {projectKey}
            </p>
            <h1 className="proj-header-title" style={{ marginBottom: 0 }}>Almanac docs</h1>
          </div>
          {!showForm && (
            <button
              type="button"
              style={{
                padding: '8px 16px',
                background: 'var(--ink)',
                color: 'var(--paper)',
                border: 'none',
                borderRadius: 7,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
              onClick={() => setShowForm(true)}
            >
              + Generate new
            </button>
          )}
        </div>
        <p style={{ fontSize: 13, color: 'var(--ink-4)', marginTop: 8 }}>
          AI-generated techno-functional documentation for your repos.
        </p>
      </header>

      {showForm && (
        <GenerateForm
          projectKey={projectKey}
          onCancel={() => setShowForm(false)}
          onCreated={handleCreated}
        />
      )}

      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>Loading…</div>
      ) : docs.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: '60px 0',
          color: 'var(--ink-4)',
        }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📄</div>
          <p style={{ fontSize: 15, fontWeight: 500, marginBottom: 8, color: 'var(--ink-3)' }}>
            No almanac docs yet
          </p>
          <p style={{ fontSize: 13 }}>
            Generate your first doc to get a comprehensive technical overview of a repo.
          </p>
          {!showForm && (
            <button
              type="button"
              style={{
                marginTop: 20,
                padding: '10px 20px',
                background: 'var(--ink)',
                color: 'var(--paper)',
                border: 'none',
                borderRadius: 7,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
              onClick={() => setShowForm(true)}
            >
              Generate first doc
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {docs.map((doc) => (
            <Link
              key={doc.id}
              href={`/projects/${projectKey.toLowerCase()}/almanac/${doc.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: '14px 16px',
                borderBottom: '1px solid var(--rule)',
                textDecoration: 'none',
                background: 'var(--paper)',
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bone)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--paper)'; }}
            >
              <StatusBadge status={doc.status} />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink-2)', flex: 1, fontWeight: 500 }}>
                {doc.repo_key}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-4)' }}>
                {doc.ref}
              </span>
              <span style={{ fontSize: 12, color: 'var(--ink-5)', whiteSpace: 'nowrap' }}>
                {new Date(doc.created_at).toLocaleDateString()}
              </span>
              {doc.completed_at && (
                <span style={{ fontSize: 12, color: 'var(--green)', whiteSpace: 'nowrap' }}>
                  done {new Date(doc.completed_at).toLocaleDateString()}
                </span>
              )}
              <span style={{ color: 'var(--ink-5)', fontSize: 14 }}>→</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
