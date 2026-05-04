'use client';

import React from 'react';

interface WeekBucket {
  week: string;
  count: number;
}

interface ActivityStripParams {
  unit_id: string;
  weekly: WeekBucket[];
}

function isActivityStripParams(p: unknown): p is ActivityStripParams {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o.unit_id === 'string' && Array.isArray(o.weekly);
}

const H = 80;
const PAD = 16;
const W = 800;
const TOP_PAD = 10;
const BOT_PAD = 10;

export function ActivityStrip({ params }: { params: unknown }) {
  if (!isActivityStripParams(params) || params.weekly.length === 0) {
    return <figure className="almanac-diagram-empty">No data</figure>;
  }

  const buckets = params.weekly.slice(-52); // last 52 weeks
  const maxCount = Math.max(...buckets.map(b => b.count), 1);
  const trackH = H - TOP_PAD - BOT_PAD;

  const points = buckets.map((b, i) => {
    const x = PAD + (i / (buckets.length - 1 || 1)) * (W - PAD * 2);
    const y = TOP_PAD + trackH - (b.count / maxCount) * trackH;
    return { x, y, b };
  });

  const polyline = points.map(p => `${p.x},${p.y}`).join(' ');
  const area = `${points[0].x},${TOP_PAD + trackH} ` +
    points.map(p => `${p.x},${p.y}`).join(' ') +
    ` ${points[points.length - 1].x},${TOP_PAD + trackH}`;

  return (
    <figure aria-label={`Activity strip for ${params.unit_id}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Weekly activity sparkline for ${params.unit_id}`}
      >
        <title>{`${params.unit_id} — weekly commit activity`}</title>

        {/* area fill */}
        <polygon points={area} fill="var(--blue)" fillOpacity={0.08} />

        {/* sparkline */}
        <polyline
          points={polyline}
          fill="none"
          stroke="var(--blue)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* dot per bucket with tooltip */}
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={2.5} fill="var(--blue)" fillOpacity={0.7}>
            <title>{`${p.b.week}: ${p.b.count} commits`}</title>
          </circle>
        ))}

        {/* baseline */}
        <line
          x1={PAD} y1={TOP_PAD + trackH}
          x2={W - PAD} y2={TOP_PAD + trackH}
          stroke="var(--rule)" strokeWidth={1}
        />
      </svg>
      <figcaption style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 4 }}>
        Weekly commit activity for <strong>{params.unit_id}</strong>. Max = {maxCount}.
      </figcaption>
    </figure>
  );
}
