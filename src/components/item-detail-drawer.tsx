'use client';

import { useEffect, useState } from 'react';
import { Markdown } from '@/components/prompt-kit/markdown';

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

interface ItemDetailResponse {
  item: WorkItem;
  versions: unknown[];
  linkedItems: LinkedItem[];
  goals: { name: string }[];
  workstreams: unknown[];
  decisions: unknown[];
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
  const { item, linkedItems, goals } = data;
  const src = item.source.toLowerCase();
  const srcLabel = SOURCE_LABEL[src] ?? item.source;
  const srcCode = SOURCE_CODE[src] ?? item.source.slice(0, 3).toUpperCase();

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
