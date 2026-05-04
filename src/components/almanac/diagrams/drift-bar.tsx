'use client';

import React from 'react';

interface DriftBarParams {
  project_key: string;
  signal_total: number;
  drift_unticketed: number;
  drift_unbuilt: number;
}

function isDriftBarParams(p: unknown): p is DriftBarParams {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.project_key === 'string' &&
    typeof o.signal_total === 'number' &&
    typeof o.drift_unticketed === 'number' &&
    typeof o.drift_unbuilt === 'number'
  );
}

const W = 400;
const H = 60;
const BAR_H = 18;
const BAR_Y = 16;
const PAD = 0;

export function DriftBar({ params }: { params: unknown }) {
  if (!isDriftBarParams(params) || params.signal_total <= 0) {
    return <figure className="almanac-diagram-empty">No data</figure>;
  }

  const { project_key, signal_total, drift_unticketed, drift_unbuilt } = params;
  const on_ticket = Math.max(0, signal_total - drift_unticketed);
  const ticketedPct = (on_ticket / signal_total) * 100;
  const unticketedPct = (drift_unticketed / signal_total) * 100;

  return (
    <figure aria-label={`Drift bar for ${project_key}`}>
      <svg
        viewBox={`${PAD} 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Drift breakdown for ${project_key}`}
      >
        <title>{`${project_key} — ${signal_total} signals: ${on_ticket} ticketed, ${drift_unticketed} unticketed`}</title>

        {/* label */}
        <text x={0} y={12} fontSize={11} fill="var(--ink-3)" fontFamily="var(--sans)">
          {project_key}
        </text>

        {/* background track */}
        <rect x={0} y={BAR_Y} width={W} height={BAR_H} rx={4} fill="var(--bone-2)" />

        {/* on-ticket segment */}
        <rect
          x={0} y={BAR_Y}
          width={(ticketedPct / 100) * W}
          height={BAR_H} rx={4}
          fill="var(--green)" fillOpacity={0.7}
        >
          <title>{`On-ticket: ${on_ticket} (${ticketedPct.toFixed(1)}%)`}</title>
        </rect>

        {/* unticketed segment */}
        <rect
          x={(ticketedPct / 100) * W} y={BAR_Y}
          width={(unticketedPct / 100) * W}
          height={BAR_H}
          fill="var(--amber)" fillOpacity={0.7}
        >
          <title>{`Unticketed drift: ${drift_unticketed} (${unticketedPct.toFixed(1)}%)`}</title>
        </rect>

        {/* legend row */}
        <rect x={0} y={44} width={10} height={10} rx={2} fill="var(--green)" fillOpacity={0.7} />
        <text x={14} y={53} fontSize={10} fill="var(--ink-4)" fontFamily="var(--sans)">
          on-ticket ({on_ticket})
        </text>

        <rect x={110} y={44} width={10} height={10} rx={2} fill="var(--amber)" fillOpacity={0.7} />
        <text x={124} y={53} fontSize={10} fill="var(--ink-4)" fontFamily="var(--sans)">
          unticketed ({drift_unticketed})
        </text>

        <rect x={240} y={44} width={10} height={10} rx={2} fill="var(--rule-2)" />
        <text x={254} y={53} fontSize={10} fill="var(--ink-4)" fontFamily="var(--sans)">
          unbuilt ({drift_unbuilt})
        </text>
      </svg>
      <figcaption style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 4 }}>
        Signal drift for <strong>{project_key}</strong>. {signal_total} total signals.
      </figcaption>
    </figure>
  );
}
