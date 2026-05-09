'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const KIND_OPTIONS = [
  { value: 'jira', label: 'JIRA' },
  { value: 'github', label: 'GitHub' },
  { value: 'slack', label: 'Slack' },
  { value: 'notion', label: 'Notion' },
] as const;

type Kind = (typeof KIND_OPTIONS)[number]['value'];

interface Connector {
  id: string;
  workspaceId: string;
  projectKey: string;
  kind: Kind;
  ref: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const REF_HINTS: Record<Kind, string> = {
  jira: 'JIRA project key (e.g. WG)',
  github: 'owner/repo (e.g. octocat/hello-world)',
  slack: 'Channel ID or name',
  notion: 'Notion database or page ID',
};

export function ProjectSettingsTab({ projectKey }: { projectKey: string }) {
  const router = useRouter();
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectKey}/connectors`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const json = await res.json();
      setConnectors(json.connectors ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function detach(id: string) {
    const res = await fetch(`/api/projects/${projectKey}/connectors/${id}`, { method: 'DELETE' });
    if (res.ok) refresh();
  }

  return (
    <>
      <section className="proj-section">
        <div className="proj-section-head">
          <div>
            <p className="proj-section-eyebrow">Connectors</p>
            <h2 className="proj-section-title">Sources attached to this project</h2>
          </div>
          <button className="proj-section-action" onClick={() => setAttachOpen(true)}>
            + Attach
          </button>
        </div>
        <div className="proj-section-body">
          {loading && <p className="proj-empty">Loading connectors…</p>}
          {error && <p style={{ color: 'var(--red)' }}>{error}</p>}
          {!loading && connectors && connectors.length === 0 && (
            <p className="proj-empty">No connectors attached yet.</p>
          )}
          {connectors && connectors.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {connectors.map((c) => (
                <div
                  key={c.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 12px',
                    border: '1px solid var(--rule)',
                    borderRadius: 8,
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: 'var(--bone-2)',
                      textTransform: 'uppercase',
                    }}
                  >
                    {c.kind}
                  </span>
                  <span style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 13 }}>{c.ref}</span>
                  <button
                    type="button"
                    onClick={() => detach(c.id)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      border: '1px solid var(--rule)',
                      background: 'transparent',
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    Detach
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="proj-section">
        <div className="proj-section-head">
          <div>
            <p className="proj-section-eyebrow" style={{ color: 'var(--red)' }}>Danger zone</p>
            <h2 className="proj-section-title">Delete this project</h2>
          </div>
        </div>
        <div className="proj-section-body">
          <p style={{ color: 'var(--ink-4)', fontSize: 13, marginBottom: 12 }}>
            Deleting a project removes its connectors, AI-generated docs (almanac, README, OKRs),
            and goals. Items synced from connectors are kept (they belong to the workspace).
          </p>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid var(--red)',
              background: 'transparent',
              color: 'var(--red)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Delete project…
          </button>
        </div>
      </section>

      {attachOpen && (
        <AttachConnectorModal
          projectKey={projectKey}
          onClose={() => setAttachOpen(false)}
          onAttached={() => {
            setAttachOpen(false);
            refresh();
          }}
        />
      )}

      {confirmDelete && (
        <DeleteProjectModal
          projectKey={projectKey}
          onClose={() => setConfirmDelete(false)}
          onDeleted={() => router.push('/projects')}
        />
      )}
    </>
  );
}

function AttachConnectorModal({
  projectKey,
  onClose,
  onAttached,
}: {
  projectKey: string;
  onClose: () => void;
  onAttached: () => void;
}) {
  const [kind, setKind] = useState<Kind>('jira');
  const [ref, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ref.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectKey}/connectors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, ref: ref.trim() }),
      });
      if (res.status === 422) {
        setError(`The ${kind} connector isn't configured for this workspace yet.`);
        return;
      }
      if (res.status === 409) {
        const j = await res.json().catch(() => ({}));
        setError(`Already attached to project "${j.conflictingProjectKey ?? 'unknown'}".`);
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(typeof j.error === 'string' ? j.error : `Failed (${res.status})`);
        return;
      }
      onAttached();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Attach connector</h3>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            style={{ padding: '8px 10px', border: '1px solid var(--rule)', borderRadius: 6 }}
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>Reference</span>
          <input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder={REF_HINTS[kind]}
            style={{ padding: '8px 10px', border: '1px solid var(--rule)', borderRadius: 6, fontFamily: 'var(--mono)' }}
          />
          <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>{REF_HINTS[kind]}</span>
        </label>

        {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={{ padding: '6px 12px', border: '1px solid var(--rule)', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ref.trim() || submitting}
            style={{
              padding: '6px 12px',
              border: 0,
              borderRadius: 6,
              background: ref.trim() && !submitting ? 'var(--ink)' : 'var(--ink-4)',
              color: 'var(--paper)',
              cursor: ref.trim() && !submitting ? 'pointer' : 'default',
            }}
          >
            {submitting ? 'Attaching…' : 'Attach'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function DeleteProjectModal({
  projectKey,
  onClose,
  onDeleted,
}: {
  projectKey: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (confirm !== projectKey || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectKey}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(typeof j.error === 'string' ? j.error : `Failed (${res.status})`);
        return;
      }
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 16, color: 'var(--red)' }}>Delete project</h3>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-4)' }}>
          This will permanently delete the project, its connectors, and all AI-generated docs.
          Items synced from connectors will be kept. This cannot be undone.
        </p>
        <p style={{ margin: 0, fontSize: 13 }}>
          Type <code style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{projectKey}</code> to confirm:
        </p>
        <input
          autoFocus
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          style={{ padding: '8px 10px', border: '1px solid var(--rule)', borderRadius: 6, fontFamily: 'var(--mono)' }}
        />
        {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={{ padding: '6px 12px', border: '1px solid var(--rule)', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={confirm !== projectKey || submitting}
            style={{
              padding: '6px 12px',
              border: 0,
              borderRadius: 6,
              background: confirm === projectKey && !submitting ? 'var(--red)' : 'var(--ink-4)',
              color: 'var(--paper)',
              cursor: confirm === projectKey && !submitting ? 'pointer' : 'default',
            }}
          >
            {submitting ? 'Deleting…' : 'Delete project'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ModalShell({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderRadius: 12,
          padding: 24,
          width: 480,
          maxWidth: '92vw',
        }}
      >
        {children}
      </div>
    </div>
  );
}
