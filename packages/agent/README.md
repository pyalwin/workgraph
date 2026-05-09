# @workgraph/agent

Local agent for [Workgraph](https://workgraph-beta.vercel.app). Polls the
cloud server for jobs and runs them against the Claude CLI on your machine
— so your code never leaves your laptop.

## Prerequisites

- Node 20+
- `claude` CLI installed and authenticated (`claude /login` works)
- `git` configured for any private GitHub repos you want to document

## Install

```sh
npm install -g @workgraph/agent
workgraph login
```

`workgraph login` defaults to the hosted Workgraph server at
`https://workgraph-beta.vercel.app`. Self-hosters can override with
`--url` or the `WORKGRAPH_SERVER_URL` env var.

## Commands

```sh
workgraph login                    # Pair this machine with your Workgraph workspace
workgraph login --dev              # Pair with a local dev server (http://localhost:3000)
workgraph login --url <url>        # Pair with a self-hosted instance
workgraph status                   # Show pairing status and agent info
workgraph logout                   # Remove local credentials
workgraph run                      # Start polling for jobs (foreground; wrap with launchd/systemd)
workgraph repo add <owner/name> <path>   # Map a local repo path (skips auto-clone)
workgraph repo list                # Show mapped repos
workgraph repo remove <owner/name> # Remove a repo mapping
```

## Configuration

Credentials are stored at `~/.workgraph/config.json` (mode `0600`). The
file contains your agent ID, bearer token, and the server URL you paired
against. Delete with `workgraph logout`.

Environment variables:

| Variable                 | Effect                                                               |
|--------------------------|----------------------------------------------------------------------|
| `WORKGRAPH_SERVER_URL`   | Default server URL for `workgraph login` (overridden by `--url`).    |
| `WORKGRAPH_CONFIG_DIR`   | Override config + data dir (default `~/.workgraph`). Useful for running a dev build alongside the globally-installed agent. |

## Build from source

```sh
npm install
npm run build      # runs tsc → dist/
node dist/index.js run
```

## Running the dev build alongside a globally-installed agent

Both binaries default to `~/.workgraph/config.json`, so they would clash on
credentials and repo mappings. Point the dev build at a separate directory
with `WORKGRAPH_CONFIG_DIR`:

```sh
cd packages/agent

# One-time pairing against a local Next.js dev server (http://localhost:3000).
# `dev:login` already passes `--dev`, so it always pairs against localhost:
WORKGRAPH_CONFIG_DIR=~/.workgraph-dev npm run dev:login

# Run the dev agent (foreground) — uses the `dev` script which appends `run`:
WORKGRAPH_CONFIG_DIR=~/.workgraph-dev npm run dev

# Or, with auto-reload on source changes:
WORKGRAPH_CONFIG_DIR=~/.workgraph-dev npm run dev:watch

# Other subcommands have matching scripts:
WORKGRAPH_CONFIG_DIR=~/.workgraph-dev npm run dev:status
WORKGRAPH_CONFIG_DIR=~/.workgraph-dev npm run dev:logout
WORKGRAPH_CONFIG_DIR=~/.workgraph-dev npm run dev:repo -- list
```

The globally-installed `workgraph` binary keeps using `~/.workgraph` as
before — they do not see each other's config, repo maps, or auto-managed
clones. Run them in separate terminals if you want both polling at once.

## Test

```sh
npm test           # runs all *.test.ts via node:test
```

## License

MIT — see [LICENSE](./LICENSE).
