import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { MetricsClient, type GoalDisplay } from './metrics-client';

export const dynamic = 'force-dynamic';

interface GoalRow {
  id: string;
  name: string;
  description: string | null;
  total: number;
  done: number;
  active: number;
  stale: number;
  velocity_7d: number;
}

interface SourceRow {
  source: string;
  count: number;
}

interface WeekRow {
  week_start: string;
  count: number;
}

interface HighlightRow {
  id: string;
  title: string;
  source: string;
  created_at: string;
  updated_at: string | null;
}

function relWhen(iso: string | null) {
  if (!iso) return '—';
  const d = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.round(d / 7)}w ago`;
  return `${Math.round(d / 30)}mo ago`;
}

function buildGoalDisplay(
  row: GoalRow,
  perSource: Map<string, Record<string, number>>,
  velocityByGoal: Map<string, number[]>,
  highlights: Map<string, HighlightRow[]>,
): GoalDisplay {
  const total = row.total;
  const done = row.done;
  const active = row.active;
  const stale = row.stale;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  const status: GoalDisplay['status'] =
    total === 0
      ? 'new'
      : stale / Math.max(total, 1) >= 0.35
      ? 'at-risk'
      : stale / Math.max(total, 1) >= 0.15
      ? 'watch'
      : progress >= 50
      ? 'on-track'
      : 'watch';

  const sources = perSource.get(row.id) ?? {};
  const velocity = velocityByGoal.get(row.id) ?? Array(13).fill(0);

  const prior = velocity.slice(-4, -1).reduce((a, b) => a + b, 0) / 3 || 0;
  const recent = velocity.slice(-1)[0] || 0;
  const deltaPct = prior > 0 ? Math.round(((recent - prior) / prior) * 100) : 0;

  const hl = (highlights.get(row.id) ?? []).slice(0, 6).map((h) => ({
    id: h.id,
    when: relWhen(h.updated_at ?? h.created_at),
    text: h.title,
    source: h.source.toLowerCase(),
  }));

  const risks: GoalDisplay['risks'] = [];
  if (stale > 0) {
    risks.push({
      text: `${stale} item${stale === 1 ? '' : 's'} with no movement in 14+ days`,
      severity: stale / Math.max(total, 1) >= 0.35 ? 'high' : 'med',
    });
  }
  if (total > 5 && Object.keys(sources).length <= 1) {
    risks.push({
      text: 'All items from a single source — cross-source signal weak',
      severity: 'low',
    });
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    owner: 'team',
    status,
    progress,
    items: { total, done, active, stale },
    sources,
    velocity,
    metrics: [
      {
        label: 'Active',
        value: String(active),
        delta: total > 0 ? `${Math.round((active / total) * 100)}% of total` : '—',
        good: active > 0,
      },
      {
        label: 'Done',
        value: String(done),
        delta: `${progress}%`,
        good: progress >= 50,
      },
      {
        label: 'Stale',
        value: String(stale),
        delta: total > 0 ? `${Math.round((stale / Math.max(total, 1)) * 100)}% of total` : '—',
        good: stale === 0,
      },
      {
        label: 'Velocity',
        value: String(recent),
        delta: deltaPct === 0 ? 'steady' : `${deltaPct >= 0 ? '+' : ''}${deltaPct}%`,
        good: deltaPct >= 0,
      },
    ],
    highlights: hl,
    risks,
    northStar: total > 0
      ? {
          label: 'Completion',
          value: progress,
          delta: deltaPct,
          unit: '%',
          target: 100,
        }
      : null,
  };
}

export default async function MetricsPage() {
  let goals: GoalDisplay[] = [];
  let totalItems = 0;
  let sourcesCount = 0;

  try {
    await ensureSchemaAsync();
    const db = getLibsqlDb();

    const totalItemsRow = await db
      .prepare('SELECT COUNT(*) as c FROM work_items')
      .get<{ c: number }>();
    totalItems = totalItemsRow?.c ?? 0;

    const goalRows = await db
      .prepare(
        `SELECT g.id, g.name, g.description,
          COUNT(DISTINCT wi.id) as total,
          SUM(CASE WHEN wi.status IN ('done','closed','resolved') THEN 1 ELSE 0 END) as done,
          SUM(CASE WHEN wi.status IN ('open','in_progress','to_do') THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN julianday('now') - julianday(COALESCE(wi.updated_at, wi.created_at)) >= 14 AND wi.status NOT IN ('done','closed','resolved') THEN 1 ELSE 0 END) as stale,
          SUM(CASE WHEN wi.updated_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) as velocity_7d
        FROM goals g
        LEFT JOIN item_tags it ON it.tag_id = g.id
        LEFT JOIN work_items wi ON wi.id = it.item_id
        WHERE g.status = 'active'
        GROUP BY g.id
        ORDER BY g.sort_order`,
      )
      .all<GoalRow>();

    const perSourceRows = await db
      .prepare(
        `SELECT g.id as goal_id, wi.source, COUNT(*) as count
         FROM goals g
         JOIN item_tags it ON it.tag_id = g.id
         JOIN work_items wi ON wi.id = it.item_id
         GROUP BY g.id, wi.source`,
      )
      .all<{ goal_id: string; source: string; count: number }>();

    const perSource = new Map<string, Record<string, number>>();
    for (const r of perSourceRows) {
      const existing = perSource.get(r.goal_id) ?? {};
      existing[r.source] = r.count;
      perSource.set(r.goal_id, existing);
    }

    const sourcesSet = new Set<string>();
    perSourceRows.forEach((r) => sourcesSet.add(r.source));
    sourcesCount = sourcesSet.size;

    const velocityRows = await db
      .prepare(
        `SELECT g.id as goal_id, strftime('%Y-%W', wi.updated_at) as week, COUNT(*) as c
         FROM goals g
         JOIN item_tags it ON it.tag_id = g.id
         JOIN work_items wi ON wi.id = it.item_id
         WHERE wi.updated_at >= datetime('now','-91 days')
         GROUP BY g.id, week
         ORDER BY g.id, week`,
      )
      .all<{ goal_id: string; week: string; c: number }>();

    const velByGoal = new Map<string, number[]>();
    for (const v of velocityRows) {
      const list = velByGoal.get(v.goal_id) ?? [];
      list.push(v.c);
      velByGoal.set(v.goal_id, list);
    }
    velByGoal.forEach((list, key) => {
      const padded = [...list];
      while (padded.length < 13) padded.unshift(0);
      velByGoal.set(key, padded.slice(-13));
    });

    const highlightRows = await db
      .prepare(
        `SELECT g.id as goal_id, wi.id as id, wi.title, wi.source, wi.created_at, wi.updated_at
         FROM goals g
         JOIN item_tags it ON it.tag_id = g.id
         JOIN work_items wi ON wi.id = it.item_id
         ORDER BY COALESCE(wi.updated_at, wi.created_at) DESC`,
      )
      .all<HighlightRow & { goal_id: string }>();

    const highlightByGoal = new Map<string, HighlightRow[]>();
    for (const h of highlightRows) {
      const list = highlightByGoal.get(h.goal_id) ?? [];
      if (list.length < 6) list.push(h);
      highlightByGoal.set(h.goal_id, list);
    }

    goals = goalRows.map((g) => buildGoalDisplay(g, perSource, velByGoal, highlightByGoal));
  } catch {
    goals = [];
  }

  return <MetricsClient goals={goals} totalItems={totalItems} sourcesCount={sourcesCount} />;
}
