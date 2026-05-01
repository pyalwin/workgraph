interface ActivityRow {
  id: string;
  source_id: string;
  title: string;
  source: string;
  status: string | null;
  url: string | null;
  updated_at: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  jira: 'JRA',
  github: 'GH',
  notion: 'NOT',
  slack: 'SLK',
  granola: 'MTG',
  linear: 'LIN',
  gitlab: 'GLB',
  gmail: 'EML',
};

function relWhen(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function ActivityFeed({ activity }: { activity: ActivityRow[] }) {
  if (activity.length === 0) {
    return (
      <section className="dash-activity">
        <header className="dash-activity-head">
          <h2>Recent activity</h2>
        </header>
        <p className="dash-empty">No activity yet — connect a source to start syncing.</p>
      </section>
    );
  }

  return (
    <section className="dash-activity">
      <header className="dash-activity-head">
        <h2>Recent activity</h2>
        <span className="dash-activity-count">last {activity.length} updates across sources</span>
      </header>
      <ul className="dash-activity-list">
        {activity.map((row) => {
          const Tag = row.url ? 'a' : 'div';
          const tagProps = row.url ? { href: row.url, target: '_blank', rel: 'noreferrer' } : {};
          return (
            <li key={row.id}>
              <span className={`dash-activity-src dash-activity-src-${row.source}`}>
                {SOURCE_LABEL[row.source] ?? row.source.slice(0, 3).toUpperCase()}
              </span>
              <Tag className="dash-activity-link" {...tagProps}>
                <span className="dash-activity-id">{row.source_id}</span>
                <span className="dash-activity-title">{row.title}</span>
              </Tag>
              {row.status && <span className={`dash-activity-status state-${row.status}`}>{row.status.replace(/_/g, ' ')}</span>}
              <span className="dash-activity-when">{relWhen(row.updated_at)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
