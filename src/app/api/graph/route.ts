import { NextResponse } from 'next/server';
import { ensureSchemaAsync } from '@/lib/db/init-schema-async';
import { getLibsqlDb } from '@/lib/db/libsql';
import {
  buildWorkspaceItemFilter,
  getRequestWorkspaceId,
} from '@/lib/active-workspace';

export const dynamic = 'force-dynamic';

const PARENT_TYPES = "('project','repository','epic','team','milestone','deal','investor','candidate')";
const DEFAULT_LIMIT = 800;
const ORPHAN_FILTER_DEFAULT = true;

export async function GET(req: Request) {
  await ensureSchemaAsync();
  const db = getLibsqlDb();

  const url = new URL(req.url);
  const requested = Number(url.searchParams.get('limit')) || DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 50), 10000);
  const sourceFilter = url.searchParams.get('source');
  const includeParents = url.searchParams.get('parents') !== 'false';

  const workspaceId = await getRequestWorkspaceId(url.searchParams);
  const wsFilter = await buildWorkspaceItemFilter(workspaceId, 'wi');

  // Build the node selection: most recent N items (optionally filtered by
  // source) PLUS all parent hubs (projects/repos/teams/epics) so the graph's
  // structural backbone is always present, even when the slice cuts deep.
  const recentParams: any[] = [];
  const recentConds: string[] = [wsFilter.sql];
  recentParams.push(...wsFilter.params);
  if (sourceFilter) {
    recentConds.push('wi.source = ?');
    recentParams.push(sourceFilter);
  }

  // Parent hub filter — also constrained to the active workspace so we
  // don't leak in foreign workspaces' projects/repos/teams.
  const parentFilter = await buildWorkspaceItemFilter(workspaceId, '');
  const parentWhere = includeParents
    ? `item_type IN ${PARENT_TYPES} AND ${parentFilter.sql}`
    : '0=1';

  const nodes = await db
    .prepare(
      `WITH recent AS (
        SELECT wi.id FROM work_items wi
        WHERE ${recentConds.join(' AND ')}
        ORDER BY wi.created_at DESC
        LIMIT ${limit}
      ),
      parents AS (
        SELECT id FROM work_items
        WHERE ${parentWhere}
      ),
      selected AS (
        SELECT id FROM recent
        UNION
        SELECT id FROM parents
      )
      SELECT
        wi.id, wi.title, wi.summary, wi.source, wi.source_id, wi.item_type, wi.status,
        wi.author, wi.url, wi.created_at,
        -- Body excluded from the list payload — lazy-fetched via /api/items/[id]
        -- on node selection. Metadata excluded too (Gmail participants etc. can
        -- be multi-KB per node); we only pluck the one field the sizing logic
        -- actually reads (commits_count for PR nodes).
        json_extract(wi.metadata, '$.commits_count') as commits_count,
        wi.trace_role, wi.substance, wi.trace_event_at,
        -- tags/goals joined via item_tags inherit workspace scoping from
        -- the wi.id filter above (work_items are already scoped through
        -- the recent/parents CTEs). No additional workspace filter needed.
        (SELECT GROUP_CONCAT(DISTINCT t.name) FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = wi.id AND t.category = 'type') as type_tag,
        (SELECT GROUP_CONCAT(DISTINCT t.name) FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = wi.id AND t.category = 'topic') as topic_tags,
        (SELECT GROUP_CONCAT(DISTINCT g.name) FROM item_tags it JOIN goals g ON g.id = it.tag_id WHERE it.item_id = wi.id) as goal_names,
        (SELECT GROUP_CONCAT(wsi.workstream_id) FROM workstream_items wsi WHERE wsi.item_id = wi.id) as workstream_ids
      FROM work_items wi
      JOIN selected s ON s.id = wi.id`,
    )
    .all<{ id: string }>(...recentParams, ...(includeParents ? parentFilter.params : []));

  // Edges: only links where BOTH endpoints are in the selected node set.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const placeholders = Array.from(nodeIds).map(() => '?').join(',');

  let edges: any[] = [];
  if (nodeIds.size > 0) {
    edges = await db
      .prepare(
        `SELECT l.id, l.source_item_id, l.target_item_id, l.link_type, l.confidence
         FROM links l
         WHERE l.source_item_id IN (${placeholders})
           AND l.target_item_id IN (${placeholders})`,
      )
      .all(...nodeIds, ...nodeIds);
  }

  // Orphan filter — by default drop nodes with no edges (other than parent
  // hubs, which are always kept). Cuts the visual noise of disconnected
  // emails/events/docs floating around the periphery.
  const dropOrphans = url.searchParams.get('orphans') !== 'true' && ORPHAN_FILTER_DEFAULT;
  let filteredNodes = nodes;
  let droppedOrphans = 0;
  if (dropOrphans) {
    const connected = new Set<string>();
    for (const e of edges) {
      connected.add(e.source_item_id);
      connected.add(e.target_item_id);
    }
    const keep = (n: any): boolean => {
      if (connected.has(n.id)) return true;
      const itemType = String(n.item_type || '').toLowerCase();
      // Always keep structural hubs even when disconnected.
      return ['project', 'repository', 'epic', 'team', 'milestone', 'deal', 'investor', 'candidate'].includes(itemType);
    };
    filteredNodes = nodes.filter(keep);
    droppedOrphans = nodes.length - filteredNodes.length;
  }

  return NextResponse.json({
    nodes: filteredNodes,
    edges,
    meta: {
      limit,
      sourceFilter,
      includeParents,
      totalNodes: filteredNodes.length,
      totalEdges: edges.length,
      droppedOrphans,
    },
  });
}
