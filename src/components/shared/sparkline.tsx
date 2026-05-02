interface SparklineProps {
  trend: 'up' | 'down' | 'flat';
  width?: number;
  height?: number;
}

export function Sparkline({ trend, width = 72, height = 26 }: SparklineProps) {
  const color = trend === 'up' ? 'var(--green)' : trend === 'down' ? 'var(--red)' : 'var(--g5)';
  const path = trend === 'up'
    ? 'M0 20C8 17 14 18 22 14C30 10 38 12 46 8C54 5 62 6 68 3L72 2'
    : trend === 'down'
    ? 'M0 6C10 8 18 12 26 14C34 16 42 18 50 20C58 19 64 21 70 22L72 23'
    : 'M0 14C10 12 18 15 26 13C34 14 42 12 50 14C58 13 64 14 70 13L72 13';
  const areaEnd = trend === 'down' ? 'L72 23V26H0Z' : trend === 'up' ? 'L72 2V26H0Z' : 'L72 13V26H0Z';

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      <path d={`${path}V${height}H0Z`} fill={color} opacity="0.06" />
    </svg>
  );
}
