# WorkGraph

**Local-first work intelligence.** Pulls your tickets, docs, meetings, and chat into a single SQLite graph, cross-references them, and lets you explore the connections — visually, through summaries, and with Claude in the loop.

Everything runs on your machine. Your data, your keys, your laptop.

---

## What it does

You probably ship work that lives across a dozen tools. A Jira ticket, a Notion design doc, a Slack thread debating it, a Granola meeting where the call was made, a GitHub PR that landed it. WorkGraph stitches those scattered artifacts back into the thing they actually were: one piece of work.

- **Ingest** from Jira, Notion, Slack, GitHub/GitLab, Linear, Granola, Confluence, Google Calendar/Drive, and Teams via OAuth or MCP.
- **Cross-reference** items by issue keys, URLs, titles, and embeddings — so a meeting transcript automatically links to the ticket it was about.
- **Classify** items into strategic goals you define.
- **Summarize** workstreams (clusters of related items) with Claude, surfacing decisions made and decisions still open.
- **Visualize** the resulting graph as a force-directed network you can pan, zoom, and click through.
- **Track** project health, velocity, cycle time, and adoption metrics.

---

## Architecture

```
        ┌──────────────────────────────────────────────────────────┐
        │                   Sources (OAuth + MCP)                  │
        │  Jira · Slack · Notion · GitHub · Granola · Linear · …   │
        └──────────────────────┬───────────────────────────────────┘
                               │
                ┌──────────────▼──────────────┐
                │      Connector adapters     │   src/lib/connectors/
                │   (normalize → work_items)  │
                └──────────────┬──────────────┘
                               │
        ┌──────────────────────▼──────────────────────┐
        │                Sync pipeline                │   src/lib/sync/
        │  ingest → enrich → extract → embed → link   │
        └──────────────────────┬──────────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │   SQLite + sqlite-vec (local)   │   data/workgraph.db
              │  work_items · links · chunks ·  │
              │  embeddings · workstreams · …   │
              └────────────────┬────────────────┘
                               │
        ┌──────────────────────▼──────────────────────┐
        │       Cross-ref · Classify · Summarize      │   src/lib/{crossref,
        │      (Claude + local heuristics + vec)      │   classify,workstream}/
        └──────────────────────┬──────────────────────┘
                               │
        ┌──────────────────────▼──────────────────────┐
        │           Next.js 14 App Router UI          │   src/app/
        │   Overview · Graph · Projects · Metrics ·   │
        │             Decisions · Settings            │
        └─────────────────────────────────────────────┘
```

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14 (App Router) + React 18 |
| Language | TypeScript |
| Storage | SQLite via `better-sqlite3` + `sqlite-vec` for vector search |
| LLM | Anthropic Claude (`@anthropic-ai/sdk`) |
| Tool integration | Model Context Protocol (`@modelcontextprotocol/sdk`) |
| UI | Tailwind CSS + Radix UI primitives |
| Graph viz | `react-force-graph-2d` |
| Runtime | Node 20+ / Bun |

---

## Quickstart

### 1. Install

```bash
bun install
# or: npm install
```

### 2. Configure environment

Create `.env.local` in the project root:

```bash
# Claude — required for summaries, classification, decision extraction
ANTHROPIC_API_KEY=sk-ant-...

# Encryption key for stored OAuth tokens — generate one
WORKGRAPH_SECRET_KEY=$(bun scripts/gen-secret.ts)

# OAuth callback base — match this in your provider apps
OAUTH_REDIRECT_BASE_URL=http://localhost:3000
```

Generate a fresh secret key:

```bash
bun scripts/gen-secret.ts
```

### 3. Initialize the database

```bash
bun scripts/init-db.ts
```

This is idempotent — safe to re-run any time.

### 4. Start the dev server

```bash
bun dev
```

Open [http://localhost:3000](http://localhost:3000), wire up connectors under **Settings**, and run your first sync.

---

## Connectors

| Source | Auth | Adapter |
|---|---|---|
| Jira / Confluence | OAuth (Atlassian) | `src/lib/connectors/adapters/atlassian.ts` |
| Notion | OAuth | `notion.ts` |
| Slack | OAuth | `slack.ts` |
| GitHub | OAuth | `github.ts` |
| GitLab | OAuth | `gitlab.ts` |
| Linear | OAuth | `linear.ts` |
| Granola (meetings) | MCP | `granola.ts` |
| Google Calendar | OAuth | `gcal.ts` |
| Google Drive | OAuth | `gdrive.ts` |
| Microsoft Teams | OAuth | `teams.ts` |

Adding a new source means implementing one adapter — see `src/lib/connectors/types.ts` for the contract.

---

## Modules

The dashboard is split into a few focused modules, each backed by its own routes and queries:

- **Overview** (`/`) — at-a-glance summary of recent activity, open decisions, and stale items.
- **Knowledge graph** (`/knowledge`) — interactive force-directed graph of items and their links, with filtering by source, type, and goal.
- **Projects** (`/projects`) — per-project detail pages with health snapshots, ticket lists, velocity, and Haiku-generated summaries (cached daily).
- **Metrics** (`/metrics`) — cross-source velocity, cycle time, deployment frequency, and adoption charts.
- **Decisions** — first-class extraction of "decided" vs. "asked-but-not-shipped" moments from threads and meetings.
- **Workstreams** — clusters of cross-referenced items, summarized as a single narrative by Claude Sonnet.
- **Settings** (`/settings`) — connector management, OAuth flows, sync triggers.

---

## CLI scripts

All scripts live in `scripts/` and run via `bun scripts/<name>.ts` (or `tsx scripts/<name>.ts`).

| Script | Purpose |
|---|---|
| `init-db.ts` | Create / migrate the schema (idempotent) |
| `gen-secret.ts` | Generate a `WORKGRAPH_SECRET_KEY` |
| `sync-jira.ts` / `sync-slack.ts` / `sync-notion.ts` / `sync-github.ts` / `sync-gmail.ts` / `sync-meetings.ts` | Per-source sync |
| `sync-mcp.ts` | Sync via active MCP tools |
| `process.ts` | Run the full pipeline (enrich → extract → embed → link → classify) |
| `run-sync.sh` | Orchestrator that runs all syncs end-to-end |
| `assemble-reingest.ts` | Rebuild workstreams from current items |
| `*-validate.ts` | Sanity checks for each pipeline stage |
| `orphan-diag.ts` | Find items with no cross-references |

---

## Project structure

```
workgraph/
├── src/
│   ├── app/                  Next.js routes (UI + API)
│   │   ├── api/              REST endpoints (sync, graph, search, oauth, …)
│   │   ├── knowledge/        Graph visualization
│   │   ├── projects/         Projects index + detail
│   │   ├── metrics/          Metrics dashboard
│   │   └── settings/         Connector + workspace management
│   ├── components/           Reusable UI (Radix + Tailwind)
│   ├── lib/
│   │   ├── connectors/       Source adapters + sync orchestrator
│   │   ├── sync/             Ingest, enrich, extract, cleanup
│   │   ├── chunking/         Per-source content chunkers
│   │   ├── embeddings/       Embedding generation (Anthropic / Ollama)
│   │   ├── decision/         Decision extraction + summarization
│   │   ├── workstream/       Workstream assembly + narrative
│   │   ├── oauth/            OAuth provider definitions, tokens, refresh
│   │   ├── modules/          Pluggable dashboard modules
│   │   ├── crossref.ts       Multi-signal item linking
│   │   ├── classify.ts       Goal classification
│   │   ├── metrics.ts        Snapshot computation
│   │   └── schema.ts         SQLite schema + migrations
│   └── styles/
├── scripts/                  CLI tools (sync, validate, maintenance)
├── data/                     Local SQLite DB and seed files (gitignored)
└── docs/                     Specs and implementation plans
```

---

## How data flows

1. **Sync** — A connector adapter fetches new/updated items from a source and writes them to `work_items` (deduped by `(source, source_id)`).
2. **Enrich** — Claude Haiku adds summaries, tags, and authorship signals.
3. **Extract entities** — Issue keys, URLs, mentions, and dates are pulled out into a structured form.
4. **Embed** — Each item (and its chunks) gets a vector embedding stored in `sqlite-vec`.
5. **Link** — `crossref.ts` builds edges in the `links` table from explicit references (e.g. `PEX-123`), URL matches, title similarity, and vector neighbors.
6. **Classify** — Items are assigned to user-defined goals using keywords + embeddings.
7. **Assemble** — Connected components become workstreams; Claude Sonnet writes a narrative for each.
8. **Surface** — The UI queries this graph for the overview, knowledge view, project pages, and metrics.

Every step is incremental and resumable — re-running any phase only touches what's new or changed.

---

## Privacy

- The database is a local SQLite file under `data/`. It never leaves your machine.
- OAuth tokens are encrypted at rest with `WORKGRAPH_SECRET_KEY` (AES-GCM via `src/lib/crypto.ts`).
- Only outbound traffic is to (a) source APIs you've connected and (b) the Anthropic API for summaries and classification.

---

## Status

WorkGraph is an active personal project — the feature surface moves quickly, and parts of it are still WIP. The core ingest → graph → UI loop is working end-to-end across all listed connectors.

---

## License

Personal project — no license declared. Reach out before reuse.
