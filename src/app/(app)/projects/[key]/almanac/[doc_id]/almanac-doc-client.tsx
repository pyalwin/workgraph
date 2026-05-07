'use client';

/**
 * AlmanacDocClient
 *
 * Doc detail page. Features:
 * - Header: product summary, repo/ref/status, completed_at.
 * - Left rail TOC (section list, clickable).
 * - Main content: each section rendered as markdown.
 *   - Drafting/queued sections show a placeholder + live job stream.
 *   - Failed sections show error + "Retry" button.
 *   - Done sections show markdown rendered via AlmanacMarkdown.
 * - "Regenerate" button per section.
 * - Polling: refetch every 5s while any section is in-flight.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
// OpenUI styles must be imported before our overrides for the Interactive renderer.
import '@openuidev/react-ui/components.css';
import '@openuidev/react-ui/defaults.css';
import '@/styles/openui-theme.css';
import '@/styles/almanac-doc.css';
import { AlmanacMarkdown } from '@/components/almanac/almanac-markdown';
import { AlmanacInteractive } from '@/components/almanac/almanac-interactive';
import { LiveJobStream } from '@/components/almanac/live-job-stream';

/* ------------------------------------------------------------------ */
/* Types (mirrors GET /api/almanac/docs/:doc_id response)             */
/* ------------------------------------------------------------------ */

interface JobRow {
  id: string;
  kind: string;
  status: string;
  attempt: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface SectionData {
  sectionId: string;
  ordinal: number;
  title: string;
  markdown: string | null;
  status: string;
  jobId: string | null;
  job: JobRow | null;
  createdAt: string;
  updatedAt: string;
  regeneratedAt: string | null;
}

interface DocData {
  id: string;
  workspaceId: string;
  projectKey: string;
  repoKey: string;
  ref: string;
  status: string;
  outline: unknown;
  productSummary: string | null;
  title: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface DocResponse {
  doc: DocData;
  sections: SectionData[];
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const POLL_INTERVAL_MS = 5000;

const IN_FLIGHT_STATUSES = new Set(['queued', 'drafting', 'outlining']);

function isInFlight(sections: SectionData[], docStatus: string): boolean {
  if (docStatus === 'outlining') return true;
  return sections.some((s) => IN_FLIGHT_STATUSES.has(s.status));
}

const DOC_STATUS_LABEL: Record<string, string> = {
  outlining: 'Outlining',
  drafting: 'Drafting',
  complete: 'Complete',
  failed: 'Failed',
};

const DOC_STATUS_COLOR: Record<string, string> = {
  outlining: 'var(--amber)',
  drafting: 'var(--amber)',
  complete: 'var(--green)',
  failed: 'var(--red)',
};

/* ------------------------------------------------------------------ */
/* Section component                                                   */
/* ------------------------------------------------------------------ */

type ViewMode = 'interactive' | 'read';

/* ------------------------------------------------------------------ */
/* Editable title                                                      */
/* ------------------------------------------------------------------ */

interface EditableTitleProps {
  docId: string;
  initialTitle: string | null;
  /** Shown when the title is empty. Stays as a placeholder, not persisted. */
  fallback: string;
  onSaved: (title: string | null) => void;
}

function EditableTitle({ docId, initialTitle, fallback, onSaved }: EditableTitleProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialTitle ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the draft in sync if the doc reloads with a new title server-side.
  useEffect(() => {
    if (!editing) setDraft(initialTitle ?? '');
  }, [initialTitle, editing]);

  const display = (initialTitle ?? '').trim() || fallback;
  const isFallback = !initialTitle?.trim();

  const startEditing = () => {
    setDraft(initialTitle ?? '');
    setEditing(true);
    setError(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  const persist = async (next: string) => {
    const trimmed = next.trim();
    const stored = trimmed === '' ? null : trimmed;
    if (stored === (initialTitle?.trim() || null)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/almanac/docs/${docId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: stored }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; title?: string | null };
      if (!res.ok) {
        setError(json.error ?? 'Failed to save title');
        return;
      }
      onSaved(json.title ?? null);
      setEditing(false);
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void persist(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void persist(draft);
            } else if (e.key === 'Escape') {
              setDraft(initialTitle ?? '');
              setEditing(false);
            }
          }}
          rows={1}
          maxLength={200}
          placeholder="Untitled"
          className="almanac-title"
          style={titleEditStyle}
        />
        {error && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }}>{error}</p>}
      </div>
    );
  }

  return (
    <h1
      className={`almanac-title${isFallback ? ' almanac-title--placeholder' : ''}`}
      style={saving ? { opacity: 0.6 } : undefined}
      onClick={startEditing}
      tabIndex={0}
      role="button"
      aria-label="Edit document title"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          startEditing();
        }
      }}
    >
      {display}
    </h1>
  );
}

const titleEditStyle: React.CSSProperties = {
  width: '100%',
  padding: 0,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  resize: 'none',
  overflow: 'hidden',
  cursor: 'text',
};

interface SectionBlockProps {
  section: SectionData;
  docId: string;
  onRegen: (sectionId: string) => void;
  regenBusy: boolean;
  /** After stream finishes, trigger a refetch */
  onStreamFinish: () => void;
  viewMode: ViewMode;
}

function SectionBlock({
  section,
  docId: _docId,
  onRegen,
  regenBusy,
  onStreamFinish,
  viewMode,
}: SectionBlockProps) {
  const sectionRef = useRef<HTMLElement>(null);

  const isDone = section.status === 'done';
  const isFailed = section.status === 'failed';
  const isDrafting = section.status === 'drafting' || section.status === 'queued';

  const jobError =
    isFailed && section.job?.status === 'failed'
      ? ((section.job as unknown as { result?: { error?: string } }).result?.error ??
        'Section generation failed.')
      : isFailed
      ? 'Section generation failed.'
      : null;

  const regenButton = (
    <button
      type="button"
      onClick={() => onRegen(section.sectionId)}
      disabled={regenBusy || isDrafting}
      style={{
        ...sectionStyles.regenBtn,
        opacity: regenBusy || isDrafting ? 0.5 : 1,
      }}
    >
      {isDrafting ? 'Drafting…' : 'Regenerate'}
    </button>
  );

  return (
    <section
      ref={sectionRef}
      id={`section-${section.sectionId}`}
      style={sectionStyles.wrap}
    >
      {isDone && section.markdown ? (
        viewMode === 'interactive' ? (
          <AlmanacInteractive
            markdown={section.markdown}
            title={section.title}
            sectionSlug={section.sectionId}
            headerAction={regenButton}
          />
        ) : (
          <>
            <div style={sectionStyles.titleRow}>
              <h2 style={sectionStyles.h2}>{section.title}</h2>
              {regenButton}
            </div>
            <AlmanacMarkdown>{section.markdown}</AlmanacMarkdown>
          </>
        )
      ) : (
        <>
          <div style={sectionStyles.titleRow}>
            <h2 style={sectionStyles.h2}>{section.title}</h2>
            {regenButton}
          </div>

          {isDrafting && (
            <div style={sectionStyles.draftingWrap}>
              <p style={sectionStyles.draftingLabel}>
                {section.status === 'queued' ? 'Queued — waiting for agent…' : 'Drafting this section…'}
              </p>
              {section.jobId && (
                <LiveJobStream jobId={section.jobId} onFinish={onStreamFinish} />
              )}
            </div>
          )}

          {isFailed && (
            <div style={sectionStyles.failedWrap}>
              <p style={sectionStyles.failedMsg}>{jobError}</p>
              <button
                type="button"
                onClick={() => onRegen(section.sectionId)}
                disabled={regenBusy}
                style={sectionStyles.retryBtn}
              >
                Retry
              </button>
            </div>
          )}

          {!isDone && !isDrafting && !isFailed && (
            <p style={sectionStyles.draftingLabel}>Waiting…</p>
          )}
        </>
      )}
    </section>
  );
}

const sectionStyles = {
  wrap: {
    paddingBottom: 0,
    marginBottom: 0,
  } as React.CSSProperties,

  titleRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 16,
  } as React.CSSProperties,

  h2: {
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--ink)',
    letterSpacing: '-0.01em',
    lineHeight: 1.3,
    margin: 0,
  } as React.CSSProperties,

  regenBtn: {
    padding: '4px 10px',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    color: 'var(--ink-4)',
    whiteSpace: 'nowrap' as const,
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
    flexShrink: 0,
  } as React.CSSProperties,

  draftingWrap: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  } as React.CSSProperties,

  draftingLabel: {
    fontSize: 13,
    color: 'var(--ink-4)',
    fontStyle: 'italic',
  } as React.CSSProperties,

  failedWrap: {
    padding: '14px 16px',
    background: 'rgba(180,48,27,0.06)',
    border: '1px solid rgba(180,48,27,0.2)',
    borderRadius: 8,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  } as React.CSSProperties,

  failedMsg: {
    fontSize: 13,
    color: 'var(--red)',
  } as React.CSSProperties,

  retryBtn: {
    alignSelf: 'flex-start' as const,
    padding: '6px 14px',
    background: 'var(--red)',
    color: 'var(--paper)',
    border: 'none',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  } as React.CSSProperties,
} as const;

/* ------------------------------------------------------------------ */
/* Main client                                                         */
/* ------------------------------------------------------------------ */

interface AlmanacDocClientProps {
  projectKey: string;
  docId: string;
}

const VIEW_MODE_STORAGE_KEY = 'almanac.viewMode';

function readPersistedViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'interactive';
  const v = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
  return v === 'read' ? 'read' : 'interactive';
}

export function AlmanacDocClient({ projectKey, docId }: AlmanacDocClientProps) {
  const [data, setData] = useState<DocResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenBusy, setRegenBusy] = useState<Set<string>>(new Set());
  const [regenError, setRegenError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('interactive');

  // Read persisted view mode on mount (avoids SSR/CSR mismatch).
  useEffect(() => {
    setViewMode(readPersistedViewMode());
  }, []);

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    }
  };

  const isMountedRef = useRef(true);
  const dataRef = useRef<DocResponse | null>(null);

  const fetchDoc = useCallback(async () => {
    try {
      const res = await fetch(`/api/almanac/docs/${docId}`);
      if (!res.ok) return;
      const json = (await res.json()) as DocResponse;
      if (!isMountedRef.current) return;
      dataRef.current = json;
      setData(json);
      setLoading(false);
    } catch {
      // silently ignore — will retry
    }
  }, [docId]);

  useEffect(() => {
    isMountedRef.current = true;
    void fetchDoc();

    // Single interval; tick decides whether to fetch or stop. Avoids the
    // setState-updater + recursion pattern that React 19 Strict Mode would
    // double-invoke, fanning timers out exponentially.
    const interval = setInterval(() => {
      if (!isMountedRef.current) return;
      const d = dataRef.current;
      if (!d) return; // initial fetch hasn't returned yet
      if (!isInFlight(d.sections, d.doc.status)) return; // nothing in flight; idle
      void fetchDoc();
    }, POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(interval);
    };
  }, [docId, fetchDoc]);

  const handleRegen = async (sectionId: string) => {
    setRegenError(null);
    setRegenBusy((prev) => new Set([...prev, sectionId]));
    try {
      const res = await fetch(
        `/api/almanac/docs/${docId}/sections/${sectionId}/regen`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      const json = (await res.json()) as { job_id?: string; error?: string };
      if (!res.ok) {
        setRegenError(json.error ?? 'Regeneration failed');
        return;
      }
      // Immediately refetch to get the updated section status; the interval
      // will resume polling automatically while it's in flight.
      await fetchDoc();
    } catch {
      setRegenError('Network error — please try again');
    } finally {
      setRegenBusy((prev) => {
        const next = new Set(prev);
        next.delete(sectionId);
        return next;
      });
    }
  };

  const handleStreamFinish = useCallback(() => {
    // When a stream ends, do a final refetch
    void fetchDoc();
  }, [fetchDoc]);

  const scrollToSection = (sectionId: string) => {
    const el = document.getElementById(`section-${sectionId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (loading) {
    return (
      <div className="detail-page">
        <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>Loading…</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="detail-page">
        <p style={{ fontSize: 13, color: 'var(--red)' }}>Doc not found or you don&apos;t have access.</p>
      </div>
    );
  }

  const { doc, sections } = data;

  return (
    <div className="proj-page almanac-doc-page">
      {/* ── Back link ── */}
      <Link
        href={`/projects/${projectKey.toLowerCase()}`}
        className="proj-back"
      >
        <span className="arrow">←</span> Back to project
      </Link>

      {sections.length === 0 && doc.status === 'outlining' ? (
        <>
          <DocHeader
            doc={doc}
            sectionsCount={sections.length}
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            onTitleSaved={(t) =>
              setData((prev) =>
                prev ? { ...prev, doc: { ...prev.doc, title: t } } : prev,
              )
            }
            docId={docId}
            projectKey={projectKey}
          />
          <div style={{ fontSize: 13, color: 'var(--ink-4)', fontStyle: 'italic', padding: '40px 0' }}>
            The agent is generating the document outline. Sections will appear here shortly.
          </div>
        </>
      ) : (
        <div style={layoutStyles.wrap}>
          {/* ── Left rail TOC ── */}
          <aside style={layoutStyles.rail}>
            <div style={railStyles.label}>Sections</div>
            <nav>
              {sections.map((s) => (
                <button
                  key={s.sectionId}
                  type="button"
                  onClick={() => scrollToSection(s.sectionId)}
                  style={{
                    ...railStyles.tocItem,
                    ...(s.status === 'done' ? {} : railStyles.tocItemMuted),
                  }}
                >
                  <span style={railStyles.tocDot(s.status)} />
                  {s.title}
                </button>
              ))}
            </nav>
          </aside>

          {/* ── Main content (header + sections share this column for Notion-style alignment) ── */}
          <main style={layoutStyles.main}>
            <DocHeader
              doc={doc}
              sectionsCount={sections.length}
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              onTitleSaved={(t) =>
                setData((prev) =>
                  prev ? { ...prev, doc: { ...prev.doc, title: t } } : prev,
                )
              }
              docId={docId}
              projectKey={projectKey}
            />

            {regenError && (
              <div style={{
                padding: '10px 14px',
                marginBottom: 16,
                background: 'rgba(180,48,27,0.07)',
                border: '1px solid rgba(180,48,27,0.2)',
                borderRadius: 6,
                fontSize: 13,
                color: 'var(--red)',
              }}>
                {regenError}
              </div>
            )}

            {sections.map((s) => (
              <SectionBlock
                key={s.sectionId}
                section={s}
                docId={docId}
                onRegen={handleRegen}
                regenBusy={regenBusy.has(s.sectionId)}
                onStreamFinish={handleStreamFinish}
                viewMode={viewMode}
              />
            ))}
          </main>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Doc header                                                          */
/* ------------------------------------------------------------------ */

interface DocHeaderProps {
  doc: DocData;
  sectionsCount: number;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onTitleSaved: (title: string | null) => void;
  docId: string;
  projectKey: string;
}

function DocHeader({
  doc,
  sectionsCount,
  viewMode,
  onViewModeChange,
  onTitleSaved,
  docId,
  projectKey,
}: DocHeaderProps) {
  return (
    <header style={headerStyles.wrap}>
      <div style={headerStyles.metaRow}>
        <div style={headerStyles.meta}>
          <span
            style={{
              ...headerStyles.statusBadge,
              color: DOC_STATUS_COLOR[doc.status] ?? 'var(--ink-5)',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: DOC_STATUS_COLOR[doc.status] ?? 'var(--ink-5)',
              }}
            />
            {DOC_STATUS_LABEL[doc.status] ?? doc.status}
          </span>
          <span style={headerStyles.repoRef}>
            {doc.repoKey} @ {doc.ref}
          </span>
          {doc.completedAt && (
            <span style={headerStyles.completedAt}>
              completed {new Date(doc.completedAt).toLocaleDateString()}
            </span>
          )}
          <span style={headerStyles.sectionsCount}>
            · {doc.projectKey} · {sectionsCount} section{sectionsCount !== 1 ? 's' : ''}
          </span>
          {doc.status === 'outlining' && (
            <span style={{ color: 'var(--amber)', fontSize: 12 }}>
              Building outline…
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <VersionSwitcher
            projectKey={projectKey}
            currentDocId={docId}
          />
          <button
            type="button"
            onClick={() => onViewModeChange(viewMode === 'interactive' ? 'read' : 'interactive')}
            title={viewMode === 'interactive' ? 'Show raw markdown' : 'Show interactive view'}
            aria-label={viewMode === 'interactive' ? 'Show raw markdown' : 'Show interactive view'}
            style={iconToggleStyle}
          >
            {viewMode === 'interactive' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M8 6L2 12L8 18M16 6L22 12L16 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M3 6H21M3 12H21M3 18H14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
            )}
          </button>
        </div>
      </div>

      <EditableTitle
        docId={docId}
        initialTitle={doc.title}
        fallback={doc.repoKey}
        onSaved={onTitleSaved}
      />

      {doc.productSummary && (
        <p className="almanac-subtitle">{doc.productSummary}</p>
      )}
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Version switcher                                                    */
/* ------------------------------------------------------------------ */

interface VersionRow {
  id: string;
  repo_key: string;
  ref: string;
  status: string;
  title: string | null;
  created_at: string;
  completed_at: string | null;
}

function VersionSwitcher({
  projectKey,
  currentDocId,
}: {
  projectKey: string;
  currentDocId: string;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Fetch the version list lazily when the menu opens, and refetch each
  // time it reopens so in-progress statuses stay current.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/almanac/docs?projectKey=${encodeURIComponent(projectKey)}`)
      .then((r) => r.json())
      .then((j: { docs?: VersionRow[] }) => {
        if (!cancelled) {
          setVersions(j.docs ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectKey]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const inFlight = versions?.filter((v) => v.status !== 'complete' && v.status !== 'failed') ?? [];

  return (
    <div ref={popoverRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Switch version"
        aria-label="Switch version"
        aria-expanded={open}
        style={versionSwitcherStyles.button}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 8V12L15 14M21 12A9 9 0 1 1 3 12A9 9 0 0 1 21 12Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Versions
        {inFlight.length > 0 && (
          <span style={versionSwitcherStyles.inFlightDot} aria-label={`${inFlight.length} in progress`} />
        )}
      </button>

      {open && (
        <div style={versionSwitcherStyles.popover} role="menu">
          <div style={versionSwitcherStyles.popoverHead}>
            <span>Almanac versions</span>
            <Link
              href={`/projects/${projectKey.toLowerCase()}/almanac?all=1`}
              style={versionSwitcherStyles.popoverHeadLink}
              onClick={() => setOpen(false)}
            >
              + Generate new
            </Link>
          </div>
          {loading && (
            <div style={versionSwitcherStyles.popoverEmpty}>Loading…</div>
          )}
          {!loading && versions && versions.length === 0 && (
            <div style={versionSwitcherStyles.popoverEmpty}>No other versions yet.</div>
          )}
          {!loading && versions && versions.length > 0 && (
            <ul style={versionSwitcherStyles.popoverList}>
              {versions.map((v) => {
                const active = v.id === currentDocId;
                const label = v.title?.trim() || v.repo_key;
                const date = v.completed_at
                  ? `done ${new Date(v.completed_at).toLocaleDateString()}`
                  : new Date(v.created_at).toLocaleDateString();
                return (
                  <li key={v.id}>
                    <Link
                      href={`/projects/${projectKey.toLowerCase()}/almanac/${v.id}`}
                      style={{
                        ...versionSwitcherStyles.versionRow,
                        ...(active ? versionSwitcherStyles.versionRowActive : null),
                      }}
                      onClick={() => setOpen(false)}
                      aria-current={active ? 'page' : undefined}
                    >
                      <span
                        aria-hidden
                        style={{
                          ...versionSwitcherStyles.statusDot,
                          background: DOC_STATUS_COLOR[v.status] ?? 'var(--ink-5)',
                        }}
                      />
                      <span style={versionSwitcherStyles.versionMain}>
                        <span style={versionSwitcherStyles.versionTitle}>{label}</span>
                        <span style={versionSwitcherStyles.versionMeta}>
                          {v.repo_key} @ {v.ref} · {date}
                        </span>
                      </span>
                      {active && <span style={versionSwitcherStyles.activeMark}>✓</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const versionSwitcherStyles = {
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    height: 32,
    background: 'transparent',
    border: '1px solid var(--rule)',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--ink-3)',
    cursor: 'pointer',
    fontFamily: 'var(--sans)',
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
  } as React.CSSProperties,

  inFlightDot: {
    display: 'inline-block',
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--amber)',
  } as React.CSSProperties,

  popover: {
    position: 'absolute' as const,
    top: 'calc(100% + 6px)',
    right: 0,
    minWidth: 320,
    maxWidth: 420,
    maxHeight: 400,
    overflowY: 'auto' as const,
    background: 'var(--paper)',
    border: '1px solid var(--rule-2)',
    borderRadius: 8,
    boxShadow: '0 4px 20px rgba(21,20,15,0.10)',
    zIndex: 30,
    padding: 4,
  } as React.CSSProperties,

  popoverHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 10px 6px',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--ink-5)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  } as React.CSSProperties,

  popoverHeadLink: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--ink-2)',
    textDecoration: 'none',
    textTransform: 'none' as const,
    letterSpacing: 0,
    padding: '2px 6px',
    borderRadius: 4,
    transition: 'background 0.15s, color 0.15s',
  } as React.CSSProperties,

  popoverEmpty: {
    padding: '12px 10px',
    fontSize: 12,
    color: 'var(--ink-4)',
  } as React.CSSProperties,

  popoverList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
  } as React.CSSProperties,

  versionRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '8px 10px',
    borderRadius: 6,
    textDecoration: 'none',
    color: 'var(--ink-2)',
    transition: 'background 0.15s',
  } as React.CSSProperties,

  versionRowActive: {
    background: 'var(--bone-2)',
    color: 'var(--ink)',
  } as React.CSSProperties,

  statusDot: {
    flexShrink: 0,
    width: 6,
    height: 6,
    borderRadius: '50%',
    marginTop: 7,
  } as React.CSSProperties,

  versionMain: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,

  versionTitle: {
    fontSize: 13,
    fontWeight: 500,
    color: 'inherit',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,

  versionMeta: {
    fontSize: 11,
    color: 'var(--ink-5)',
    fontFamily: 'var(--mono)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,

  activeMark: {
    color: 'var(--green)',
    fontSize: 14,
    flexShrink: 0,
    marginTop: 1,
  } as React.CSSProperties,
} as const;

/* ------------------------------------------------------------------ */
/* Layout styles                                                       */
/* ------------------------------------------------------------------ */

const headerStyles = {
  wrap: {
    marginBottom: 48,
    paddingBottom: 8,
  } as React.CSSProperties,

  metaRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 16,
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,

  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,

  statusBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '0',
    fontSize: 12,
    fontWeight: 500,
    textTransform: 'capitalize' as const,
    letterSpacing: 0,
  } as React.CSSProperties,

  repoRef: {
    fontFamily: 'var(--mono)',
    fontSize: 12,
    color: 'var(--ink-4)',
  } as React.CSSProperties,

  completedAt: {
    fontSize: 12,
    color: 'var(--green)',
  } as React.CSSProperties,

  sectionsCount: {
    fontSize: 12,
    color: 'var(--ink-5)',
  } as React.CSSProperties,

  subtitle: {
    fontSize: 17,
    lineHeight: 1.5,
    color: 'var(--ink-3)',
    margin: '4px 0 0',
    maxWidth: 720,
  } as React.CSSProperties,
} as const;

const iconToggleStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  background: 'transparent',
  border: '1px solid var(--rule)',
  borderRadius: 6,
  color: 'var(--ink-4)',
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'background 0.15s, color 0.15s, border-color 0.15s',
};

const layoutStyles = {
  wrap: {
    display: 'grid',
    gridTemplateColumns: '220px minmax(0, 760px)',
    gap: 64,
    alignItems: 'start',
    justifyContent: 'start',
  } as React.CSSProperties,

  rail: {
    position: 'sticky' as const,
    top: 32,
    maxHeight: 'calc(100vh - 80px)',
    overflowY: 'auto' as const,
  } as React.CSSProperties,

  main: {
    minWidth: 0,
  } as React.CSSProperties,
} as const;

const railStyles = {
  label: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
    color: 'var(--ink-5)',
    marginBottom: 8,
  } as React.CSSProperties,

  tocItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    width: '100%',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '4px 0',
    textAlign: 'left' as const,
    fontSize: 12,
    color: 'var(--ink-2)',
    lineHeight: 1.45,
    fontFamily: 'var(--sans)',
  } as React.CSSProperties,

  tocItemMuted: {
    color: 'var(--ink-5)',
  } as React.CSSProperties,

  tocDot: (status: string): React.CSSProperties => ({
    flexShrink: 0,
    width: 4,
    height: 4,
    borderRadius: '50%',
    marginTop: 6,
    background:
      status === 'done'
        ? 'var(--ink-5)'
        : status === 'failed'
        ? 'var(--red)'
        : status === 'drafting' || status === 'queued'
        ? 'var(--amber)'
        : 'var(--ink-6)',
  }),
};
