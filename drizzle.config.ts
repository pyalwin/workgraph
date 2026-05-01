import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * Phase 0: only used for `drizzle-kit introspect` / `drizzle-kit check`.
 * Schema CREATE / ALTER is still managed by src/lib/schema.ts:initSchema().
 *
 * Future phases will move migrations into `drizzle/` (auto-generated SQL
 * files) and replace `initSchema()` with `drizzle-kit migrate`.
 */
export default {
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'file:./data/workgraph.db',
  },
  strict: true,
  verbose: true,
} satisfies Config;
