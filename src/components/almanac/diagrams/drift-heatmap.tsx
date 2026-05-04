'use client';

import React from 'react';

interface DriftHeatmapParams {
  kind: 'unticketed' | 'unbuilt';
  project_key: string;
  count?: number;
  total?: number;
}

function isDriftHeatmapParams(p: unknown): p is DriftHeatmapParams {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    (o.kind === 'unticketed' || o.kind === 'unbuilt') &&
    typeof o.project_key === 'string'
  );
}

const W = 400;
const H = 60;
const BAR_Y = 16;
const BAR_H = 18;

export function DriftHeatmap({ params }: { params: unknown }) {
  if (!isDriftHeatmapParams(params)) {
    return <figure className="almanac-diagram-empty">No data</figure>;
  }

  const { kind, project_key } = params;
  const count = typeof params.count === 'number' ? params.count : 0;
  const total = typeof params.total === 'number' && params.total > 0 ? params.total : Math.max(count, 1);
  const pct = Math.min(count / total, 1);

  const color = kind === 'unticketed' ? 'var(--amber)' : 'var(--red)';
  const label = kind === 'unticketed' ? 'Unticketed drift' : 'Unbuilt drift';

  return (
    <figure aria-label={`Drift heatmap (${kind}) for ${project_key}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`${label} for ${project_key}: ${count} of ${total}`}
      >
        <title>{`${project_key} — ${label}: ${count} / ${total} (${(pct * 100).toFixed(1)}%)`}</title>

        <text x={0} y={12} fontSize={11} fill="var(--ink-3)" fontFamily="var(--sans)">
          {project_key} — {label}
        </text>

        {/* background track */}
        <rect x={0} y={BAR_Y} width={W} height={BAR_H} rx={4} fill="var(--bone-2)" />

        {/* filled portion */}
        <rect
          x={0} y={BAR_Y}
          width={pct * W}
          height={BAR_H} rx={4}
          fill={color}
          fillOpacity={0.75}
        >
          <title>{`${count} / ${total} (${(pct * 100).toFixed(1)}%)`}</title>
        </rect>

        {/* percentage label inside or outside bar */}
        <text
          x={pct * W > 60 ? pct * W - 6 : pct * W + 6}
          y={BAR_Y + BAR_H / 2 + 4}
          fontSize={10}
          fontWeight={600}
          fill={pct * W > 60 ? 'var(--paper)' : 'var(--ink-3)'}
          textAnchor={pct * W > 60 ? 'end' : 'start'}
          fontFamily="var(--sans)"
        >
          {count} ({(pct * 100).toFixed(1)}%)
        </text>

        {/* legend */}
        <rect x={0} y={44} width={10} height={10} rx={2} fill={color} fillOpacity={0.75} />
        <text x={14} y={53} fontSize={10} fill="var(--ink-4)" fontFamily="var(--sans)">
          {label} ({count})
        </text>
        <text x={W} y={53} fontSize={10} fill="var(--ink-5)" textAnchor="end" fontFamily="var(--sans)">
          total: {total}
        </text>
      </svg>
      <figcaption style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 4 }}>
        {label} bar for <strong>{project_key}</strong>.
      </figcaption>
    </figure>
  );
}
