/**
 * Lists work items that haven't been enriched yet.
 * The Claude scheduled agent reads this output, generates enrichment for each item,
 * then pipes the results to store-enrichment.ts.
 *
 * Usage: bunx tsx scripts/list-unenriched.ts [--limit=N]
 * Output: JSON array of { id, title, body, source }
 */
import { getDb } from '../src/lib/db';
import { initSchema } from '../src/lib/schema';

initSchema();

const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 50;

const db = getDb();
const items = db.prepare(`
  SELECT id, title, body, source
  FROM work_items
  WHERE enriched_at IS NULL
  ORDER BY created_at DESC
  LIMIT ?
`).all(limit);

// Also output current goals for the agent to use in classification
const goals = db.prepare("SELECT id, name, description FROM goals WHERE status = 'active' ORDER BY sort_order").all();

console.log(JSON.stringify({ items, goals }, null, 2));
