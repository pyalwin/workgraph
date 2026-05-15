'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CustomTableConfig } from '@/lib/workspace-config';
import { CustomFieldInput } from './field-inputs';
import { formatColumnValue, getDisplayName } from './shared';

type Row = Record<string, string | number | boolean | null>;

interface LinkedItem {
  link_id: string;
  match_reason: string;
  confidence: number;
  link_created_at: string | null;
  id: string;
  source: string;
  source_id: string;
  item_type: string;
  title: string;
  body: string | null;
  summary: string | null;
  author: string | null;
  status: string | null;
  url: string | null;
  created_at: string;
}

interface DetailResponse {
  table: CustomTableConfig;
  workspace_id: string;
  row: Row;
  linked_items: LinkedItem[];
}

export function CustomTableDetail({
  table,
  id,
}: {
  table: CustomTableConfig;
  id: string;
}) {
  const router = useRouter();
  const [row, setRow] = useState<Row | null>(null);
  const [links, setLinks] = useState<LinkedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Row | null>(null);
  const [savingField, setSavingField] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tables/${table.id}/${encodeURIComponent(id)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`Failed (${res.status})`);
      }
      const json = (await res.json()) as DetailResponse;
      setRow(json.row);
      setDraft(json.row);
      setLinks(json.linked_items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id, table.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persistField = useCallback(
    async (column: string, value: unknown) => {
      if (!row) return;
      setSavingField(column);
      // optimistic update
      setRow((prev) => (prev ? { ...prev, [column]: value as Row[string] } : prev));
      try {
        const res = await fetch(`/api/tables/${table.id}/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [column]: value }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(typeof j.error === 'string' ? j.error : `Failed (${res.status})`);
        }
        const json = (await res.json()) as { row: Row };
        setRow(json.row);
        setDraft(json.row);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        await refresh();
      } finally {
        setSavingField(null);
      }
    },
    [id, refresh, row, table.id],
  );

  const togglePin = useCallback(
    async (item: LinkedItem) => {
      const isManual = item.match_reason === 'manual';
      try {
        if (isManual) {
          const url = new URL(
            `/api/tables/${table.id}/${encodeURIComponent(id)}/links`,
            window.location.origin,
          );
          url.searchParams.set('source', item.source);
          url.searchParams.set('source_id', item.source_id);
          const res = await fetch(url.toString(), { method: 'DELETE' });
          if (!res.ok) throw new Error(`Failed (${res.status})`);
        } else {
          const res = await fetch(`/api/tables/${table.id}/${encodeURIComponent(id)}/links`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: item.source, source_id: item.source_id }),
          });
          if (!res.ok) throw new Error(`Failed (${res.status})`);
        }
        await refresh();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [id, refresh, router, table.id],
  );

  const headerName = useMemo(() => (row ? getDisplayName(table, row) : ''), [row, table]);

  if (loading && !row) {
    return (
      <div className="page" style={{ padding: '20px 24px', color: 'var(--ink-4)' }}>
        Loading…
      </div>
    );
  }

  if (!row) {
    return (
      <div className="page" style={{ padding: '20px 24px' }}>
        <div style={{ color: 'var(--red, #c53030)', fontSize: 13 }}>{error ?? 'Not found'}</div>
        <Link href={`/tables/${table.id}`} style={{ fontSize: 13 }}>
          ← Back to {table.label}
        </Link>
      </div>
    );
  }

  const editableColumns = table.columns.filter(
    (c) => !c.primaryKey && c.name !== 'created_at' && c.name !== 'last_touch' && c.name !== 'notes',
  );
  const notesCol = table.columns.find((c) => c.name === 'notes');
  const headerKeys = ['stage', 'amount', 'check_size', 'role', 'partner_email', 'email', 'next_step'];
  const headerCols = table.columns.filter((c) => headerKeys.includes(c.name));

  return (
    <div className="page" style={{ padding: '20px 24px' }}>
      <div style={{ marginBottom: 12 }}>
        <Link href={`/tables/${table.id}`} style={{ fontSize: 13, color: 'var(--ink-4)' }}>
          ← {table.label}
        </Link>
      </div>

      <header style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>
          {headerName || `${table.label} ${id.slice(0, 8)}`}
        </h2>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            marginTop: 8,
            color: 'var(--ink-4)',
            fontSize: 13,
          }}
        >
          {headerCols.map((c) => {
            const v = row[c.name];
            if (v === null || v === undefined || v === '') return null;
            return (
              <span key={c.name}>
                <span style={{ textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 11 }}>
                  {c.name.replace(/_/g, ' ')}
                </span>
                <span style={{ marginLeft: 6, color: 'var(--ink, #111)' }}>
                  {formatColumnValue(c, v)}
                </span>
              </span>
            );
          })}
        </div>
      </header>

      {error && (
        <div style={{ color: 'var(--red, #c53030)', fontSize: 13, marginBottom: 12 }}>{error}</div>
      )}

      <section style={{ display: 'grid', gridTemplateColumns: '2fr 3fr', gap: 24 }}>
        <div
          style={{
            border: '1px solid var(--rule)',
            borderRadius: 8,
            padding: 16,
            background: 'var(--paper)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 14 }}>Details</h3>
          {editableColumns.map((column) => {
            const value = (draft ?? row)[column.name];
            return (
              <label
                key={column.name}
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--ink-4)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                  }}
                >
                  {column.name.replace(/_/g, ' ')}
                  {savingField === column.name && (
                    <span style={{ marginLeft: 6, color: 'var(--ink-4)' }}>saving…</span>
                  )}
                </span>
                <CustomFieldInput
                  column={column}
                  tableId={table.id}
                  value={value}
                  onChange={(v) => setDraft((prev) => (prev ? { ...prev, [column.name]: v as Row[string] } : prev))}
                  onBlur={() => {
                    const current = (draft ?? row)[column.name];
                    if (current !== row[column.name]) {
                      void persistField(column.name, current);
                    }
                  }}
                />
              </label>
            );
          })}

          {notesCol && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--ink-4)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                }}
              >
                notes
                {savingField === 'notes' && (
                  <span style={{ marginLeft: 6, color: 'var(--ink-4)' }}>saving…</span>
                )}
              </span>
              <CustomFieldInput
                column={notesCol}
                tableId={table.id}
                value={(draft ?? row).notes}
                onChange={(v) => setDraft((prev) => (prev ? { ...prev, notes: v as Row[string] } : prev))}
                onBlur={() => {
                  const current = (draft ?? row).notes;
                  if (current !== row.notes) {
                    void persistField('notes', current);
                  }
                }}
              />
            </label>
          )}
        </div>

        <div>
          <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>
            Linked items <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>· {links.length}</span>
          </h3>
          {links.length === 0 ? (
            <div className="goals-empty">
              No linked items yet. Pipeline matching pulls in emails, meetings and docs as they sync.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {links.map((item) => (
                <li
                  key={item.link_id}
                  style={{
                    border: '1px solid var(--rule)',
                    borderRadius: 8,
                    padding: 12,
                    background: 'var(--paper)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--ink-4)',
                          textTransform: 'uppercase',
                          letterSpacing: 0.4,
                          marginBottom: 4,
                          display: 'flex',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span>{item.source}</span>
                        <span>·</span>
                        <span>{item.item_type}</span>
                        <span>·</span>
                        <span>{new Date(item.created_at).toLocaleString()}</span>
                        <span style={{ color: item.match_reason === 'manual' ? 'var(--ink, #111)' : 'var(--ink-4)' }}>
                          · {item.match_reason}
                        </span>
                      </div>
                      <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 4 }}>
                        {item.url ? (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--ink, #111)' }}
                          >
                            {item.title}
                          </a>
                        ) : (
                          item.title
                        )}
                      </div>
                      {item.summary && (
                        <div style={{ fontSize: 13, color: 'var(--ink-3, #444)' }}>
                          {item.summary}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => void togglePin(item)}
                      title={item.match_reason === 'manual' ? 'Unpin manual link' : 'Pin manually'}
                      style={{
                        alignSelf: 'flex-start',
                        padding: '4px 8px',
                        borderRadius: 6,
                        border: '1px solid var(--rule)',
                        background: item.match_reason === 'manual' ? 'var(--ink, #111)' : 'var(--paper, #fff)',
                        color: item.match_reason === 'manual' ? 'var(--paper, #fff)' : 'var(--ink, #111)',
                        fontSize: 11,
                        cursor: 'pointer',
                      }}
                    >
                      {item.match_reason === 'manual' ? 'Unpin' : 'Pin'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
