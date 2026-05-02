/**
 * Async libSQL client — single interface for both modes.
 *
 *   - dev / self-host (file URL):  DATABASE_URL=file:./data/workgraph.db
 *   - cloud (Turso):               DATABASE_URL=libsql://<db>.turso.io  + TURSO_AUTH_TOKEN
 *   - default fallback:            file:./data/workgraph.db
 *
 * This sits alongside the legacy sync `src/lib/db.ts` (better-sqlite3) during
 * the migration. New code uses `getLibsqlDb()`; existing sync callers still
 * work against the same file in dev (SQLite WAL allows concurrent readers/
 * writers across processes/handles). On Vercel/Turso, sync callers will
 * fail — they need to be migrated to async before deploy.
 *
 * The PreparedAdapter mimics better-sqlite3's `prepare().get/all/run` shape
 * so migrating a file is mostly: replace `getDb()` with `await getLibsqlDb()`
 * and add `await` to result calls. The query strings don't need to change.
 */

import { createClient, type Client, type InValue, type Row } from '@libsql/client';
import path from 'path';

type PositionalArgs = InValue[];

let _client: Client | null = null;

function resolveUrl(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (raw) return raw;
  // Local default — match the path used by the legacy sync src/lib/db.ts so
  // both interfaces talk to the same SQLite file during the migration. The
  // path is `<cwd>/../workgraph.db`, which is the file containing every
  // existing dev install's data. On Vercel/Turso, DATABASE_URL is set
  // explicitly to a libsql:// URL and this branch is never taken.
  const legacyPath = path.join(process.cwd(), '..', 'workgraph.db');
  return `file:${legacyPath}`;
}

function resolveAuthToken(): string | undefined {
  return process.env.TURSO_AUTH_TOKEN?.trim() || undefined;
}

export function isCloudUrl(url: string): boolean {
  return /^libsql:\/\//.test(url) || /^https?:\/\//.test(url);
}

function getRawClient(): Client {
  if (_client) return _client;
  const url = resolveUrl();
  const cloud = isCloudUrl(url);
  _client = createClient({
    url,
    authToken: cloud ? resolveAuthToken() : undefined,
  });
  return _client;
}

/** Adapter that gives libSQL a better-sqlite3-shaped prepare() API. */
export interface PreparedAdapter {
  get<T = Row>(...args: PositionalArgs): Promise<T | undefined>;
  all<T = Row>(...args: PositionalArgs): Promise<T[]>;
  run(...args: PositionalArgs): Promise<{ changes: number; lastInsertRowid: bigint | number | null }>;
}

export interface LibsqlDb {
  /** Raw client for advanced use (transactions, batches, named-arg statements). */
  raw: Client;
  prepare(sql: string): PreparedAdapter;
  /** Multi-statement DDL — splits on `;` boundaries and runs as a batch. */
  exec(sql: string): Promise<void>;
}

function makePrepared(client: Client, sql: string): PreparedAdapter {
  return {
    async get<T = Row>(...args: PositionalArgs): Promise<T | undefined> {
      const result = await client.execute({ sql, args });
      return (result.rows[0] as unknown as T) ?? undefined;
    },
    async all<T = Row>(...args: PositionalArgs): Promise<T[]> {
      const result = await client.execute({ sql, args });
      return result.rows as unknown as T[];
    },
    async run(...args: PositionalArgs) {
      const result = await client.execute({ sql, args });
      return {
        changes: Number(result.rowsAffected ?? 0),
        lastInsertRowid: result.lastInsertRowid ?? null,
      };
    },
  };
}

/**
 * Splits a multi-statement DDL block into individual statements so we can
 * batch them. Strips `-- ...` line comments first: leading comment lines
 * would otherwise cause whole CREATE statements to be filtered as comments,
 * and a `;` inside a comment would fragment the real statement that follows.
 * Still naive about `;` inside string literals — our schema doesn't have any.
 */
function splitStatements(sql: string): string[] {
  const stripped = sql.replace(/--[^\n]*/g, '');
  return stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function getLibsqlDb(): LibsqlDb {
  const client = getRawClient();
  return {
    raw: client,
    prepare(sql: string) {
      return makePrepared(client, sql);
    },
    async exec(sql: string) {
      const stmts = splitStatements(sql);
      if (stmts.length === 0) return;
      // Use batch for atomicity; falls back to sequential on virtual-table
      // cases that batch doesn't accept (sqlite-vec). Caller can use raw
      // client directly for those.
      try {
        await client.batch(stmts, 'deferred');
      } catch (err) {
        // Some DDL (CREATE VIRTUAL TABLE on sqlite-vec) requires execute()
        // not batch(). Fall back to sequential.
        for (const stmt of stmts) {
          await client.execute(stmt);
        }
      }
    },
  };
}

/** Test/cleanup helper — drops the cached connection. */
export function _resetLibsqlForTests() {
  _client = null;
}
