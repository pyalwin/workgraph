/**
 * Validate 3-dim enrichment: pick one item per source, re-enrich, inspect.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { getDb } from '../src/lib/db';
import { enrichItem } from '../src/lib/sync/enrich';

async function main() {
  const db = getDb();

  const sources = ['notion', 'jira', 'slack', 'github'];
  const items = sources.flatMap(src =>
    db.prepare(`SELECT id, source, item_type, title FROM work_items WHERE source = ? ORDER BY created_at DESC LIMIT 1`).all(src) as any[]
  );

  if (items.length === 0) {
    console.log('No items found');
    return;
  }

  // Build system prompt inline
  const { buildSystemPrompt } = await import('../src/lib/sync/enrich').then(m => ({ buildSystemPrompt: (m as any).buildSystemPrompt ?? null }));

  // Build via internal call — just re-call enrichItem with a fresh prompt
  const sys = (await import('../src/lib/sync/enrich')) as any;
  const prompt = (sys as any).buildSystemPrompt?.() ?? null;

  if (!prompt) {
    // buildSystemPrompt is not exported; use enrichAll on this narrow subset via force
    console.log('(re-enriching via enrichItem with manually-built prompt snapshot)');
  }

  // Use enrichItem directly; it needs a system prompt. We'll build one by calling the
  // (unexported) function via a hack: re-run enrichAll with force but limit to our ids.
  const { enrichAll } = await import('../src/lib/sync/enrich');
  // Temporarily mark these items as un-enriched so enrichAll picks them (force path works too)
  const ids = items.map(i => i.id);
  const placeholders = ids.map(() => '?').join(',');
  const restore = db
    .prepare(`SELECT id, enriched_at, trace_role, substance FROM work_items WHERE id IN (${placeholders})`)
    .all(...ids);

  db.prepare(`UPDATE work_items SET enriched_at = NULL WHERE id IN (${placeholders})`).run(...ids);

  const r = await enrichAll({ limit: items.length, concurrency: 4 });
  console.log('\nEnrichment result:', r);

  console.log('\nInspecting updated items:');
  for (const i of items) {
    const updated = db.prepare(`
      SELECT source, item_type, title, trace_role, substance, trace_event_at, summary
      FROM work_items WHERE id = ?
    `).get(i.id) as any;
    const topics = db.prepare(`
      SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
      WHERE it.item_id = ? AND t.category = 'topic'
    `).all(i.id) as { name: string }[];
    const entities = db.prepare(`
      SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
      WHERE it.item_id = ? AND t.category = 'entity'
    `).all(i.id) as { name: string }[];
    console.log(`\n  ${updated.source} / ${updated.item_type}: "${(updated.title || '').slice(0, 60)}"`);
    console.log(`    trace_role:     ${updated.trace_role}`);
    console.log(`    substance:      ${updated.substance}`);
    console.log(`    trace_event_at: ${updated.trace_event_at}`);
    console.log(`    summary:        ${(updated.summary || '').slice(0, 100)}`);
    console.log(`    topics:         ${topics.map(t => t.name).join(', ') || '-'}`);
    console.log(`    entities:       ${entities.map(t => t.name).slice(0, 5).join(', ') || '-'}`);
  }
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
