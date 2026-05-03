# Almanac — Implementation Plan

> A per-project Almanac at `/projects/[key]/almanac` — a generated, citation-linked
> technical manual built from two independent passes (Jira tickets and full git
> history), reconciled into a single document. Org members read; admins
> edit/regenerate. Compute runs on the user's machine via the local agent.

Jira epic: **[KAN-39](https://workgraph.atlassian.net/browse/KAN-39)**
Stories: **KAN-40 → KAN-49** (one per phase).
Feature branch: `feat/almanac-foundation`.

---

## Architecture in one paragraph

The local agent (npm-distributed `@workgraph/agent`, running on the user's
laptop) does all heavy compute — git history extraction, file-lifecycle tracing,
noise classification, co-change clustering, dossier building, and synthesis via
the user's own Codex / Claude / Gemini CLI. Server orchestrates jobs via the
existing Inngest layer, stores results in the workgraph DB, and renders the
Almanac UI. No code or tokens leave the user's environment. The Vercel Sandbox
path was abandoned to avoid auth/orchestration overhead — the local agent
foundation already has scaffolding (schema + cli-backends + UI shell) waiting
to be finished.

---

## Locked decisions

| Decision | Value |
|---|---|
| Feature name | **Almanac** |
| Route | `/projects/[key]/almanac` |
| Visibility | Org members read; admins edit |
| Compute location | Local agent (no Vercel Sandbox) |
| AI provider | User's local CLI subscriptions (Codex default) |
| Source-of-truth event | Merged PR + direct-to-main commits |
| Time grain | Month |
| Auto-attach gate | Tier A (PR-level) ≥ 0.75; B/C → review queue |
| Match ladder | PR → branch → commit |
| Functional unit | Primary axis; Jira epic precedence; user-editable |
| Diagrams | Many small per-section, never one mega-Gantt |
| Regen unit | Per-section, on `source_hash` change |
| Cluster IDs | Deterministic hash of file set |
| Backfill horizon | Earliest Jira ticket date − 30d |

---

## Pipeline split

**Deterministic (agent code, free):**

1. Event extraction — `git log --first-parent main` → `code_events`
2. File lifecycle — `git log --follow` incl. deleted files + rename chains
3. Mechanical noise tagging — file-path rules
4. LLM noise classification (cheap, batched, cached forever per SHA)
5. Co-change matrix + Louvain clustering (signal-only events)
6. Dossier building per cluster (~30K-token budget)
7. Schema validation + DB writes

**CLI synthesis (user's Codex/Claude, billed to their subscription):**

8. Cluster naming + description
9. Per-section narrative generation
10. Drift explanation prose

---

## Existing scaffolding (do not duplicate)

| File | What's there | What's missing |
|---|---|---|
| `src/lib/schema.ts:307` (and `init-schema-async.ts`) | `workspace_agents` table | Pair endpoints |
| `src/lib/workspace-agents.ts` | `getAgentStatusForUser()` | TODO comments confirm pair routes not wired |
| `src/lib/ai/cli-backends/codex.ts` | Spawns `codex exec --json`, parses `agent_message`/`agent_message_delta`/`task_complete` | Reuse from agent process |
| `src/lib/ai/cli-backends/{claude,gemini}.ts` | Same pattern, different CLIs | Reuse from agent |
| `src/components/workspace/local-agent-card.tsx` | Settings UI: "Not paired / Connected" states, copy buttons for `npm install -g @workgraph/agent` and `workgraph login` | Backend not wired |
| `src/components/workspace/agent-install-nudge.tsx` | First-time-user nudge | — |
| `src/app/api/user/agent-status` | Reads paired status | — |

---

## Story map

| Phase | Jira | Title | Effort | Depends on |
|---|---|---|---|---|
| 0 | [KAN-40](https://workgraph.atlassian.net/browse/KAN-40) | Local agent foundation (npm package + pair flow + job protocol) | 4–5d | — |
| 1 | [KAN-41](https://workgraph.atlassian.net/browse/KAN-41) | `code_events` extract job (full git history per repo) | 0.5–1d | KAN-40 |
| 1.5 | [KAN-42](https://workgraph.atlassian.net/browse/KAN-42) | `file_lifecycle` extract (incl. deleted + rename chains) | 0.5d | KAN-41 |
| 1.6 | [KAN-43](https://workgraph.atlassian.net/browse/KAN-43) | Noise classifier (mechanical + cheap CLI batch) | 1d | KAN-41 |
| 2 | [KAN-44](https://workgraph.atlassian.net/browse/KAN-44) | Clustering + functional units (auto-detect + edit) | 1.5d | KAN-43 |
| 3 | [KAN-45](https://workgraph.atlassian.net/browse/KAN-45) | Ticket-first matcher (PR → branch → commit ladder) | 1d | KAN-44 |
| 4 | [KAN-46](https://workgraph.atlassian.net/browse/KAN-46) | Narrative generation (dossier builder + per-section CLI) | 2d | KAN-44, KAN-45 |
| 5 | [KAN-47](https://workgraph.atlassian.net/browse/KAN-47) | Almanac UI (`/projects/[key]/almanac` w/ embedded diagrams) | 2d | KAN-46 |
| 6 | [KAN-48](https://workgraph.atlassian.net/browse/KAN-48) | Functional unit edit UI (rename / merge / split) | 1d | KAN-44, KAN-47 |
| 7 | [KAN-49](https://workgraph.atlassian.net/browse/KAN-49) | RAG wiring (chat tools + almanac chunks) | 1d | KAN-46 |

**Total: ~14.5d.** Phase 0 is half of it; everything else compresses once the
agent foundation lands. Each phase = one feature branch off
`feat/almanac-foundation`, squash-merged when its acceptance criteria pass.

---

## Schema additions (consolidated)

All tables added via append-only DDL block in
`src/lib/db/init-schema-async.ts` (and `src/lib/schema.ts`).

```sql
-- Phase 0
CREATE TABLE agent_pairings (
  pairing_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, user_id TEXT,
  status TEXT, created_at TEXT, expires_at TEXT
);
CREATE TABLE agent_jobs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  kind TEXT NOT NULL, params TEXT NOT NULL,
  status TEXT NOT NULL, idempotency_key TEXT, attempt INTEGER NOT NULL DEFAULT 0,
  result TEXT, error TEXT,
  created_at TEXT, started_at TEXT, completed_at TEXT,
  UNIQUE(agent_id, idempotency_key)
);

-- Phase 1
CREATE TABLE code_events (
  id TEXT PRIMARY KEY, workspace_id TEXT, repo TEXT, sha TEXT, pr_number INTEGER,
  kind TEXT, author_login TEXT, author_email TEXT, occurred_at TEXT, message TEXT,
  files_touched TEXT, additions INTEGER, deletions INTEGER,
  module_id TEXT, functional_unit_id TEXT, classified_as TEXT,
  ticket_link_status TEXT NOT NULL DEFAULT 'unlinked',
  linked_item_id TEXT, link_confidence REAL, link_evidence TEXT,
  created_at TEXT,
  UNIQUE(repo, sha)
);
CREATE TABLE code_events_backfill_state (
  repo TEXT PRIMARY KEY, last_sha TEXT, last_occurred_at TEXT,
  total_events INTEGER, last_run_at TEXT, last_status TEXT, last_error TEXT
);

-- Phase 1.5
CREATE TABLE file_lifecycle (
  repo TEXT, path TEXT,
  first_sha TEXT, first_at TEXT, last_sha TEXT, last_at TEXT,
  status TEXT, rename_chain TEXT, churn INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  PRIMARY KEY (repo, path)
);

-- Phase 1.6 — added as ALTER TABLE on code_events
-- (noise_class, intent, architectural_significance, is_feature_evolution,
--  evolution_override, classifier_run_at)

-- Phase 2
CREATE TABLE modules (
  id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT,
  path_patterns TEXT, detected_from TEXT, status TEXT, created_at TEXT
);
CREATE TABLE functional_units (
  id TEXT PRIMARY KEY, workspace_id TEXT, project_key TEXT,
  name TEXT, description TEXT, status TEXT,
  detected_from TEXT, jira_epic_key TEXT,
  keywords TEXT, file_path_patterns TEXT,
  first_seen_at TEXT, last_active_at TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE functional_unit_aliases (
  unit_id TEXT, alias TEXT, source TEXT, applied_at TEXT,
  PRIMARY KEY (unit_id, alias)
);

-- Phase 3
CREATE TABLE orphan_ticket_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_item_id TEXT, evidence_kind TEXT, tier_reached TEXT,
  candidate_ref TEXT NOT NULL, score REAL, signals TEXT,
  computed_at TEXT, dismissed_at TEXT,
  UNIQUE(issue_item_id, candidate_ref)
);

-- Phase 4
CREATE TABLE almanac_sections (
  id TEXT PRIMARY KEY, workspace_id TEXT, project_key TEXT,
  unit_id TEXT, kind TEXT, anchor TEXT NOT NULL, position INTEGER NOT NULL,
  title TEXT NOT NULL, markdown TEXT NOT NULL,
  diagram_blocks TEXT NOT NULL DEFAULT '[]',
  source_hash TEXT NOT NULL, generated_at TEXT,
  UNIQUE(project_key, anchor)
);
```

---

## Cross-cutting concerns

| Concern | Approach |
|---|---|
| **Cost control** | LLM tokens billed to user's CLI subscription (no platform cost). Bucket aggressively (per-unit-per-month). Skip drift narratives where no drift exists. Cap spend with existing `workspace_ai_usage` ledger as audit trail. |
| **Idempotency** | All sync/regen paths use `INSERT OR IGNORE` + `source_hash` skipping. Re-running is free. |
| **Partial failure** | Agent online/offline: jobs requeue. Sandbox path stays as admin-flag fallback for users who can't run local agents. |
| **Observability** | Every Inngest function logs `{phase, count, duration}`. New `system_health` rows on phase boundaries. |
| **Tests** | Unit tests for: pair flow, job-protocol (queue/poll/result), code_events INSERT batching, noise classification rules, cluster ID determinism, section `source_hash` invalidation. |
| **Migrations** | Single DDL block, idempotent. No drop/rename in this set. |
| **Branching** | Each phase = a branch off `feat/almanac-foundation`, squash-merged when its acceptance criteria pass. Final merge to `main` only after Phase 5 ships a usable read-only Almanac end-to-end. |

---

## Open questions parked for later

1. **Backfill horizon override per repo.** Default `min(jira.created_at) - 30d` or 2y if no Jira yet. Per-repo override → out of scope until users ask.
2. **Multi-repo per project mapping.** Phase 5 will need an explicit `(project_key, repo)` picker UI.
3. **Drift threshold tuning.** "How big a gap counts?" — derived from data, surfaced as a settings-level knob in Phase 6 if needed.
