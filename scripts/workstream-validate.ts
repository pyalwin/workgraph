/**
 * End-to-end validation after full enrichment:
 *   - re-run crossref across ALL items (uses fresh entity/topic tags from Haiku)
 *   - assemble workstreams from seeds + orphans
 *   - summarize 3 representative workstreams with Sonnet
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { getDb } from '../src/lib/db';
import { createLinksForAll } from '../src/lib/crossref';
import { assembleAll, listWorkstreams, getWorkstreamItems } from '../src/lib/workstream/assemble';
import { summarizeWorkstream } from '../src/lib/workstream/summary';

async function main() {
  const db = getDb();

  console.log('1) trace_role distribution:');
  console.table(db.prepare(`
    SELECT trace_role, COUNT(*) AS c FROM work_items GROUP BY trace_role ORDER BY c DESC
  `).all());

  console.log('\n2) Re-running full crossref (wipe + rebuild)…');
  db.exec('DELETE FROM item_links_chunks');
  db.exec('DELETE FROM links');
  const t0 = Date.now();
  const cr = await createLinksForAll({});
  console.log(`   ${cr.links} links across ${cr.items} items in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('\n3) Link distribution:');
  console.table(db.prepare(`
    SELECT link_type, COUNT(*) AS c, ROUND(AVG(confidence), 2) AS avg_conf
    FROM links GROUP BY link_type ORDER BY c DESC
  `).all());

  console.log('\n4) Assembling workstreams…');
  const r = await assembleAll();
  console.log(`   workstreams=${r.workstreams}, items-in-ws=${r.items}, seeds=${r.seeds}, orphans=${r.orphans}`);

  const all = await listWorkstreams();
  all.sort((a, b) => b.item_count - a.item_count);

  console.log('\n5) Workstream size distribution:');
  const sizeBuckets: Record<string, number> = { '1': 0, '2-5': 0, '6-15': 0, '16-50': 0, '51+': 0 };
  for (const ws of all) {
    const c = ws.item_count;
    if (c <= 1) sizeBuckets['1']++;
    else if (c <= 5) sizeBuckets['2-5']++;
    else if (c <= 15) sizeBuckets['6-15']++;
    else if (c <= 50) sizeBuckets['16-50']++;
    else sizeBuckets['51+']++;
  }
  console.table(sizeBuckets);

  const picks = all.filter(w => w.item_count >= 3 && w.item_count <= 12).slice(0, 3);
  if (picks.length === 0) {
    console.log('\n(no 3-12 item workstreams — skipping Sonnet summary demo)');
    return;
  }

  console.log(`\n6) Generating Sonnet summaries for ${picks.length} workstreams…`);
  for (const ws of picks) {
    const items = await getWorkstreamItems(ws.id);
    console.log(`\n━━━ workstream ${ws.id.slice(0, 8)} (${items.length} items, ${items[0].event_at?.slice(0, 10)} → ${items[items.length - 1].event_at?.slice(0, 10)}) ━━━`);
    for (const it of items) {
      const m = it.is_seed ? '★' : it.is_terminal ? '✓' : ' ';
      const role = (it.role_in_workstream ?? it.trace_role ?? '—').padEnd(14);
      const time = (it.event_at ?? it.trace_event_at ?? it.created_at).slice(0, 10);
      console.log(`   ${m} [${time}] ${role} ${it.source.padEnd(7)} ${it.title.slice(0, 80)}`);
    }
    const t = Date.now();
    const ok = await summarizeWorkstream(ws.id);
    if (!ok) { console.log('   (Sonnet failed)'); continue; }
    const row = db.prepare('SELECT narrative, timeline_events FROM workstreams WHERE id = ?').get(ws.id) as any;
    console.log(`\n   NARRATIVE (generated in ${((Date.now() - t) / 1000).toFixed(1)}s):\n   ${row.narrative.replace(/\n/g, '\n   ')}`);
  }
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
