'use client';

import React from 'react';

interface Unit {
  unit_id: string;
  name: string;
  signal_events: number;
}

interface ProjectMapParams {
  project_key: string;
  units: Unit[];
}

function isProjectMapParams(p: unknown): p is ProjectMapParams {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o.project_key === 'string' && Array.isArray(o.units);
}

const COLS = 3;
const CELL_W = 180;
const CELL_H = 70;
const PAD = 8;
const GAP = 10;

export function ProjectMap({ params }: { params: unknown }) {
  if (!isProjectMapParams(params) || params.units.length === 0) {
    return <figure className="almanac-diagram-empty">No data</figure>;
  }

  const units = params.units.slice(0, 50);
  const maxSig = Math.max(...units.map(u => u.signal_events), 1);

  const rows = Math.ceil(units.length / COLS);
  const svgW = COLS * (CELL_W + GAP) - GAP + PAD * 2;
  const svgH = rows * (CELL_H + GAP) - GAP + PAD * 2 + 30;

  return (
    <figure aria-label={`Project map for ${params.project_key}`}>
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        width="100%"
        role="img"
        aria-label={`Unit map for project ${params.project_key}`}
      >
        <title>{`Project ${params.project_key} — ${units.length} functional units`}</title>

        <text
          x={PAD}
          y={20}
          fontSize={13}
          fontWeight={600}
          fill="var(--ink)"
          fontFamily="var(--sans)"
        >
          {params.project_key}
        </text>

        {units.map((u, i) => {
          const col = i % COLS;
          const row = Math.floor(i / COLS);
          const x = PAD + col * (CELL_W + GAP);
          const y = 30 + row * (CELL_H + GAP);
          const ratio = u.signal_events / maxSig;
          const opacity = 0.15 + ratio * 0.55;
          const name = u.name.length > 22 ? u.name.slice(0, 21) + '…' : u.name;

          return (
            <g key={u.unit_id} aria-label={`${u.name}: ${u.signal_events} events`}>
              <title>{`${u.name} — ${u.signal_events} signal events`}</title>
              <rect
                x={x}
                y={y}
                width={CELL_W}
                height={CELL_H}
                rx={6}
                fill="var(--blue)"
                fillOpacity={opacity}
                stroke="var(--rule-2)"
                strokeWidth={1}
              />
              <text
                x={x + 10}
                y={y + 24}
                fontSize={11}
                fontWeight={600}
                fill="var(--ink)"
                fontFamily="var(--sans)"
              >
                {name}
              </text>
              <text
                x={x + 10}
                y={y + 42}
                fontSize={10}
                fill="var(--ink-4)"
                fontFamily="var(--sans)"
              >
                {u.signal_events} events
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 4 }}>
        Functional units in {params.project_key}. Box shade ∝ signal events.
      </figcaption>
    </figure>
  );
}
