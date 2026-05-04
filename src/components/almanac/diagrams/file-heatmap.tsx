'use client';

import React from 'react';

interface FileEntry {
  path: string;
  churn: number;
}

interface FileHeatmapParams {
  unit_id: string;
  files: FileEntry[];
}

function isFileHeatmapParams(p: unknown): p is FileHeatmapParams {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o.unit_id === 'string' && Array.isArray(o.files);
}

const MAX_FILES = 20;
const ROW_H = 24;
const BAR_MAX_W = 260;
const LABEL_W = 310;
const PAD_X = 8;

export function FileHeatmap({ params }: { params: unknown }) {
  if (!isFileHeatmapParams(params) || params.files.length === 0) {
    return <figure className="almanac-diagram-empty">No data</figure>;
  }

  const sorted = [...params.files]
    .sort((a, b) => b.churn - a.churn)
    .slice(0, MAX_FILES);

  const maxChurn = Math.max(...sorted.map(f => f.churn), 1);
  const truncated = params.files.length > MAX_FILES;
  const svgH = sorted.length * ROW_H + 28 + (truncated ? 18 : 0);
  const svgW = LABEL_W + BAR_MAX_W + PAD_X * 3 + 50;

  function shortPath(p: string): string {
    if (p.length <= 38) return p;
    const parts = p.split('/');
    if (parts.length > 3) return '…/' + parts.slice(-2).join('/');
    return '…' + p.slice(p.length - 37);
  }

  return (
    <figure aria-label={`File churn heatmap for ${params.unit_id}`}>
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        width="100%"
        role="img"
        aria-label={`File churn heatmap for ${params.unit_id}`}
      >
        <title>{`${params.unit_id} — top files by churn`}</title>

        <text x={PAD_X} y={16} fontSize={12} fontWeight={600} fill="var(--ink)" fontFamily="var(--sans)">
          {params.unit_id}
        </text>

        {sorted.map((f, i) => {
          const y = 24 + i * ROW_H;
          const barW = (f.churn / maxChurn) * BAR_MAX_W;
          const intensity = 0.15 + (f.churn / maxChurn) * 0.65;
          const label = shortPath(f.path);

          return (
            <g key={i} aria-label={`${f.path}: ${f.churn} churn`}>
              <title>{`${f.path} — churn: ${f.churn}`}</title>
              {/* row bg */}
              <rect
                x={PAD_X} y={y + 1}
                width={svgW - PAD_X * 2}
                height={ROW_H - 2}
                rx={3}
                fill={i % 2 === 0 ? 'var(--bone-2)' : 'transparent'}
                fillOpacity={0.4}
              />
              {/* churn bar */}
              <rect
                x={PAD_X + LABEL_W} y={y + 4}
                width={barW}
                height={ROW_H - 8}
                rx={2}
                fill="var(--amber)"
                fillOpacity={intensity}
              />
              {/* churn count */}
              <text
                x={PAD_X + LABEL_W + barW + 6}
                y={y + ROW_H / 2 + 4}
                fontSize={9}
                fill="var(--ink-4)"
                fontFamily="var(--mono)"
              >
                {f.churn}
              </text>
              {/* path label */}
              <text
                x={PAD_X + 4}
                y={y + ROW_H / 2 + 4}
                fontSize={10}
                fill="var(--ink-3)"
                fontFamily="var(--mono)"
              >
                {label}
              </text>
            </g>
          );
        })}

        {truncated && (
          <text
            x={PAD_X}
            y={svgH - 6}
            fontSize={10}
            fill="var(--ink-5)"
            fontFamily="var(--sans)"
          >
            +{params.files.length - MAX_FILES} more files not shown
          </text>
        )}
      </svg>
      <figcaption style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 4 }}>
        Top {sorted.length} files by churn for <strong>{params.unit_id}</strong>.
      </figcaption>
    </figure>
  );
}
