/**
 * Smoke test for the Drizzle wrapper.
 *
 * Verifies:
 *   - getDrizzle() opens the same SQLite file as getDb()
 *   - A typed select against goals + work_items returns rows
 *   - Counts match between raw better-sqlite3 and Drizzle
 *
 * Run with:  bun scripts/smoke-db-drizzle.ts
 */
import { count } from 'drizzle-orm';
import { getDb } from '../src/lib/db';
import { initSchema } from '../src/lib/schema';
import { getDrizzle } from '../src/lib/db/client';
import { goals, workItems, links } from '../src/lib/db/schema';

function main() {
  initSchema();

  const raw = getDb();
  const db = getDrizzle();

  console.log('— Drizzle smoke test —\n');

  // Raw counts (legacy path)
  const rawGoals = (raw.prepare('SELECT COUNT(*) as c FROM goals').get() as { c: number }).c;
  const rawItems = (raw.prepare('SELECT COUNT(*) as c FROM work_items').get() as { c: number }).c;
  const rawLinks = (raw.prepare('SELECT COUNT(*) as c FROM links').get() as { c: number }).c;

  // Drizzle counts (new path)
  const [{ c: drzGoals }] = db.select({ c: count() }).from(goals).all();
  const [{ c: drzItems }] = db.select({ c: count() }).from(workItems).all();
  const [{ c: drzLinks }] = db.select({ c: count() }).from(links).all();

  console.log(`goals       raw=${rawGoals}\tdrizzle=${drzGoals}\t${rawGoals === drzGoals ? 'OK' : 'MISMATCH'}`);
  console.log(`work_items  raw=${rawItems}\tdrizzle=${drzItems}\t${rawItems === drzItems ? 'OK' : 'MISMATCH'}`);
  console.log(`links       raw=${rawLinks}\tdrizzle=${drzLinks}\t${rawLinks === drzLinks ? 'OK' : 'MISMATCH'}`);

  // Sample row through the typed API
  const firstGoal = db.select().from(goals).limit(1).all();
  if (firstGoal.length > 0) {
    console.log(`\nfirst goal: ${firstGoal[0]!.id} — ${firstGoal[0]!.name}`);
  } else {
    console.log('\n(no goals yet)');
  }

  const ok = rawGoals === drzGoals && rawItems === drzItems && rawLinks === drzLinks;
  if (!ok) process.exit(1);
  console.log('\nAll checks passed.');
}

main();
