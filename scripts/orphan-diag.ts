import { config } from 'dotenv';
config({ path: '.env.local' });
import { getDb } from '../src/lib/db';
const db = getDb();

console.log('=== 1. items with NO edges at all (true orphans) ===');
const isolated = db.prepare(`
  SELECT source, item_type, count(*) as n
  FROM work_items wi
  WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.source_item_id = wi.id OR l.target_item_id = wi.id)
  GROUP BY source, item_type ORDER BY n DESC
`).all() as any[];
isolated.forEach((r) => console.log('  ' + (r.source+'/'+r.item_type).padEnd(30) + r.n));
const totalIsolated = isolated.reduce((s, r) => s + r.n, 0);
console.log('  TOTAL ISOLATED:', totalIsolated);

console.log('\n=== 2. dangling edges (endpoint missing from work_items) ===');
const dangling = db.prepare(`
  SELECT count(*) as n FROM links l
  WHERE NOT EXISTS (SELECT 1 FROM work_items WHERE id = l.source_item_id)
     OR NOT EXISTS (SELECT 1 FROM work_items WHERE id = l.target_item_id)
`).get() as any;
console.log('  count:', dangling.n);

console.log('\n=== 3. parent placeholders with NO incoming children ===');
const emptyParents = db.prepare(`
  SELECT source, item_type, source_id
  FROM work_items wi
  WHERE item_type IN ('project','repository','epic','team')
    AND NOT EXISTS (SELECT 1 FROM links l WHERE l.target_item_id = wi.id)
`).all() as any[];
emptyParents.forEach((r) => console.log('  ' + (r.source+'/'+r.item_type).padEnd(20) + r.source_id));
console.log('  TOTAL EMPTY PARENTS:', emptyParents.length);

console.log('\n=== 4. jira epic placeholders (no real fetch yet) ===');
const placeholders = db.prepare(`
  SELECT source_id, title, item_type
  FROM work_items
  WHERE source='jira' AND json_extract(metadata, '$.placeholder') = 1
`).all() as any[];
console.log('  placeholder count:', placeholders.length);
placeholders.slice(0, 10).forEach((r) => console.log('   ' + r.source_id.padEnd(15) + r.item_type.padEnd(10) + r.title));

console.log('\n=== 5. items per source by edge degree (0 = orphan) ===');
const degree = db.prepare(`
  SELECT wi.source, wi.item_type,
    (SELECT count(*) FROM links l WHERE l.source_item_id = wi.id OR l.target_item_id = wi.id) as deg,
    count(*) as n
  FROM work_items wi
  GROUP BY wi.source, wi.item_type, deg
  HAVING deg = 0
  ORDER BY n DESC
`).all() as any[];
degree.forEach((r) => console.log('  ' + (r.source+'/'+r.item_type).padEnd(30) + r.n));
