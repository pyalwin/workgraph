/**
 * Drizzle client — typed query interface over the existing SQLite connection.
 *
 * Phase 0: wraps the same `better-sqlite3` Database instance that
 * `src/lib/db.ts` exposes via `getDb()`. Both APIs coexist:
 *   - Legacy code keeps using `getDb()` (raw better-sqlite3, sync).
 *   - New code uses `getDrizzle()` (typed, sync).
 *
 * Phase 3 (cloud) will swap the underlying driver to `@libsql/client`
 * (async) for Turso. At that point Drizzle queries everywhere become
 * `await`ed in one mechanical refactor; the legacy `getDb()` is retired.
 */
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getDb } from '../db';
import { schema } from './schema';

let cached: BetterSQLite3Database<typeof schema> | null = null;

export function getDrizzle(): BetterSQLite3Database<typeof schema> {
  if (cached) return cached;
  cached = drizzle(getDb(), { schema });
  return cached;
}

// Resets the cached Drizzle instance — useful for tests after the underlying
// `better-sqlite3` connection has been closed/reopened.
export function _resetDrizzleCache() {
  cached = null;
}

export { schema };
