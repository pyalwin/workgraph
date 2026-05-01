import { getDb } from '@/lib/db';
import { initSchema } from '@/lib/schema';
import { OverviewClient, type Narrative, type PillarSummary, type DigestSnapshot, type FocusCard } from './overview-client';
import { TrackerSection } from './tracker';

export const dynamic = 'force-dynamic';

interface GoalSnapshot {
  id: string;
  name: string;
  total: number;
  done: number;
  active: number;
  stale: number;
  updated: string | null;
}

interface RecentItem {
  id: string;
  title: string;
  body: string | null;
  author: string | null;
  source: string;
  created_at: string;
  updated_at: string | null;
  item_type: string;
  status: string | null;
  goal_name: string | null;
}

function daysAgo(iso: string | null) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

function relWhen(iso: string | null) {
  const d = daysAgo(iso);
  if (d == null) return '—';
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.round(d / 7)}w ago`;
  return `${Math.round(d / 30)}mo ago`;
}

function sourceLabel(source: string) {
  const map: Record<string, string> = {
    jira: 'Jira',
    slack: 'Slack',
    granola: 'Meetings',
    meetings: 'Meetings',
    notion: 'Notion',
    gmail: 'Gmail',
    github: 'GitHub',
  };
  return map[source.toLowerCase()] ?? source;
}

function gather() {
  try {
    initSchema();
    const db = getDb();

    const totalItems = (db.prepare('SELECT COUNT(*) as c FROM work_items').get() as { c: number })
      .c || 0;
    const totalDecisions = (db
      .prepare("SELECT COUNT(*) as c FROM work_items WHERE item_type IN ('message','meeting')")
      .get() as { c: number }).c || 0;

    const goals = db
      .prepare(
        `
      SELECT g.id, g.name,
        COUNT(it.item_id) as total,
        SUM(CASE WHEN wi.status IN ('done','closed','resolved') THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN wi.status IN ('open','in_progress','to_do') THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN julianday('now') - julianday(COALESCE(wi.updated_at, wi.created_at)) >= 14 AND wi.status NOT IN ('done','closed','resolved') THEN 1 ELSE 0 END) as stale,
        MAX(COALESCE(wi.updated_at, wi.created_at)) as updated
      FROM goals g
      LEFT JOIN item_tags it ON it.tag_id = g.id
      LEFT JOIN work_items wi ON wi.id = it.item_id
      WHERE g.status = 'active'
      GROUP BY g.id
      ORDER BY g.sort_order
    `,
      )
      .all() as GoalSnapshot[];

    const recent = db
      .prepare(
        `
      SELECT wi.id, wi.title, wi.body, wi.author, wi.source, wi.created_at, wi.updated_at,
        wi.item_type, wi.status,
        (SELECT g.name FROM goals g
          JOIN item_tags it ON it.tag_id = g.id
         WHERE it.item_id = wi.id
         LIMIT 1) as goal_name
      FROM work_items wi
      ORDER BY COALESCE(wi.updated_at, wi.created_at) DESC
      LIMIT 6
    `,
      )
      .all() as RecentItem[];

    const sinceRow = (db
      .prepare("SELECT MAX(COALESCE(updated_at, created_at)) as lastSeen FROM work_items")
      .get() as { lastSeen: string | null } | undefined) ?? { lastSeen: null };

    const digest5 = db
      .prepare(
        `
      SELECT
        SUM(CASE WHEN item_type IN ('ticket','task','epic') AND status IN ('done','closed','resolved') THEN 1 ELSE 0 END) as shipped,
        SUM(CASE WHEN item_type = 'pr' AND status IN ('merged','closed') THEN 1 ELSE 0 END) as merged,
        SUM(CASE WHEN item_type = 'message' THEN 1 ELSE 0 END) as decisions,
        SUM(CASE WHEN item_type = 'meeting' THEN 1 ELSE 0 END) as meetings
      FROM work_items
      WHERE julianday('now') - julianday(COALESCE(updated_at, created_at)) <= 5
    `,
      )
      .get() as { shipped: number; merged: number; decisions: number; meetings: number };

    const topThreadRow = db
      .prepare(
        `
      SELECT wi.title, COUNT(l.id) as refs
      FROM work_items wi
      LEFT JOIN links l ON l.source_item_id = wi.id OR l.target_item_id = wi.id
      GROUP BY wi.id
      HAVING refs > 0
      ORDER BY refs DESC
      LIMIT 1
    `,
      )
      .get() as { title: string; refs: number } | undefined;

    return { totalItems, totalDecisions, goals, recent, lastSeen: sinceRow.lastSeen, digest5, topThread: topThreadRow };
  } catch {
    return {
      totalItems: 0,
      totalDecisions: 0,
      goals: [] as GoalSnapshot[],
      recent: [] as RecentItem[],
      lastSeen: null as string | null,
      digest5: { shipped: 0, merged: 0, decisions: 0, meetings: 0 },
      topThread: undefined as { title: string; refs: number } | undefined,
    };
  }
}

function pickHealth(g: GoalSnapshot): PillarSummary['health'] {
  if (g.total === 0) return 'neutral';
  const doneRatio = g.done / Math.max(g.total, 1);
  const staleRatio = g.stale / Math.max(g.total, 1);
  if (staleRatio >= 0.35) return 'at-risk';
  if (staleRatio >= 0.15) return 'drifting';
  if (doneRatio >= 0.5) return 'good';
  return 'neutral';
}

function buildFocus(goals: GoalSnapshot[], recent: RecentItem[]): FocusCard {
  const stalest = [...goals].sort((a, b) => b.stale - a.stale)[0];
  if (stalest && stalest.stale > 0) {
    return {
      kicker: '● Focus · needs you now',
      kickerRight: 'auto-picked',
      title: `${stalest.stale} item${stalest.stale === 1 ? '' : 's'} in ${stalest.name} are stale (14+ days)`,
      subtitle: `Out of ${stalest.total}, ${stalest.done} done and ${stalest.active} active. No owner has moved the stale set in two weeks.`,
      reason: `This pillar has the highest staleness ratio — unblock it before it drifts further.`,
      actions: [
        { label: 'Open stale list', kind: 'primary' },
        { label: 'Snooze 1d', kind: 'ghost' },
      ],
    };
  }
  const firstRecent = recent[0];
  if (firstRecent) {
    return {
      kicker: '● Focus · today',
      kickerRight: 'auto-picked',
      title: firstRecent.title,
      subtitle: firstRecent.body?.slice(0, 220) ?? 'Latest activity surfaced from your sources.',
      reason: `Most recent signal across ${sourceLabel(firstRecent.source)} — start here.`,
      actions: [{ label: 'Open', kind: 'primary' }],
    };
  }
  return {
    kicker: '● Focus',
    kickerRight: 'no active signals',
    title: 'Nothing blocking — sync more sources to populate Focus',
    subtitle: 'Once data is flowing, the most important item will appear here automatically.',
    reason: 'Run a sync from Settings to connect Jira, Slack, and meetings.',
    actions: [],
  };
}

export default function OverviewPage() {
  const data = gather();

  const narratives: Narrative[] = data.recent.map((r) => {
    const stale = daysAgo(r.updated_at ?? r.created_at);
    const tone: Narrative['tone'] = stale != null && stale >= 14 ? 'stalled' : r.status === 'done' ? 'moved' : stale != null && stale >= 7 ? 'risk' : 'moved';
    return {
      id: r.id,
      tone,
      when: relWhen(r.updated_at ?? r.created_at).toUpperCase(),
      text: r.title,
      source: sourceLabel(r.source),
      author: r.author || '—',
      pillar: r.goal_name || 'General',
      quote: r.body ?? '',
    };
  });

  const pillars: PillarSummary[] = data.goals.map((g) => ({
    name: g.name,
    note: `${g.done}/${g.total} done · ${g.active} active${g.stale ? ` · ${g.stale} stale` : ''}`,
    items: g.total,
    health: pickHealth(g),
  }));

  const digest: DigestSnapshot = {
    range: 'Last 5 days',
    shipped: data.digest5.shipped ?? 0,
    merged: data.digest5.merged ?? 0,
    decisions: data.digest5.decisions ?? 0,
    meetings: data.digest5.meetings ?? 0,
    topThread: data.topThread?.title ?? 'No cross-referenced thread yet',
    quietest: pillars.length
      ? (pillars.reduce((min, p) => (p.items < min.items ? p : min), pillars[0]).name +
        ' — lowest activity')
      : 'No pillars yet',
    newSignal:
      data.recent[0]?.title ?? 'No new signals yet — sync a source',
  };

  const focus = buildFocus(data.goals, data.recent);

  return (
    <>
      {/* @ts-expect-error — Server Component returning JSX is fine; React's typing
          gets cranky when we await Server Components mid-tree. */}
      <TrackerSection />
      <OverviewClient
        totalItems={data.totalItems}
        totalDecisions={data.totalDecisions}
        lastSeenLabel={relWhen(data.lastSeen)}
        narratives={narratives}
        pillars={pillars}
        digest={digest}
        focus={focus}
      />
    </>
  );
}
