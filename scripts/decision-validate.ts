import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { getDb } from '../src/lib/db';
import { extractDecisions, listDecisions, getDecisionItems } from '../src/lib/decision/extract';
import { summarizeAllDecisions } from '../src/lib/decision/summary';
import { summarizeAllWorkstreams } from '../src/lib/workstream/summary';

async function main() {
  console.log('1) Extracting decisions...');
  const ex = await extractDecisions();
  console.log(`   decisions=${ex.decisions}, relations=${ex.relations}`);

  const all = await listDecisions();
  console.log('\n2) Decision records:');
  for (const d of all) {
    console.log(`   [${d.decided_at.slice(0, 10)}] ${d.status.padEnd(12)} (${d.item_count} items) "${d.title.slice(0, 70)}"`);
  }

  console.log('\n3) Re-summarizing large workstreams with new chunking...');
  const wsRes = await summarizeAllWorkstreams({ force: true, minItems: 2, concurrency: 2 });
  console.log(`   generated=${wsRes.generated}, skipped=${wsRes.skipped}, failed=${wsRes.failed}`);

  console.log('\n4) Generating structured decision summaries...');
  const dsRes = await summarizeAllDecisions({ concurrency: 2 });
  console.log(`   generated=${dsRes.generated}, skipped=${dsRes.skipped}, failed=${dsRes.failed}`);

  const db = getDb();
  const sampleId = all[0]?.id;
  if (!sampleId) return;
  const row = db.prepare('SELECT title, summary FROM decisions WHERE id = ?').get(sampleId) as any;
  if (!row?.summary) {
    console.log('\n(No summary generated for sample decision)');
    return;
  }
  const parsed = JSON.parse(row.summary);
  console.log(`\n--- SAMPLE: "${row.title}" ---`);
  console.log(`\nContext:    ${parsed.context}`);
  console.log(`\nDecision:   ${parsed.decision}`);
  console.log(`\nRationale:  ${parsed.rationale}`);
  console.log(`\nOutcome:    ${parsed.outcome}`);
  console.log(`\nStatus:     ${parsed.status_note}`);
  console.log(`\nTrace (${parsed.traceability.length} items):`);
  for (const t of parsed.traceability) {
    console.log(`   [${t.time}] ${t.role.padEnd(14)} ${t.source.padEnd(7)} ${t.title.slice(0, 55)}`);
    console.log(`      → ${t.contribution.slice(0, 110)}`);
  }
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
