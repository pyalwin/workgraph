# Turso Migration — Handover

> **Goal:** convert every `getDb()` (sync, `better-sqlite3`) call site to async
> `getLibsqlDb()` (libSQL) so the app can deploy on Vercel with `DATABASE_URL`
> pointed at a Turso `libsql://` URL. Local dev keeps working because libSQL's
> `file:` URLs hit the same SQLite file.

---

## Status — MIGRATION COMPLETE

**Build green** (`tsc --noEmit` + `next build` both pass).
**All `src/` is async.** Zero `getDb()` callers in `src/` outside legacy
`src/lib/schema.ts` and `src/lib/db.ts`, which only exist for the CLI scripts
in `scripts/` (deferred per handover; low priority).

### What was finished in the wrap-up session

- **Wave 5** project-queries.ts, project-summary.ts, crossref.ts internals,
  connectors/runner.ts internals, decision/extract.ts, decision/summary.ts.
- **Wave 4 finishers** sync/enrich-rich.ts, sync/extract-entities.ts,
  sync/project-{actions,okrs,readme}.ts, sync/issue-pr-summary.ts,
  sync/github-trails.ts.
- **Workstream** workstream/assemble.ts (+ orphanWorkstreams + assembleAll
  full async), workstream/summary.ts.
- **Wave 6 Inngest** anomalies.ts, github-trails.ts, heartbeat.ts (rewrote
  the drizzle write to libsql), jira-sync.ts (initSchema → ensureSchemaAsync),
  chunk-embed.ts.
- **All API routes** ~19 routes converted: items, projects, decisions,
  goals, graph, search, sync, orphan-prs, issue-trails, workstreams,
  workspaces/[id]/crossref, oauth/reset, config, etc.
- **Wave 7** `vec_chunks_text` (sqlite-vec) → `chunk_vectors` (libSQL native
  `BLOB` + `vector_distance_cos`). Three files migrated:
  `embeddings/embed.ts`, `chunking/index.ts`, `sync/unmatched-pr-matcher.ts`.
  `searchChunks` falls back to in-process cosine when `vector_distance_cos`
  isn't available (older libsql file mode in dev).
- **Wave 8** server pages (dashboard, metrics, projects) async; legacy
  schema.ts imports replaced with `ensureSchemaAsync` everywhere in `src/`.
- **Async DDL extended** to include `summary_generated_at`, `readme`,
  `readme_generated_at` on project_summaries; `action_item_id`,
  `jira_issue_key`, `handled_at`, `handled_note` on anomalies; new
  `chunk_vectors` table.
- **Sync caches preserved** for `getModel`/`getSettingCached` /
  `getProviderConfigCached` / `getWorkspaceConfigCached` patterns —
  `task-backend-store.ts` adopted the same pattern (`getTaskBackend` stays
  sync, refreshes from in-memory cache).

### What's still outstanding (intentionally deferred)

- **Scripts in `scripts/`** still import legacy `getDb` and `initSchema`.
  They're local CLI tools — they don't run on Vercel/Turso so the legacy
  better-sqlite3 path is fine for them. Migrate when convenient.
- **`src/lib/db.ts` and `src/lib/schema.ts`** stay alive ONLY because of
  the scripts above. Once scripts move, they can be deleted (Wave 8 final).
- **Vector quality on Turso depends on `vector_distance_cos`.** In dev's
  libsql file mode the function may not be present; the code falls back to
  loading all vectors and ranking in process (fine for <10k items, will
  need the SQL path on Turso for large workspaces).

---

## Foundation pieces (don't touch)

| File | Purpose |
|---|---|
| `src/lib/db/libsql.ts` | Async client. Returns a `prepare(sql).get/all/run` adapter that mimics better-sqlite3 so per-file diffs stay small. |
| `src/lib/db/init-schema-async.ts` | Full schema DDL ported. `ensureSchemaAsync()` is idempotent. Used by every migrated module on first call. |
| `scripts/init-db-async.ts` | One-shot for prod (Turso) bootstrap: `DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=… bun scripts/init-db-async.ts` |
| `src/lib/db.ts` | Legacy sync (`better-sqlite3`). Still alive — many unmigrated files import it. Retire in **Wave 8**. |
| `src/lib/schema.ts` | Legacy sync schema init. Still runs migrations not yet in async DDL. Retire in **Wave 8** after porting any remaining ALTER TABLE bits. |

---

## Conversion recipe

For every file with `getDb()`:

```ts
// BEFORE
import { getDb } from '../db';
import { initSchema } from '../schema';

export function loadX(id: string): X | null {
  initSchema();
  const db = getDb();
  const row = db.prepare('SELECT * FROM x WHERE id = ?').get(id) as X | undefined;
  return row ?? null;
}

// AFTER
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
}

export async function loadX(id: string): Promise<X | null> {
  await ensureInit();
  const db = getLibsqlDb();
  const row = await db.prepare('SELECT * FROM x WHERE id = ?').get<X>(id);
  return row ?? null;
}
```

**Key transformations:**
1. `import { getDb } from '../db'` → `import { getLibsqlDb } from '../db/libsql'`
2. `import { initSchema } from '../schema'` → `import { ensureSchemaAsync } from '../db/init-schema-async'`. Replace `initSchema()` call with `ensureInit()` (private wrapper that memoizes).
3. `function X(): T` → `async function X(): Promise<T>`
4. `getDb()` → `getLibsqlDb()`
5. `.run(...)`, `.get(...)`, `.all(...)` → all `await`ed
6. `.get(args) as Row | undefined` → `.get<Row>(args)` (returns `undefined` if no row)
7. `.all() as Row[]` → `.all<Row>()`

**Then update every consumer**: add `await` to every call into the migrated function. The TypeScript compiler will flag missing `await`s as `Property 'X' does not exist on type 'Promise<…>'` — chase those down.

---

## The cascade trick (sync cache)

Some sync getters are called from hot paths where converting all callers to
async would cascade through 15+ files (`getModel`, `normalizeLifecycleStage`,
`getEntityTypeConfig`). For these, **keep a sync getter that reads from an
in-memory cache** which gets populated on the first async lookup and refreshed
on every save. Already applied in:

| Module | Async API | Sync cached API |
|---|---|---|
| `app-settings.ts` | `getSetting` | `getSettingCached` |
| `ai/config-store.ts` | `getProviderConfig` | `getProviderConfigCached` |
| `workspace-config.ts` | `getWorkspaceConfig` | `getWorkspaceConfigCached` |

The first request after process boot may use defaults / null; subsequent
requests are correct. Acceptable trade-off because:
- Settings change rarely (UI save).
- The defaults are sensible.
- Cascading async through `getModel` would touch every AI call site (~15 files).

When migrating future files, prefer this pattern over forcing async in tight
loops or in functions that called sync today.

---

## Transaction handling

`db.transaction(() => { ... })` from `better-sqlite3` does NOT translate
directly to libSQL. Two options:

**(a) Sequential async** (what most migrated files use):
```ts
for (const item of items) {
  await db.prepare('...').run(...);
}
```
Each item is its own DB call. Loses atomicity across the loop, but the items
are typically independent (idempotent upserts), so this is fine.

**(b) `client.batch()`** for genuinely atomic groups of pre-computed statements:
```ts
const db = getLibsqlDb();
await db.raw.batch([
  { sql: 'DELETE FROM x WHERE y = ?', args: [yId] },
  { sql: 'INSERT INTO x (...) VALUES (?, ?)', args: [a, b] },
], 'deferred');
```

Don't try to use `client.transaction()` — its async semantics are different
and the existing code patterns don't translate cleanly.

---

## Files migrated (~70)

### Foundation
- `src/lib/db/libsql.ts`
- `src/lib/db/init-schema-async.ts`
- `scripts/init-db-async.ts`

### Wave 1 — settings / dismissals / agents / metering
- `src/lib/user-dismissals.ts`
- `src/lib/workspace-agents.ts`
- `src/lib/ai/usage-store.ts`
- `src/lib/app-settings.ts` (+ sync cache)
- `src/lib/ai/quota.ts`
- `src/lib/ai/metering-middleware.ts`
- `src/lib/ai/index.ts` (uses `getSettingCached`)
- API: `/api/user/dismissals`, `/api/user/agent-status`, `/api/user/quota`, `/api/ai/active-provider`

### Wave 2 — AI provider configs
- `src/lib/ai/config-store.ts` (+ sync cache)
- API: `/api/ai/providers`, `/api/ai/providers/[id]`
- `scripts/check-key.ts`

### Wave 3 — workspace + connectors + oauth
- `src/lib/oauth/state.ts`
- `src/lib/oauth/clients.ts`
- `src/lib/oauth/discovery.ts`
- `src/lib/oauth/refresh.ts`
- `src/lib/connectors/oauth-tokens.ts`
- `src/lib/connectors/config-store.ts`
- `src/lib/connectors/sync-runner.ts` (partial — markSync calls)
- `src/lib/connectors/runner.ts` (partial — ingest calls only; **internal DB calls still sync**)
- `src/lib/connectors/mcp-client.ts` (partial)
- `src/lib/workspace-config.ts` (+ sync cache)
- API: `/api/oauth/{start,callback,probe}`, all `/api/workspaces/*` and `/api/workspaces/[id]/connectors/*`, `/api/anomalies/[id]/jira-ticket`, `/api/config`

### Wave 4 — sync pipeline (partial)
- `src/lib/sync/log.ts`
- `src/lib/sync/versioning.ts`
- `src/lib/sync/ingest.ts`
- `src/lib/sync/identity.ts`
- `src/lib/sync/recap.ts`
- `src/lib/sync/cleanup.ts`
- `src/lib/sync/orphan-pr-enrich.ts`
- `src/lib/sync/enrich.ts` (full)
- `src/lib/sync/enrich-rich.ts` (**partial — only workspace-config use; internal DB still sync**)
- `src/lib/sync/extract-entities.ts` (**partial**)
- `src/lib/sync/github-trails.ts` (**partial — markSync only**)
- API: `/api/sync/route.ts`, `/api/sync/ingest/route.ts`

### Wave 5 — graph + chat (partial)
- `src/lib/classify.ts`
- `src/lib/custom-tables.ts`
- `src/lib/metrics.ts`
- `src/lib/chat-threads.ts`
- `src/lib/anomaly-actions.ts`
- `src/lib/workstream/summary.ts` (workspace-config only)
- `src/lib/workstream/assemble.ts` (**partial — workspace-config only; internal DB still sync**)
- `src/lib/decision/summary.ts` (workspace-config only)
- `src/lib/crossref.ts` (**partial — workspace-config only; internal DB still sync**)
- API: `/api/chat/*`, `/api/anomalies/[id]/{action-item,dismiss,jira-ticket}`

### Wave 6 — Inngest (partial)
- `src/inngest/functions/jira-sync.ts`

### Server components
- `src/app/(app)/dashboard/tracker.tsx`

---

## Files still on sync `getDb()` (~30)

### Wave 4 leftover — sync pipeline internals
| File | Lines | Notes |
|---|---|---|
| `src/lib/sync/enrich-rich.ts` | 317 | Big enrichment pipeline; lots of upserts |
| `src/lib/sync/extract-entities.ts` | 367 | Entity NER + linking |
| `src/lib/sync/project-actions.ts` | 232 | Action-item synthesis |
| `src/lib/sync/project-okrs.ts` | 362 | OKR derivation from README |
| `src/lib/sync/project-readme.ts` | 408 | README generation |
| `src/lib/sync/issue-pr-summary.ts` | 455 | Per-ticket fulfillment narrative |
| `src/lib/sync/github-trails.ts` | 835 | PR trails ingest (mostly internal SELECTs/INSERTs) |
| `src/lib/sync/unmatched-pr-matcher.ts` | 316 | **Wave 7 — uses sqlite-vec** |

### Wave 5 leftover
| File | Lines | Notes |
|---|---|---|
| `src/lib/project-queries.ts` | 617 | Big query module — all reads, used by /api/projects/* |
| `src/lib/project-summary.ts` | 262 | Summary generation |
| `src/lib/decision/extract.ts` | 229 | Decision detection |
| `src/lib/workstream/assemble.ts` | 309 (DB internals) | BFS the link graph |
| `src/lib/crossref.ts` | (DB internals) | Multi-signal item linking |
| `src/lib/connectors/runner.ts` | 347 (DB internals) | Connector orchestrator |

### Wave 6 leftover — Inngest functions
- `src/inngest/functions/anomalies.ts`
- `src/inngest/functions/github-trails.ts`
- `src/inngest/functions/chunk-embed.ts` (**Wave 7 — uses sqlite-vec**)
- `src/inngest/functions/connector-sync.ts`
- `src/inngest/functions/heartbeat.ts`
- `src/inngest/functions/project-actions.ts`
- `src/inngest/functions/project-okrs.ts`
- `src/inngest/functions/project-readme.ts`
- `src/inngest/functions/project-summary.ts`

### Wave 7 — sqlite-vec → libSQL native vectors (3 files, **hardest**)
| File | Why hard |
|---|---|
| `src/lib/chunking/index.ts` | Writes embeddings to `vec_chunks_text` virtual table (sqlite-vec syntax) |
| `src/lib/embeddings/embed.ts` | Same — writes vectors |
| `src/lib/sync/unmatched-pr-matcher.ts` | Queries `vec_chunks_text` with sqlite-vec's `MATCH` syntax |

**Turso doesn't support sqlite-vec.** It has its own native vector functions:
- Storage: `F32_BLOB(<dim>)` column type, NOT `vec0` virtual table
- Insert: `vector('[0.1, 0.2, ...]')` literal
- Query: `vector_distance_cos(col, vector('[…]'))` ORDER BY ASC LIMIT K

Migration approach for vec layer:
1. Replace `CREATE VIRTUAL TABLE vec_chunks_text USING vec0(...)` with a normal
   table: `CREATE TABLE chunk_vectors (chunk_id INTEGER PRIMARY KEY, embedding F32_BLOB(768))`.
2. Inserts become `INSERT INTO chunk_vectors VALUES (?, vector('[...]'))`.
3. `MATCH` queries become `ORDER BY vector_distance_cos(embedding, vector('[query]')) LIMIT K`.
4. Both dev (file URL) and Turso libsql support this syntax — works in both modes.

Best done as a focused session: rewrite the schema for vec_chunks, write the
queries, run a backfill that re-embeds existing chunks into the new table.

### Wave 8 — server pages + cleanup
- `src/app/(app)/dashboard/page.tsx`
- `src/app/(app)/metrics/page.tsx`
- Retire `src/lib/db.ts` (delete after all callers gone)
- Retire `src/lib/schema.ts` (delete after all `initSchema()` callers gone)

### API routes still on sync getDb (~12)
- `/api/items/route.ts`, `/api/items/[id]/route.ts`, `/api/items/[id]/refresh-trail-summary/route.ts`
- `/api/projects/[key]/route.ts`, `/api/projects/[key]/refresh-{trails,okrs,readme,summary}/route.ts`, `/api/projects/index/route.ts`
- `/api/decisions/route.ts`, `/api/decisions/[id]/route.ts`
- `/api/goals/route.ts`, `/api/goals/[id]/items/route.ts`
- `/api/issue-trails/by-pr-ref/[ref]/{attach,dismiss-candidates}/route.ts`
- `/api/items/route.ts`
- `/api/graph/route.ts`
- `/api/search/route.ts`
- `/api/orphan-prs/route.ts`
- `/api/workstreams/route.ts`, `/api/workstreams/[id]/route.ts`
- `/api/workspaces/[id]/crossref/route.ts`
- `/api/oauth/reset/route.ts`
- `/api/admin/*`
- `/api/mcp/route.ts`
- `/api/config/goals/route.ts`

### Scripts (low priority — local CLI tools)
- All `scripts/sync-*.ts` files
- `scripts/{assemble-reingest,chunk-embed-validate,crossref-validate,decision-validate,enrich-validate,enrich,extract-*,ingest-*,list-unenriched,orphan-diag,rerun-pipeline-post-weights,slack-parse-pages,smoke-*,store-enrichment,workstream-validate,ws-resummarize}.ts`

---

## Recommended order for next session

1. **Wave 5 finishers first** — `project-queries.ts` is heavy fan-in; lots of API routes block on it. Convert it, then convert the API routes that consume it (`/api/projects/*`).
2. **Wave 4 finishers** — `enrich-rich.ts`, `extract-entities.ts` internals, then the project-* sync files.
3. **`crossref.ts` and `connectors/runner.ts`** — internal DB calls. Both are fan-in points.
4. **Wave 6** — Inngest functions. Each calls into already-migrated lib modules + a few sync DB reads. Mostly mechanical now.
5. **API route cleanup** — pure await additions; bulk-grindable once the lib calls are async.
6. **Wave 7 (sqlite-vec)** — separate focused session. Schema migration + vector function rewrite.
7. **Wave 8** — delete `src/lib/db.ts`, delete `src/lib/schema.ts`, port server pages.

The grep that finds remaining work:
```bash
grep -rln "getDb()\|from '@/lib/db'\|from '../db'\|from './db'" src/ | grep -v db/libsql | grep -v 'src/lib/db.ts'
```

---

## Known gotchas

1. **Path mismatch** (already fixed): legacy hardcodes `<cwd>/../workgraph.db`; libsql defaults to the same in dev.
2. **`lastInsertRowid` is `bigint | number | null`** in libsql, not just `number`. Type carefully if you need it.
3. **`.exec()` splits on `;`** in the adapter — fine for our DDL but watch for `;` inside string literals (none today).
4. **No `db.transaction()`** — see "Transaction handling" above.
5. **`LanguageModelV3Usage` shape is nested** in `@ai-sdk/provider` v3 (`usage.inputTokens.total`, not `usage.inputTokens`). Already handled in `metering-middleware.ts` via `flattenUsage()`.
6. **Inngest `step.run` callbacks must return JSON-serializable** — bigints from libsql will fail. Cast to Number before returning.
7. **Vercel will set `DATABASE_URL`** at deploy time — locally we leave it unset and fall back to the legacy file path.
8. **Schema migrations**: `src/lib/schema.ts` runs ALTER TABLE migrations not yet in `init-schema-async.ts`. As you migrate, port any new ALTER bits into the async file. Today the async DDL has the column shape post-migrations baked in.
9. **Turso doesn't support `sqlite-vec`** — see Wave 7. The `vec_chunks_text` virtual table CREATE in `src/lib/schema.ts:721-728` is local-only; the async DDL skips it intentionally. Vector ops will 500 on Turso prod until Wave 7 is done.
10. **`getActiveProviderId()` stays sync** via cache — don't accidentally make it async; it's called inside `getModel()` which is called sync in 15+ places.

---

## How to verify migration so far

Once dev server is restarted (so the libsql client picks up any path changes):

```bash
# Build green
npx next build

# Type check
npx tsc --noEmit

# Hit migrated surfaces in browser
# - Settings → AI panel (loads providers, dismisses banner)
# - /api/workspaces (already verified — was the path bug)
# - Connect a connector via OAuth
# - Trigger a sync via Settings → Connectors → Sync
# - Open chat → send a message → check it persists
# - Dashboard tracker section
```

Things that **will** break until further waves:
- `/api/projects/*` (uses unmigrated `project-queries`)
- `/api/items/*`
- `/api/decisions/*`
- `/api/graph`, `/api/search`
- `/metrics`, `/dashboard` (full pages — only tracker section migrated)
- Any sync run that hits enrich-rich/extract-entities/project-* internals
- Any vector search (chunking, embeddings, unmatched PR matcher)

---

## Env vars for Vercel deploy (when migration completes)

```
WORKOS_API_KEY=
WORKOS_CLIENT_ID=
WORKOS_COOKIE_PASSWORD=     # 32+ random bytes
NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://<domain>/auth/callback
WORKGRAPH_SECRET_KEY=        # 32-byte hex from bun scripts/gen-secret.ts
OAUTH_REDIRECT_BASE_URL=https://<domain>

DATABASE_URL=libsql://<db>.turso.io
TURSO_AUTH_TOKEN=

AI_GATEWAY_API_KEY=          # vck_... from Vercel AI Gateway (operator default for free tier)

INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=

# Optional caps (defaults in src/lib/ai/quota.ts):
# WORKGRAPH_FREE_LIMIT_USD_MICROS=1000000   # $1/mo per workspace
# WORKGRAPH_FREE_LIMIT_TOTAL=1000           # secondary call-count cap
```

**Do NOT set** `INNGEST_DEV` in prod (it bypasses signature verification).

WorkOS dashboard: add prod redirect URI to AuthKit app.
Inngest Cloud: create app, point at `https://<domain>/api/inngest`, copy keys.
Turso: `turso db create workgraph`, `turso db tokens create workgraph` for the auth token. Run schema bootstrap once: `DATABASE_URL=… TURSO_AUTH_TOKEN=… bun scripts/init-db-async.ts`.

---

## Quick-pick remaining files by impact

If next session has 2 hours:

1. `project-queries.ts` (617 lines, blocks /api/projects)
2. `project-summary.ts` (262)
3. `crossref.ts` internals (used by sync flows)
4. `connectors/runner.ts` internals (used by every connector sync)
5. `decision/extract.ts` (229)

If next session has 4 hours:

Above + Wave 4 finishers (project-actions/okrs/readme, enrich-rich/extract-entities full conversion, github-trails internals, issue-pr-summary).

If next session has a full day:

All of the above + Wave 6 (Inngest functions) + Wave 8 (server pages + retire legacy db.ts/schema.ts).

Wave 7 (sqlite-vec) deserves its own session. ~3-4 hours of focused work to:
- Design the new chunk_vectors table
- Port chunking/embeddings writes
- Port unmatched-pr-matcher reads
- Backfill existing data
- Verify search quality regression-free

---

## File layout map

```
src/lib/
├── db.ts                           # legacy sync — RETIRE in Wave 8
├── schema.ts                       # legacy sync init — RETIRE in Wave 8
├── db/
│   ├── libsql.ts                   # async client + adapter (FOUNDATION)
│   ├── init-schema-async.ts        # async DDL (FOUNDATION)
│   ├── client.ts                   # legacy drizzle wrapper
│   ├── schema.ts                   # legacy drizzle types
│   └── turso.ts                    # superseded by libsql.ts
├── app-settings.ts                 # ✓ async + sync cache
├── user-dismissals.ts              # ✓ async
├── workspace-agents.ts             # ✓ async
├── workspace-config.ts             # ✓ async + sync cache
├── crossref.ts                     # ⚠ partial (workspace-config only)
├── classify.ts                     # ✓ async
├── metrics.ts                      # ✓ async
├── custom-tables.ts                # ✓ async
├── chat-threads.ts                 # ✓ async
├── anomaly-actions.ts              # ✓ async
├── project-queries.ts              # ✗ TODO
├── project-summary.ts              # ✗ TODO
├── ai/
│   ├── index.ts                    # ✓ uses sync caches; getModel stays sync
│   ├── config-store.ts             # ✓ async + sync cache
│   ├── usage-store.ts              # ✓ async
│   ├── quota.ts                    # ✓ async
│   ├── metering-middleware.ts      # ✓ async
│   └── runner.ts                   # ✓ unchanged
├── oauth/
│   ├── state.ts                    # ✓ async
│   ├── clients.ts                  # ✓ async
│   ├── discovery.ts                # ✓ async
│   ├── refresh.ts                  # ✓ async
│   └── providers.ts                # (no DB)
├── connectors/
│   ├── oauth-tokens.ts             # ✓ async
│   ├── config-store.ts             # ✓ async
│   ├── sync-runner.ts              # ✓ async
│   ├── runner.ts                   # ⚠ partial (only ingest calls)
│   ├── mcp-client.ts               # ⚠ partial
│   └── ...
├── sync/
│   ├── log.ts                      # ✓ async
│   ├── versioning.ts               # ✓ async
│   ├── ingest.ts                   # ✓ async
│   ├── identity.ts                 # ✓ async
│   ├── recap.ts                    # ✓ async
│   ├── cleanup.ts                  # ✓ async
│   ├── orphan-pr-enrich.ts         # ✓ async
│   ├── enrich.ts                   # ✓ async (full)
│   ├── enrich-rich.ts              # ⚠ partial — internals still sync
│   ├── extract-entities.ts         # ⚠ partial
│   ├── github-trails.ts            # ⚠ partial — markSync only
│   ├── project-actions.ts          # ✗ TODO
│   ├── project-okrs.ts             # ✗ TODO
│   ├── project-readme.ts           # ✗ TODO
│   ├── issue-pr-summary.ts         # ✗ TODO
│   └── unmatched-pr-matcher.ts     # ✗ TODO (Wave 7 — sqlite-vec)
├── decision/
│   ├── summary.ts                  # ✓ async
│   └── extract.ts                  # ✗ TODO
├── workstream/
│   ├── summary.ts                  # ✓ async
│   └── assemble.ts                 # ⚠ partial — internals still sync
├── chunking/
│   └── index.ts                    # ✗ TODO (Wave 7 — sqlite-vec)
└── embeddings/
    └── embed.ts                    # ✗ TODO (Wave 7 — sqlite-vec)
```

---

End of handover. Pick up anywhere — the foundation is rock-solid and the
recipe is mechanical. Just resist the urge to skip `await`s.
