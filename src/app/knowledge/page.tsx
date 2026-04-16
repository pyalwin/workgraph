import { getDb } from '@/lib/db';
import { initSchema } from '@/lib/schema';
import KnowledgeClient, { type KnowledgeItem } from './knowledge-client';

export const dynamic = 'force-dynamic';

export default function KnowledgePage() {
  const db = getDb();
  initSchema();

  const items = db.prepare(`
    SELECT wi.id, wi.source, wi.source_id, wi.item_type, wi.title, wi.body, wi.author, wi.status, wi.created_at, wi.url,
      GROUP_CONCAT(g.name) as goal_names,
      (SELECT COUNT(*) FROM links WHERE source_item_id = wi.id OR target_item_id = wi.id) as link_count
    FROM work_items wi
    LEFT JOIN item_tags it ON it.item_id = wi.id
    LEFT JOIN goals g ON g.id = it.tag_id
    GROUP BY wi.id
    ORDER BY wi.created_at DESC
    LIMIT 100
  `).all() as KnowledgeItem[];

  const totalItems = (db.prepare('SELECT COUNT(*) as c FROM work_items').get() as { c: number }).c;
  const totalLinks = (db.prepare('SELECT COUNT(*) as c FROM links').get() as { c: number }).c;

  return (
    <KnowledgeClient
      items={items}
      totalItems={totalItems}
      totalLinks={totalLinks}
    />
  );
}
