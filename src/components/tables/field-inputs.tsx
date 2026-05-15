'use client';

import type { CustomTableColumn } from '@/lib/workspace-config';
import { STAGE_OPTIONS, PEOPLE_RELATIONSHIPS, PEOPLE_STAGES_BY_RELATIONSHIP, relationshipLabel } from './shared';

interface CustomFieldInputProps {
  column: CustomTableColumn;
  tableId: string;
  value: unknown;
  /** All current row values — lets the input narrow choices contextually
   *  (e.g. people.stage dropdown shows only the stages valid for the
   *  currently-selected relationship). */
  row?: Record<string, unknown>;
  onChange: (value: unknown) => void;
  onBlur?: () => void;
}

const FIELD_STYLE: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid var(--rule, #ddd)',
  borderRadius: 6,
  background: 'var(--paper, #fff)',
  color: 'var(--ink, #111)',
  fontSize: 13,
  width: '100%',
};

function toInputValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function dateInputValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  // YYYY-MM-DD for <input type="date">
  return date.toISOString().slice(0, 10);
}

export function CustomFieldInput({
  column,
  tableId,
  value,
  row,
  onChange,
  onBlur,
}: CustomFieldInputProps) {
  // Relationship dropdown (people table only)
  if (tableId === 'people' && column.name === 'relationship') {
    return (
      <select
        value={toInputValue(value)}
        onChange={(e) => onChange(e.target.value || null)}
        onBlur={onBlur}
        style={FIELD_STYLE}
      >
        <option value="">—</option>
        {PEOPLE_RELATIONSHIPS.map((rel) => (
          <option key={rel} value={rel}>
            {relationshipLabel(rel)}
          </option>
        ))}
      </select>
    );
  }

  // Stage dropdown — for people, narrow to the stages valid for the
  // currently-selected relationship; otherwise use the full table stage list.
  if (column.name === 'stage' && STAGE_OPTIONS[tableId]) {
    let stages = STAGE_OPTIONS[tableId];
    if (tableId === 'people') {
      const rel = typeof row?.relationship === 'string' ? row.relationship : '';
      const scoped = (PEOPLE_STAGES_BY_RELATIONSHIP as Record<string, string[]>)[rel];
      if (scoped && scoped.length > 0) stages = scoped;
    }
    return (
      <select
        value={toInputValue(value)}
        onChange={(e) => onChange(e.target.value || null)}
        onBlur={onBlur}
        style={FIELD_STYLE}
      >
        <option value="">—</option>
        {stages.map((stage) => (
          <option key={stage} value={stage}>
            {stage}
          </option>
        ))}
      </select>
    );
  }

  if (column.type === 'boolean') {
    return (
      <select
        value={toInputValue(value)}
        onChange={(e) => onChange(e.target.value === 'true')}
        onBlur={onBlur}
        style={FIELD_STYLE}
      >
        <option value="">—</option>
        <option value="true">yes</option>
        <option value="false">no</option>
      </select>
    );
  }

  if (column.type === 'datetime') {
    return (
      <input
        type="date"
        value={dateInputValue(value)}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v ? new Date(v).toISOString() : null);
        }}
        onBlur={onBlur}
        style={FIELD_STYLE}
      />
    );
  }

  if (column.type === 'integer' || column.type === 'real') {
    return (
      <input
        type="number"
        step={column.type === 'integer' ? 1 : 'any'}
        value={toInputValue(value)}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') {
            onChange(null);
          } else {
            const num = column.type === 'integer' ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
            onChange(Number.isNaN(num) ? null : num);
          }
        }}
        onBlur={onBlur}
        style={FIELD_STYLE}
      />
    );
  }

  // Multi-line for notes; single-line for everything else.
  if (column.name === 'notes') {
    return (
      <textarea
        value={toInputValue(value)}
        onChange={(e) => onChange(e.target.value || null)}
        onBlur={onBlur}
        rows={4}
        style={{ ...FIELD_STYLE, fontFamily: 'inherit', resize: 'vertical' }}
      />
    );
  }

  return (
    <input
      type="text"
      value={toInputValue(value)}
      onChange={(e) => onChange(e.target.value || null)}
      onBlur={onBlur}
      style={FIELD_STYLE}
    />
  );
}
