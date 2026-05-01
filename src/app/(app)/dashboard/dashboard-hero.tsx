import { withAuth } from '@workos-inc/authkit-nextjs';

interface Snapshot {
  totalItems: number;
  totalDecisions: number;
  lastSyncedAt: string | null;
  openActionItems: number;
  openAnomalies: number;
}

function relWhen(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export async function DashboardHero({ snapshot }: { snapshot: Snapshot }) {
  const { user } = await withAuth();
  const greeting = user?.firstName ?? user?.email?.split('@')[0] ?? 'there';

  return (
    <header className="dash-hero">
      <div className="dash-hero-text">
        <p className="dash-hero-eyebrow">Dashboard</p>
        <h1 className="dash-hero-title">Hey {greeting} —</h1>
        <p className="dash-hero-sub">Here&apos;s what needs you across the workspace.</p>
      </div>
      <dl className="dash-hero-stats">
        <Stat label="open action items" value={snapshot.openActionItems} accent={snapshot.openActionItems > 0 ? 'warm' : undefined} />
        <Stat label="anomalies" value={snapshot.openAnomalies} accent={snapshot.openAnomalies > 0 ? 'alert' : undefined} />
        <Stat label="items synced" value={snapshot.totalItems.toLocaleString()} />
        <Stat label="decisions tracked" value={snapshot.totalDecisions.toLocaleString()} />
        <Stat label="last sync" value={relWhen(snapshot.lastSyncedAt)} muted />
      </dl>
    </header>
  );
}

function Stat({
  label,
  value,
  accent,
  muted,
}: {
  label: string;
  value: number | string;
  accent?: 'warm' | 'alert';
  muted?: boolean;
}) {
  return (
    <div className={`dash-stat${accent ? ` dash-stat-${accent}` : ''}${muted ? ' dash-stat-muted' : ''}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
