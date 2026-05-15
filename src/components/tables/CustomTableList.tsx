'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CustomTableColumn, CustomTableConfig } from '@/lib/workspace-config';
import { STAGE_OPTIONS, getDisplayName, formatColumnValue, PEOPLE_RELATIONSHIPS, relationshipLabel } from './shared';
import { CustomFieldInput } from './field-inputs';

type Row = Record<string, string | number | boolean | null>;

interface ListResponse {
  table: CustomTableConfig;
  workspace_id: string;
  rows: Row[];
}

export function CustomTableList({ table }: { table: CustomTableConfig }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tables/${table.id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const json = (await res.json()) as ListResponse;
      setRows(json.rows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [table.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleColumns = useMemo(
    () =>
      table.columns.filter(
        (c) => !c.primaryKey && c.name !== 'notes' && c.name !== 'created_at',
      ),
    [table.columns],
  );

  const hasStage = table.columns.some((c) => c.name === 'stage');
  const hasRelationship = table.columns.some((c) => c.name === 'relationship');
  const stageOptions = STAGE_OPTIONS[table.id] ?? [];

  // For the `people` table, primary grouping is by relationship
  // (Team / Candidates / Advisors / ...). For other pipeline tables
  // (deals, investors), keep grouping by stage as before.
  const grouped = useMemo(() => {
    if (hasRelationship && table.id === 'people') {
      const buckets = new Map<string, Row[]>();
      // Seed in a stable order matching PEOPLE_RELATIONSHIPS so sections
      // always render in a known sequence.
      for (const rel of PEOPLE_RELATIONSHIPS) buckets.set(rel, []);
      buckets.set('__unsorted__', []);
      for (const row of rows) {
        const rel = typeof row.relationship === 'string' && row.relationship.trim()
          ? row.relationship.trim().toLowerCase()
          : '__unsorted__';
        const list = buckets.get(rel) ?? buckets.set(rel, []).get(rel)!;
        list.push(row);
      }
      return Array.from(buckets.entries())
        .filter(([, list]) => list.length > 0)
        .map(([rel, list]) => [rel === '__unsorted__' ? 'Unsorted' : relationshipLabel(rel), list] as [string, Row[]]);
    }
    if (!hasStage) return null;
    const buckets = new Map<string, Row[]>();
    for (const stage of stageOptions) buckets.set(stage, []);
    buckets.set('—', []);
    for (const row of rows) {
      const stage = (row.stage as string) || '—';
      const list = buckets.get(stage) ?? buckets.set(stage, []).get(stage)!;
      list.push(row);
    }
    return Array.from(buckets.entries()).filter(([, list]) => list.length > 0);
  }, [hasStage, hasRelationship, table.id, rows, stageOptions]);

  return (
    <div className="page" style={{ padding: '20px 24px' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>{table.label}</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--ink-4)', fontSize: 13 }}>
            {rows.length} row{rows.length === 1 ? '' : 's'}
            {table.description ? ` · ${table.description}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          style={{
            padding: '6px 12px',
            borderRadius: 8,
            border: '1px solid var(--rule)',
            background: 'var(--paper)',
            color: 'var(--ink)',
            fontSize: 12,
            fontWeight: 500,
            fontFamily: 'var(--mono)',
            cursor: 'pointer',
          }}
        >
          + New {table.id === 'people' ? 'person' : table.label.replace(/s$/, '').toLowerCase()}
        </button>
      </header>

      {error && (
        <div style={{ color: 'var(--red, #c53030)', fontSize: 13, marginBottom: 12 }}>{error}</div>
      )}

      {loading ? (
        <div style={{ color: 'var(--ink-4)', fontSize: 13 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="goals-empty">No rows yet. Add the first one to get started.</div>
      ) : grouped ? (
        grouped.map(([stage, list]) => (
          <section key={stage} style={{ marginBottom: 24 }}>
            <h3
              style={{
                margin: '0 0 8px',
                fontSize: 12,
                color: 'var(--ink-4)',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              {stage} · {list.length}
            </h3>
            <RowsTable
              table={table}
              rows={list}
              columns={visibleColumns}
            />
          </section>
        ))
      ) : (
        <RowsTable table={table} rows={rows} columns={visibleColumns} />
      )}

      {creating && (
        <NewRowModal
          table={table}
          onClose={() => setCreating(false)}
          onCreated={(row) => {
            setCreating(false);
            const idCol = table.columns.find((c) => c.primaryKey);
            const id = idCol ? String(row[idCol.name] ?? '') : '';
            if (id) router.push(`/tables/${table.id}/${encodeURIComponent(id)}`);
            else void refresh();
          }}
        />
      )}
    </div>
  );
}

function RowsTable({
  table,
  rows,
  columns,
}: {
  table: CustomTableConfig;
  rows: Row[];
  columns: CustomTableColumn[];
}) {
  const idCol = table.columns.find((c) => c.primaryKey);
  return (
    <div
      style={{
        border: '1px solid var(--rule)',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'var(--paper)',
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'var(--bone-2, #fafafa)' }}>
            {columns.map((c) => (
              <th
                key={c.name}
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  fontWeight: 600,
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                  color: 'var(--ink-4)',
                  borderBottom: '1px solid var(--rule)',
                }}
              >
                {c.name.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const id = idCol ? String(row[idCol.name] ?? '') : '';
            return (
              <tr key={id} style={{ borderBottom: '1px solid var(--rule)' }}>
                {columns.map((c, i) => {
                  const cell = formatColumnValue(c, row[c.name]);
                  const isFirst = i === 0;
                  return (
                    <td key={c.name} style={{ padding: '8px 12px', verticalAlign: 'top' }}>
                      {isFirst && id ? (
                        <Link
                          href={`/tables/${table.id}/${encodeURIComponent(id)}`}
                          style={{ color: 'var(--ink)', textDecoration: 'none', fontWeight: 500 }}
                        >
                          {cell || getDisplayName(table, row) || id.slice(0, 8)}
                        </Link>
                      ) : (
                        cell || <span style={{ color: 'var(--ink-4)' }}>—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function NewRowModal({
  table,
  onClose,
  onCreated,
}: {
  table: CustomTableConfig;
  onClose: () => void;
  onCreated: (row: Row) => void;
}) {
  const editableColumns = table.columns.filter(
    (c) => !c.primaryKey && c.name !== 'created_at' && c.name !== 'last_touch',
  );
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/tables/${table.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(typeof json.error === 'string' ? json.error : `Failed (${res.status})`);
        return;
      }
      onCreated(json.row as Row);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

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
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        style={{
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderRadius: 12,
          padding: 24,
          width: 480,
          maxWidth: '90vw',
          maxHeight: '90vh',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>New {table.label.replace(/s$/, '').toLowerCase()}</h3>
        {editableColumns.map((column) => (
          <label key={column.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>
              {column.name.replace(/_/g, ' ')}
              {column.required && <span style={{ color: 'var(--red, #c53030)' }}> *</span>}
            </span>
            <CustomFieldInput
              column={column}
              tableId={table.id}
              value={values[column.name]}
              onChange={(v) => setValues((prev) => ({ ...prev, [column.name]: v }))}
            />
          </label>
        ))}

        {error && <div style={{ color: 'var(--red, #c53030)', fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: '6px 12px',
              border: '1px solid var(--rule)',
              borderRadius: 6,
              background: 'transparent',
              cursor: submitting ? 'default' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: '6px 12px',
              border: 0,
              borderRadius: 6,
              background: submitting ? 'var(--ink-4)' : 'var(--ink, #000)',
              color: 'var(--paper, #fff)',
              cursor: submitting ? 'default' : 'pointer',
            }}
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
