'use client';

import React from 'react';

interface LaneEvent {
  sha: string;
  at: string;
}

interface Lane {
  unit_id: string;
  name: string;
  events: LaneEvent[];
}

interface SwimlaneParams {
  project_key: string;
  lanes: Lane[];
}

function isSwimlaneParams(p: unknown): p is SwimlaneParams {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o.project_key === 'string' && Array.isArray(o.lanes);
}

const LANE_H = 36;
const LABEL_W = 160;
const PAD = 12;
const DOT_R = 4;
const TRACK_W = 700;

export function Swimlane({ params }: { params: unknown }) {
  if (!isSwimlaneParams(params) || params.lanes.length === 0) {
    return <figure className="almanac-diagram-empty">No data</figure>;
  }

  const lanes = params.lanes.slice(0, 20);
  const allTimes: number[] = [];
  for (const lane of lanes) {
    for (const ev of lane.events.slice(0, 50)) {
      const t = new Date(ev.at).getTime();
      if (!isNaN(t)) allTimes.push(t);
    }
  }
  if (allTimes.length === 0) {
    return <figure className="almanac-diagram-empty">No data</figure>;
  }

  const minT = Math.min(...allTimes);
  const maxT = Math.max(...allTimes);
  const span = maxT - minT || 1;

  const totalW = LABEL_W + TRACK_W + PAD * 2;
  const headerH = 28;
  const svgH = headerH + lanes.length * LANE_H + PAD;

  function xOf(t: number): number {
    return LABEL_W + ((t - minT) / span) * TRACK_W;
  }

  const minDate = new Date(minT).toISOString().slice(0, 10);
  const maxDate = new Date(maxT).toISOString().slice(0, 10);

  return (
    <figure aria-label={`Swimlane for ${params.project_key}`}>
      <svg
        viewBox={`0 0 ${totalW} ${svgH}`}
        width="100%"
        role="img"
        aria-label={`Event swimlane for project ${params.project_key}`}
      >
        <title>{`${params.project_key} swimlane — ${minDate} to ${maxDate}`}</title>

        {/* header */}
        <text x={PAD} y={18} fontSize={12} fontWeight={600} fill="var(--ink)" fontFamily="var(--sans)">
          {params.project_key}
        </text>
        <text x={LABEL_W} y={18} fontSize={9} fill="var(--ink-5)" fontFamily="var(--sans)">{minDate}</text>
        <text x={LABEL_W + TRACK_W} y={18} fontSize={9} fill="var(--ink-5)" textAnchor="end" fontFamily="var(--sans)">{maxDate}</text>

        {lanes.map((lane, li) => {
          const y = headerH + li * LANE_H;
          const midY = y + LANE_H / 2;
          const labelText = lane.name.length > 20 ? lane.name.slice(0, 19) + '…' : lane.name;
          const events = lane.events.slice(0, 50);

          return (
            <g key={lane.unit_id} aria-label={`Lane: ${lane.name}`}>
              {/* row separator */}
              <line
                x1={0} y1={y}
                x2={totalW} y2={y}
                stroke="var(--rule)" strokeWidth={1}
              />
              {/* lane label */}
              <text
                x={PAD}
                y={midY + 4}
                fontSize={10}
                fill="var(--ink-3)"
                fontFamily="var(--sans)"
              >
                {labelText}
              </text>
              {/* track baseline */}
              <line
                x1={LABEL_W} y1={midY}
                x2={LABEL_W + TRACK_W} y2={midY}
                stroke="var(--rule)" strokeWidth={1}
              />
              {/* events */}
              {events.map((ev, ei) => {
                const t = new Date(ev.at).getTime();
                if (isNaN(t)) return null;
                const cx = xOf(t);
                const evLabel = `${ev.sha.slice(0, 7)} — ${ev.at.slice(0, 10)}`;
                return (
                  <circle
                    key={ei}
                    cx={cx}
                    cy={midY}
                    r={DOT_R}
                    fill="var(--blue)"
                    fillOpacity={0.7}
                    stroke="var(--paper)"
                    strokeWidth={1}
                    aria-label={evLabel}
                  >
                    <title>{evLabel}</title>
                  </circle>
                );
              })}
              {events.length === 50 && lane.events.length > 50 && (
                <text x={LABEL_W + TRACK_W + 4} y={midY + 4} fontSize={9} fill="var(--ink-5)" fontFamily="var(--sans)">
                  +{lane.events.length - 50}
                </text>
              )}
            </g>
          );
        })}

        {/* bottom border */}
        <line
          x1={0} y1={svgH - PAD}
          x2={totalW} y2={svgH - PAD}
          stroke="var(--rule)" strokeWidth={1}
        />
      </svg>
      <figcaption style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 4 }}>
        Event swimlane for <strong>{params.project_key}</strong>. Each row = one functional unit.
      </figcaption>
    </figure>
  );
}
