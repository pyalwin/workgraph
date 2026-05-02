/**
 * Phase 2.5 — per-user tracker block on /dashboard.
 *
 * Server-rendered. Reads:
 *   - the user's open Jira items (metadata.is_mine = true), sorted by ai_priority
 *   - their open action items (assignee matches a workspace alias)
 *   - their owned goals (goals.owner_user_id)
 *   - open anomalies for the active workspace (top 5 by severity)
 *
 * Seeds aliases from the auth identity on first call so a brand-new user
 * gets reasonable defaults (their full name + email + email handle).
 */
import Link from 'next/link';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import { getUserAliases, seedAliasesFromAuth } from '@/lib/sync/identity';

const PRIORITY_ORDER: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

interface OpenItem {
  id: string;
  source_id: string;
  title: string;
  status: string | null;
  url: string | null;
  ai_priority: string | null;
}

interface OpenActionItem {
  id: string;
  text: string;
  ai_priority: string | null;
  user_priority: string | null;
  due_at: string | null;
  source_item_id: string;
  source_title: string;
}

interface OwnedGoal {
  id: string;
  name: string;
  target_metric: string | null;
  target_value: number | null;
  target_at: string | null;
  ai_confidence: number | null;
  derived_from: string;
  done_count: number;
  total_count: number;
}

interface OpenAnomaly {
  id: string;
  scope: string;
  kind: string;
  severity: number;
  explanation: string | null;
}

async function gatherTracker(workspaceId: string, authUserId: string) {
  const db = getLibsqlDb();

  const myItems = await db
    .prepare(
      `SELECT wi.id, wi.source_id, wi.title, wi.status, wi.url,
              (SELECT ai_priority FROM action_items
               WHERE source_item_id = wi.id AND state = 'open'
               ORDER BY ai_priority ASC LIMIT 1) AS ai_priority
       FROM work_items wi
       WHERE wi.source = 'jira'
         AND wi.status IN ('active','open')
         AND json_extract(wi.metadata, '$.is_mine') = 1
       ORDER BY COALESCE(wi.updated_at, wi.created_at) DESC
       LIMIT 50`,
    )
    .all<OpenItem>();

  myItems.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.ai_priority ?? 'p3'] ?? 3;
    const pb = PRIORITY_ORDER[b.ai_priority ?? 'p3'] ?? 3;
    return pa - pb;
  });

  const aliases = Array.from(await getUserAliases(workspaceId, authUserId));
  let myActions: OpenActionItem[] = [];
  if (aliases.length > 0) {
    const placeholders = aliases.map(() => '?').join(',');
    myActions = await db
      .prepare(
        `SELECT ai.id, ai.text, ai.ai_priority, ai.user_priority, ai.due_at,
                ai.source_item_id, wi.title AS source_title
         FROM action_items ai
         JOIN work_items wi ON wi.id = ai.source_item_id
         WHERE ai.state = 'open'
           AND LOWER(COALESCE(ai.assignee, '')) IN (${placeholders})
         ORDER BY COALESCE(ai.user_priority, ai.ai_priority, 'p9') ASC,
                  ai.due_at ASC NULLS LAST
         LIMIT 20`,
      )
      .all<OpenActionItem>(...aliases);
  }

  const ownedGoals = await db
    .prepare(
      `SELECT g.id, g.name, g.target_metric, g.target_value, g.target_at,
              g.ai_confidence, g.derived_from,
              (SELECT COUNT(*) FROM item_tags it JOIN work_items wi ON wi.id = it.item_id
                 WHERE it.tag_id = g.id AND wi.status IN ('done','closed','resolved')) AS done_count,
              (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id = g.id) AS total_count
       FROM goals g
       WHERE g.owner_user_id = ?
         AND g.status = 'active'
       ORDER BY g.target_at ASC NULLS LAST`,
    )
    .all<OwnedGoal>(authUserId);

  const openAnomalies = await db
    .prepare(
      `SELECT id, scope, kind, severity, explanation
       FROM anomalies
       WHERE workspace_id = ?
         AND resolved_at IS NULL
         AND dismissed_by_user = 0
       ORDER BY severity DESC
       LIMIT 5`,
    )
    .all<OpenAnomaly>(workspaceId);

  return { myItems: myItems.slice(0, 8), myActions, ownedGoals, openAnomalies };
}

async function pickDefaultWorkspaceId(): Promise<string | null> {
  const db = getLibsqlDb();
  const row = await db
    .prepare(
      `SELECT workspace_id FROM workspace_connector_configs
       WHERE status != 'skipped'
       ORDER BY workspace_id LIMIT 1`,
    )
    .get<{ workspace_id: string }>();
  return row?.workspace_id ?? null;
}

export async function TrackerSection({ workspaceId }: { workspaceId?: string }) {
  const { user } = await withAuth();
  if (!user) return null;

  await ensureSchemaAsync();
  const resolvedWorkspaceId = workspaceId ?? (await pickDefaultWorkspaceId());
  if (!resolvedWorkspaceId) return null;

  // Seed reasonable aliases on first run so is_mine matching has something to
  // work with even before the user manually adds any.
  await seedAliasesFromAuth(resolvedWorkspaceId, {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
  });

  const data = await gatherTracker(resolvedWorkspaceId, user.id);
  const greeting = user.firstName ?? user.email?.split('@')[0] ?? 'there';

  return (
    <section className="tracker">
      <header className="tracker-head">
        <h2>Hey {greeting} —</h2>
        <p className="tracker-sub">your week, surfaced from across the workspace.</p>
      </header>

      <div className="tracker-grid">
        <Card title="Your open work" count={data.myItems.length}>
          {data.myItems.length === 0 ? (
            <Empty text="Nothing open is yours right now. " />
          ) : (
            <ul className="tracker-list">
              {data.myItems.map((it) => (
                <li key={it.id}>
                  <PriorityChip p={it.ai_priority} />
                  <a href={it.url ?? '#'} target="_blank" rel="noreferrer" className="tracker-item-link">
                    <span className="tracker-item-key">{it.source_id}</span>
                    <span className="tracker-item-title">{it.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Action items for you" count={data.myActions.length}>
          {data.myActions.length === 0 ? (
            <Empty text="No action items pinned to you. AI extracts these from issue bodies + comments." />
          ) : (
            <ul className="tracker-list">
              {data.myActions.map((a) => (
                <li key={a.id}>
                  <PriorityChip p={a.user_priority ?? a.ai_priority} />
                  <span className="tracker-item-title">
                    {a.text}
                    <span className="tracker-item-from">— {a.source_title.slice(0, 60)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Your goals" count={data.ownedGoals.length}>
          {data.ownedGoals.length === 0 ? (
            <Empty text="No goals owned by you yet. Create one or claim an AI-suggested goal." />
          ) : (
            <ul className="tracker-list">
              {data.ownedGoals.map((g) => {
                const pct = g.total_count > 0 ? Math.round((g.done_count / g.total_count) * 100) : 0;
                return (
                  <li key={g.id} className="tracker-goal">
                    <div className="tracker-goal-head">
                      <span className="tracker-item-title">{g.name}</span>
                      <span className="tracker-goal-pct">{pct}%</span>
                    </div>
                    <div className="tracker-goal-bar">
                      <div className="tracker-goal-bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="tracker-goal-meta">
                      {g.done_count}/{g.total_count} done
                      {g.target_at ? ` · due ${new Date(g.target_at).toLocaleDateString()}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Watch this week" count={data.openAnomalies.length}>
          {data.openAnomalies.length === 0 ? (
            <Empty text="No anomalies detected. The weekly scan runs Mondays." />
          ) : (
            <ul className="tracker-list">
              {data.openAnomalies.map((a) => (
                <li key={a.id} className="tracker-anomaly">
                  <span className={`tracker-anomaly-kind tracker-anomaly-${a.kind}`}>
                    {a.kind.replace('_', ' ')}
                  </span>
                  <span className="tracker-item-title">{a.explanation ?? a.scope}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </section>
  );
}

function Card({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <article className="tracker-card">
      <div className="tracker-card-head">
        <h3>{title}</h3>
        <span className="tracker-card-count">{count}</span>
      </div>
      {children}
    </article>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="tracker-empty">{text}</p>;
}

function PriorityChip({ p }: { p: string | null | undefined }) {
  const v = (p ?? 'p3').toLowerCase();
  return <span className={`tracker-pri tracker-pri-${v}`}>{v}</span>;
}
