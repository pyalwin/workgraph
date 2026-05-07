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

## Build from source

```sh
npm install
npm run build      # runs tsc → dist/
node dist/index.js run
```

## Test

```sh
npm test           # runs all *.test.ts via node:test
```

## License

MIT — see [LICENSE](./LICENSE).
