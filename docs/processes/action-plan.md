# Implementation Action Plan

> What we're building, in what order, with what dependencies. Updated as
> milestones land. Each phase ends with a concrete deliverable that can be
> shipped on its own — no waterfall, no big-bang.

## Decisions to make before we start coding

These can be made in 30 minutes and unblock the rest. Decide once, write down, move on.

| Decision | Default | Notes |
|---|---|---|
| **ORM** | Drizzle | Works for SQLite + libSQL/Turso with the same schema. Migrations as TS files. Type-safe. |
| **Migrations runner** | `drizzle-kit` | Generates SQL, applies on boot for self-host. For cloud, runs against each tenant DB on provisioning. |
| **Background runtime** | Inngest | Free tier covers MVP. Sign-up needed (one-time). |
| **Cloud DB provider** | Turso | Sign-up needed before Phase 3. Free tier covers waitlist period. |
| **Billing for cloud** | Stripe | Phase 3 only. Defer concrete plan until we have signups. |
| **Branch strategy** | Trunk + feature branches | Each phase = a branch, squash-merge to `main`. |

---

## Phase 0 — Foundation (week 1–2)

**Goal:** Drizzle in, one DB adapter, Inngest hello-world. Nothing user-facing changes yet.

| # | Deliverable | Touches | Notes |
|---|---|---|---|
| 0.1 | Add Drizzle, port the existing schema to a `schema.ts` Drizzle module | `src/lib/db/`, all `getDb()` callsites | Start with the existing SQLite shape — no new tables yet. Behavior must match exactly. |
| 0.2 | Replace raw `better-sqlite3` calls with Drizzle queries everywhere | `src/lib/sync/`, `crossref.ts`, `metrics.ts`, all API routes | Mechanical refactor. Tests if any exist. |
| 0.3 | DB adapter abstraction — `getDb()` opens SQLite (`file:./data/workgraph.db`) or libSQL (`libsql://…`) based on `DATABASE_URL` | `src/lib/db/index.ts` | One env var. Same Drizzle interface above the adapter. |
| 0.4 | Inngest sign-up + `/api/inngest` route handler | `src/app/api/inngest/route.ts`, `src/lib/inngest/` | First function is a no-op `inngest/jira.sync.tick` that just logs. Confirms the loop works locally + on Vercel. |
| 0.5 | One scheduled function as proof: `inngest/heartbeat` that writes a row to a new `system_health` table every 5 minutes | `src/lib/inngest/heartbeat.ts` | Just to verify Inngest is doing its job. |

**Exit criteria:** `bun dev` works exactly like before. `inngest dev` shows the heartbeat firing. We can flip `DATABASE_URL` to a Turso URL and the app boots against it (no data; just verify connection).

---

## Phase 1 — JIRA pipeline v1 (week 3–5)

**Goal:** Replace the current ad-hoc sync with a scheduled, per-project pipeline producing graph-quality nodes.

| # | Deliverable | Touches | Notes |
|---|---|---|---|
| 1.1 | Schedule per-project sync via Inngest | `src/lib/inngest/jira.ts` | One Inngest function fans out to N tickets per project. Cadence: every 30m incremental, daily 06:00 re-enrich changed. |
| 1.2 | Add `metadata.entity_key`, `period.{year,month,day}`, `is_mine`, `assigned_to_me` to issue ingestion | `connectors/adapters/atlassian.ts` | Computed on insert. No schema change — they live in the JSON `metadata` blob. |
| 1.3 | Fix the comments-not-chunked bug (chunker reads `metadata.comments`, ingestion doesn't write it) | `connectors/adapters/atlassian.ts`, `chunking/jira.ts` | Confirmed in our walkthrough — comments end up in `body` but never become per-comment chunks. |
| 1.4 | New AI enrichment prompt: returns summary + characteristic entities + action items + anomaly signals | `src/lib/sync/enrich.ts` | Single Sonnet call per issue, using `generateObject` with a Zod schema (we already use this in `extract-entities.ts`). |
| 1.5 | Persist new entity types (`theme`, `capability`, `system`, `decision`, `risk`, `effort_signal`) to existing `entities` + `entity_mentions` tables | extends Phase 0.1 schema | No new tables — existing tables already have a `type` column. |
| 1.6 | Settings → Connectors → Jira UI: project multi-select with per-project cadence | `src/components/connector-detail-panel.tsx` | The picker exists; need to add cadence + user-scope choices. |

**Exit criteria:** A user picks 2 Jira projects in Settings, runs first sync. 30 minutes later the second sync runs automatically. Issues appear with summaries, themes, action items extracted, anomalies flagged.

---

## Phase 2 — Action items, goals, anomalies (week 6–7)

**Goal:** Surface the AI-extracted artifacts in the UI. Per-user tracker on `/dashboard`.

| # | Deliverable | Touches | Notes |
|---|---|---|---|
| 2.1 | `action_items` table + Drizzle migration | `src/lib/db/schema.ts` | Schema in [`jira-tracker.md`](./jira-tracker.md) Phase 5. |
| 2.2 | Extend `goals` table with `owner_user_id`, `target_metric`, `target_value`, `target_at`, `ai_confidence`, `derived_from` | migration | Same doc, Phase 6. |
| 2.3 | `anomalies` table + weekly Inngest function that runs the 7 heuristics | `src/lib/inngest/anomalies.ts` | Stale, churning, scope creep, priority inversion, deadline risk, owner gap, goal drift. |
| 2.4 | Per-user identity mapping table — `workspace_user_aliases(workspace_id, auth_user_id, source, alias)` | migration | Resolves "Arun" / "arunv@…" / "@arun" to the same logged-in user across sources. Required for `is_mine`. |
| 2.5 | `/dashboard` becomes the per-user tracker — open work, open action items, owned goals, AI-narrated digest | `src/app/(app)/dashboard/page.tsx` + new client | Replaces the current generic overview when signed in. |
| 2.6 | Project page revamp — new dashboard metrics from Phase 1, anomalies surfaced inline | `src/app/(app)/projects/[key]/page.tsx` | Phase 4 of jira-tracker.md. |

**Exit criteria:** Logged-in user visits `/dashboard` and sees: their open Jira tickets, ranked by AI priority; their owned goals with progress bars; this week's anomalies for projects they're in; a 1-paragraph AI digest tying it together.

---

## Phase 3 — Cloud (week 8–10)

**Goal:** Hosted multi-tenant version on Turso. Open the waitlist.

| # | Deliverable | Touches | Notes |
|---|---|---|---|
| 3.1 | Turso integration — provision a tenant DB on workspace creation, run all migrations | `src/lib/cloud/provisioning.ts` | Turso CLI + API, called from a server action when a new tenant is created. |
| 3.2 | Multi-tenant request lifecycle — extract tenant from auth context, route DB connection per request | `src/middleware.ts` (proxy) + `src/lib/db/index.ts` | Each request gets its own DB connection scoped to the tenant. |
| 3.3 | Per-tenant `WORKGRAPH_SECRET_KEY` derivation from a master key in env (Vercel KMS / 1Password) | `src/lib/crypto.ts` | Tenant-scoped encryption key for OAuth tokens + AI provider keys. |
| 3.4 | Cloud onboarding flow — sign up → create workspace → provision DB → first connector setup | `src/app/(app)/onboarding/` | Wizard. ~5 screens. |
| 3.5 | Stripe integration — free trial, paid tier (per-seat or flat), metered AI option | `src/app/api/stripe/`, `src/lib/billing/` | Defer until we have actual signups. Cloud can launch on free tier. |
| 3.6 | Cloud-only landing routes — `/sign-up`, `/pricing` | `src/app/(marketing)/` | Marketing pages only show on cloud deploys (env-gated). |

**Exit criteria:** A new user signs up at `workgraph.app/sign-up`, creates a workspace, connects Jira, runs first sync — all without any setup of their own. Their data lives in their own Turso DB which we can't accidentally cross-query.

---

## Phase 4 — Polish (week 11+)

These can ship piecemeal in any order:

- **Other connectors** following the JIRA pattern: Notion, Slack, GitHub, Granola, Linear (each is ~1 week)
- **Settings panel for tweaking the process** (jira-tracker.md Phase 9) — schedule cadences, anomaly thresholds, AI prompts
- **Webhooks** for realtime (replaces 30-minute polling)
- **Markdown / Obsidian export**
- **Audit logs** of every AI call for debuggability
- **AI cost dashboard** — per-tenant token usage, daily budget cap

---

## What unblocks what

```
                Phase 0  ──────►  Phase 1  ──────►  Phase 2  ──────►  Phase 3
              foundation       jira pipeline      tracker UI        cloud
                  │                 │                 │
                  ▼                 │                 │
            (works locally)         │                 │
                                    ▼                 │
                              (jira sync runs         │
                               with summaries)        │
                                                      ▼
                                               (logged-in user
                                                sees their tracker)
```

Phase 0 is the only true blocker for everything else. Phases 1 and 2 can technically interleave (we could ship action-item extraction in Phase 1, defer the goals UI to Phase 2). Phase 3 has zero dependencies on Phase 1's *content* — it just needs Phase 0's adapter — which means we could in principle parallelize Phase 1 and Phase 3 if we had two people.

For a single-developer track, the order above is the right one.

---

## What I (the agent) can do versus what needs you

**I can ship without input on:**
- 0.1, 0.2 — Drizzle port (mechanical)
- 0.3 — adapter abstraction
- 0.5 — Inngest heartbeat
- 1.2, 1.3 — metadata enrichment + comment-chunking fix
- 1.4, 1.5 — AI enrichment prompt
- 2.1, 2.2, 2.3 — schema migrations
- 2.6 — project page revamp
- All of Phase 4

**I need your input on:**
- 0.4 — your Inngest account creds (one-time setup; you sign up, paste keys)
- 1.1 — cadence defaults (30m / daily okay? more? less?)
- 1.6 — UX for cadence + scope picker (I'll mock it; you confirm)
- 2.4 — identity mapping rules (auto-match by email? require explicit alias setup?)
- 2.5 — what should the AI-narrated digest sound like (formal? casual? what data?)
- 3.1, 3.2 — when to start Phase 3 (after Phase 2 ships? in parallel?)
- 3.3 — master key location (env var vs 1Password vs Vercel encrypted env)
- 3.5 — pricing model (defer)

---

## First PR checklist

When we kick off, the first PR is **Phase 0.1 + 0.3** together — it's the shape that everything else builds on. Concrete:

- [ ] `bun add drizzle-orm drizzle-kit @libsql/client`
- [ ] `src/lib/db/schema.ts` — Drizzle table definitions matching current SQLite shape exactly
- [ ] `src/lib/db/index.ts` — connection factory dispatching on `DATABASE_URL` (defaults to `file:./data/workgraph.db`)
- [ ] `drizzle.config.ts` — pointed at `src/lib/db/schema.ts`
- [ ] One smoke test: `bun scripts/smoke-db.ts` opens the DB, inserts a workspace row, reads it back, prints
- [ ] Update `scripts/init-db.ts` to use Drizzle migrations
- [ ] No callsite changes yet — just the foundation. Subsequent PRs migrate one module at a time.

That PR should be ~500 lines and land in a day.
