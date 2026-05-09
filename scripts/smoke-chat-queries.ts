/**
 * Smoke test: exercise the project queries the chat tools depend on.
 * Run: bunx tsx scripts/smoke-chat-queries.ts
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: path.join(process.cwd(), '.env.local') });
loadEnv({ path: path.join(process.cwd(), '.env') });

import { getProjectSummaryCards, getProjectDetail } from '../src/lib/project-queries';

async function main() {
  console.log('--- getProjectSummaryCards("30d") ---');
  try {
    const cards = await getProjectSummaryCards('30d');
    console.log(`OK: ${cards.length} card(s)`);
    for (const c of cards.slice(0, 3)) {
      console.log(`  ${c.key}: ${c.name}  open=${c.open_count}  done=${c.completion_done}/${c.completion_total}`);
    }
    if (cards.length > 0) {
      const key = cards[0].key;
      console.log(`\n--- getProjectDetail("${key}", "30d") ---`);
      const detail = await getProjectDetail(key, '30d');
      console.log(`OK: tickets=${detail.tickets.length} health=${detail.health.status}`);
    }
  } catch (err) {
    console.error('THROW:', err);
    process.exit(1);
  }
}

main();
