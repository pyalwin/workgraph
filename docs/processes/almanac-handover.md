# Almanac — Handover for Next Session

> Single point of entry to resume work on the Almanac feature. Read this first,
> then `almanac-plan.md` for the full technical plan.

## Where things stand

- **Branch:** `feat/almanac-foundation` (created off `main`, this commit is the
  scaffolding only — no implementation yet).
- **Jira epic:** [KAN-39](https://workgraph.atlassian.net/browse/KAN-39) —
  *Almanac · local-agent based product evolution view*.
- **Stories:** [KAN-40](https://workgraph.atlassian.net/browse/KAN-40) (Phase 0)
  through [KAN-49](https://workgraph.atlassian.net/browse/KAN-49) (Phase 7).
  All in status **Idea**.
- **Plan:** [`docs/processes/almanac-plan.md`](./almanac-plan.md).

No code has been written yet. The plan locks every decision so the next session
can start coding without re-litigating architecture.

## What was decided (and what was rejected) — short version

- **Compute lives on the user's machine via the local-agent.** Vercel Sandbox
  was investigated (incl. Codex device-code OAuth) and rejected — too much
  auth/orchestration surface for a feature that already has half the local-agent
  scaffolding in place (see "Existing scaffolding" in the plan).
- **AI provider is the user's local Codex/Claude/Gemini CLI**, billed against
  their subscription, not a platform API key.
- **Mechanical work is deterministic Node code in the agent. Synthesis (cluster
  naming, narrative writing) is the *only* part delegated to the user's CLI.**
  Don't burn user tokens on graph algorithms.
- **The "Almanac" name** replaces earlier "bible" — same artifact, less loaded.

## Start here next session

1. Read `docs/processes/almanac-plan.md` end-to-end (~10 min).
2. Pick up [KAN-40 (Phase 0)](https://workgraph.atlassian.net/browse/KAN-40) —
   it blocks every other story.
3. Verify the existing scaffolding is still intact:
   - `src/lib/schema.ts` — `workspace_agents` table
   - `src/lib/workspace-agents.ts` — `getAgentStatusForUser()` (TODO comments
     confirm pair endpoints not wired)
   - `src/lib/ai/cli-backends/{codex,claude,gemini}.ts` — CLI adapters
   - `src/components/workspace/local-agent-card.tsx` — Settings UI shell
   - `src/components/workspace/agent-install-nudge.tsx`
   - `src/app/api/user/agent-status` — already wired
4. Branch off `feat/almanac-foundation` for Phase 0 work, e.g.
   `feat/almanac-phase-0-agent`.
5. Phase 0 deliverables (in order):
   - `packages/agent/` workspace skeleton
   - `POST /api/agent/pair/{start,poll,confirm}` routes
   - `agent_jobs` + `agent_pairings` tables
   - `GET /api/agent/jobs/poll`, `POST /api/agent/jobs/result`,
     `POST /api/agent/heartbeat`
   - End-to-end smoke: server enqueues a no-op job, agent picks it up, posts
     result, server marks done, LocalAgentCard shows "Connected".

## Open questions still worth flagging (none blocking)

- **Distribution surface:** npm only for v1, Homebrew tap as follow-up. The
  LocalAgentCard already shows `npm install -g @workgraph/agent` so npm is the
  committed v1 surface.
- **Transport:** HTTP long-poll for v1 (simpler on serverless than WebSocket).
  Latency isn't critical for Almanac jobs.
- **Agent token scope:** per-user across workspaces (one local agent serves all
  the user's Jira projects). Cleaner UX, simpler revocation.

## Architectural commitments to honor

These were debated extensively. Don't relitigate without re-reading the plan:

- **Codex doesn't understand evolution alone.** The pipeline understands
  evolution through git lifecycles + co-change clustering. The CLI *narrates*
  what the pipeline finds. Skipping Phase 1.5 (file_lifecycle) or Phase 1.6
  (noise classifier) breaks evolution detection on deleted/renamed/noisy code.
- **Cluster IDs are deterministic** (hash of file set). Names come from CLI
  synthesis but are persisted. RAG anchors and citation links never break.
- **Auto-attach at Tier A only (≥ 0.75).** Tier B (branch) and Tier C (commit)
  always queue for review. Silent low-confidence links pollute the narrative.
- **Many small diagrams per section, not one mega-Gantt.** Embedded
  `:::diagram type=... params=...:::` blocks in markdown.
- **Per-section regen with `source_hash`.** Section is the chunk; same chunks
  feed the chat RAG (Phase 7).

## What this commit contains

- `docs/processes/almanac-plan.md` — full plan (locked decisions, phase map,
  schema, cross-cutting concerns).
- `docs/processes/almanac-handover.md` — this file.

No code, no schema changes yet. The next session opens [KAN-40](https://workgraph.atlassian.net/browse/KAN-40)
and starts Phase 0.
