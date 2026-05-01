import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { initSchema } from '@/lib/schema';

export const dynamic = 'force-dynamic';

const PARENT_TYPES = "('project','repository','epic','team','milestone')";
const DEFAULT_LIMIT = 3000;

export async function GET(req: Request) {
  initSchema();
  const db = getDb();

  const url = new URL(req.url);
  const requested = Number(url.searchParams.get('limit')) || DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 50), 10000);
  const sourceFilter = url.searchParams.get('source');
  const includeParents = url.searchParams.get('parents') !== 'false';

  // Build the node selection: most recent N items (optionally filtered by
  // source) PLUS all parent hubs (projects/repos/teams/epics) so the graph's
  // structural backbone is always present, even when the slice cuts deep.
  const params: any[] = [];
  let nodeWhere = '';
  if (sourceFilter) {
    nodeWhere = ' AND wi.source = ?';
    params.push(sourceFilter);
  }

  const nodes = db.prepare(`
    WITH recent AS (
      SELECT wi.id FROM work_items wi
      WHERE 1=1 ${nodeWhere}
      ORDER BY wi.created_at DESC
      LIMIT ${limit}
    ),
    parents AS (
      SELECT id FROM work_items
      WHERE ${includeParents ? `item_type IN ${PARENT_TYPES}` : '0=1'}
    ),
    selected AS (
      SELECT id FROM recent
      UNION
      SELECT id FROM parents
    )
    SELECT
      wi.id, wi.title, wi.summary, wi.source, wi.source_id, wi.item_type, wi.status,
      wi.author, wi.url, wi.body, wi.created_at, wi.metadata,
      wi.trace_role, wi.substance, wi.trace_event_at,
      (SELECT GROUP_CONCAT(DISTINCT t.name) FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = wi.id AND t.category = 'type') as type_tag,
      (SELECT GROUP_CONCAT(DISTINCT t.name) FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = wi.id AND t.category = 'topic') as topic_tags,
      (SELECT GROUP_CONCAT(DISTINCT g.name) FROM item_tags it JOIN goals g ON g.id = it.tag_id WHERE it.item_id = wi.id) as goal_names,
      (SELECT GROUP_CONCAT(wsi.workstream_id) FROM workstream_items wsi WHERE wsi.item_id = wi.id) as workstream_ids
    FROM work_items wi
    JOIN selected s ON s.id = wi.id
  `).all(...params) as { id: string }[];

  // Edges: only links where BOTH endpoints are in the selected node set.
  // Use a temp set built from the same selection logic to avoid the
  // inconsistent-subquery bug the previous version had.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const placeholders = Array.from(nodeIds).map(() => '?').join(',');

  let edges: any[] = [];
  if (nodeIds.size > 0) {
    edges = db.prepare(`
      SELECT l.id, l.source_item_id, l.target_item_id, l.link_type, l.confidence
      FROM links l
      WHERE l.source_item_id IN (${placeholders})
        AND l.target_item_id IN (${placeholders})
    `).all(...nodeIds, ...nodeIds);
  }

  return NextResponse.json({
    nodes,
    edges,
    meta: {
      limit,
      sourceFilter,
      includeParents,
      totalNodes: nodes.length,
      totalEdges: edges.length,
    },
  });
}
