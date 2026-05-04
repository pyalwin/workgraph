'use client';

import React from 'react';

type Intent = 'introduce' | 'extend' | 'refactor' | 'fix' | 'revert' | 'mixed' | null;

interface LifeEvent {
  sha: string;
  occurred_at: string;
  intent?: Intent;
}

interface LifespanStripParams {
  unit_id: string;
  events: LifeEvent[];
}

function isLifespanStripParams(p: unknown): p is LifespanStripParams {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o.unit_id === 'string' && Array.isArray(o.events);
}

function intentColor(intent: Intent | undefined): string {
  switch (intent) {
    case 'introduce': return 'var(--green)';
    case 'extend':    return 'var(--blue)';
    case 'refactor':  return '#7c3aed';
    case 'fix':       return 'var(--amber)';
    case 'revert':    return 'var(--red)';
    default:          return 'var(--ink-5)';
  }
}

const H = 60;
const R = 5;
const PAD = 16;

export function LifespanStrip({ params }: { params: unknown }) {
  if (!isLifespanStripParams(params) || params.events.length === 0) {
    return <figure className="almanac-diagram-empty">No data</figure>;
  }

  const events = params.events.slice(0, 50);
  const times = events.map(e => new Date(e.occurred_at).getTime()).filter(t => !isNaN(t));
  if (times.length === 0) return <figure className="almanac-diagram-empty">No data</figure>;

  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const span = maxT - minT || 1;

  const W = 800;
  const trackY = H / 2;

  return (
    <figure aria-label={`Lifespan strip for ${params.unit_id}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Event timeline for unit ${params.unit_id}`}
        style={{ overflow: 'visible' }}
      >
        <title>{`${params.unit_id} — ${events.length} events over time`}</title>

        {/* baseline */}
        <line
          x1={PAD} y1={trackY}
          x2={W - PAD} y2={trackY}
          stroke="var(--rule-2)" strokeWidth={1}
        />

        {events.map((ev, i) => {
          const t = new Date(ev.occurred_at).getTime();
          if (isNaN(t)) return null;
          const x = PAD + ((t - minT) / span) * (W - PAD * 2);
          const color = intentColor(ev.intent);
          const label = `${ev.intent ?? 'unknown'} — ${ev.sha.slice(0, 7)} (${ev.occurred_at.slice(0, 10)})`;

          return (
            <circle
              key={i}
              cx={x}
              cy={trackY}
              r={R}
              fill={color}
              fillOpacity={0.85}
              stroke="var(--paper)"
              strokeWidth={1}
              aria-label={label}
            >
              <title>{label}</title>
            </circle>
          );
        })}

        {events.length === 50 && (
          <text x={W - PAD} y={trackY - 8} fontSize={9} fill="var(--ink-5)" textAnchor="end" fontFamily="var(--sans)">
            (capped at 50)
          </text>
        )}
      </svg>
      <figcaption style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 4 }}>
        Event timeline for <strong>{params.unit_id}</strong>. Color = intent.
      </figcaption>
    </figure>
  );
}
