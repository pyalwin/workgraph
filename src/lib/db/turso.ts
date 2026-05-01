/**
 * Phase 3 foundation — Turso (libSQL) adapter scaffolding.
 *
 * Self-host today: src/lib/db.ts uses better-sqlite3 (synchronous) against
 * a local file. Cloud uses Turso (libSQL, async) against a per-tenant URL.
 *
 * libSQL speaks the SQLite dialect — same Drizzle queries, same migrations,
 * same vector syntax. The async transition is the only mechanical refactor.
 *
 * This module is the cloud-side Drizzle factory. Wiring it into runtime
 * code is a follow-up PR (the async transition touches every callsite).
 *
 * Usage (when wired):
 *
 *     // Per-tenant DB resolution from middleware:
 *     const db = getTursoDrizzle(tenant.databaseUrl, tenant.authToken);
 *     const goals = await db.select().from(schema.goals).all();
 *
 * Detection:
 *
 *     if (process.env.DATABASE_URL?.startsWith('libsql://')) {
 *       // cloud mode — use Turso
 *     } else {
 *       // self-host — use better-sqlite3
 *     }
 */
import { createClient, type Client } from '@libsql/client';
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { schema } from './schema';

export type TursoDb = LibSQLDatabase<typeof schema>;

interface TursoCacheEntry {
  client: Client;
  db: TursoDb;
}

const cache = new Map<string, TursoCacheEntry>();

/**
 * Returns a cached Drizzle handle for a libSQL URL. Caching is keyed off
 * `${url}::${authToken}` so per-tenant connections (different authTokens
 * even for the same primary URL) don't collide.
 *
 * The libSQL HTTP client is fine to share across requests; it doesn't hold
 * a long-lived connection like a Postgres pool would. Reusing the same
 * Drizzle instance also avoids re-wrapping per-request.
 */
export function getTursoDrizzle(url: string, authToken?: string): TursoDb {
  const cacheKey = `${url}::${authToken ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached.db;

  const client = createClient({ url, authToken });
  const db = drizzleLibsql(client, { schema });
  cache.set(cacheKey, { client, db });
  return db;
}

/**
 * Resolves a libSQL URL from a single env var. Useful for cloud
 * deployments where DATABASE_URL is the canonical config.
 *
 * Self-host detection happens at the call site:
 *   - 'libsql://...'  → cloud, async, use this module
 *   - 'file:...'      → self-host, sync, use src/lib/db.ts
 *   - undefined       → self-host default
 */
export function isTursoUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return url.startsWith('libsql://') || url.startsWith('https://') || url.startsWith('http://');
}

export function _resetTursoCacheForTests() {
  cache.clear();
}
