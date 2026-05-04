# @workgraph/agent

Local agent for Workgraph. Runs on your laptop, pairs to your account, and executes jobs dispatched by the control plane.

## Install

```sh
npm install -g @workgraph/agent
```

## Pair

```sh
workgraph login [--url https://your-workgraph-instance.com]
```

Opens a browser flow. After confirming in the browser the agent writes credentials to `~/.workgraph/agent.json`.

## Run

```sh
workgraph run
```

Starts two parallel loops: heartbeat (every 30 s) and job polling (long-poll, 25 s wait). Press Ctrl+C to stop gracefully — any in-flight job result is sent before exit.

## Status

```sh
workgraph status
# Connected to https://... as agt_xxxx
```

## Config location

`~/.workgraph/agent.json` — written with mode 0600. Contains `url`, `agent_id`, `agent_token`, `paired_at`.

## Logout

```sh
workgraph logout
```

Deletes `~/.workgraph/agent.json`. **Note:** v1 has no server-side revoke. To invalidate the token server-side, re-pair (which mints a new token); admin token-revocation UI is a follow-up.

## Smoke test

Insert a `noop` job directly in the database, then watch the agent pick it up:

```sql
INSERT INTO agent_jobs (id, kind, params, status, created_at)
VALUES (gen_random_uuid(), 'noop', '{"hello":"world"}', 'pending', now());
```

The agent logs `Job <id> (noop) completed.` and posts back `{ echo: { hello: "world" }, ran_at: "..." }`.
