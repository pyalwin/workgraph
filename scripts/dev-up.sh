#!/usr/bin/env bash
# Single-command launcher for the full Almanac dev stack:
#   1. Local libsql-server (Docker)         http://127.0.0.1:8081
#   2. Next.js dev server                   http://localhost:3000
#   3. Inngest dev server                   http://localhost:8288
#   4. Workgraph agent (workgraph run)      polls http://localhost:3000
#
# Each long-running process gets:
#   - prefixed, color-tinted stdout in this terminal
#   - a raw log file under ./logs/<name>.log for grep / replay
#
# Stops everything cleanly on Ctrl-C.
#
# Usage: bash scripts/dev-up.sh
#        (or chmod +x and ./scripts/dev-up.sh)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p logs

# ─── ANSI colors so the four streams are easy to tell apart ─────────────────
C_RED=$'\033[31m'
C_GRN=$'\033[32m'
C_YEL=$'\033[33m'
C_BLU=$'\033[34m'
C_MAG=$'\033[35m'
C_DIM=$'\033[2m'
C_OFF=$'\033[0m'

note() { printf "%s[dev-up]%s %s\n" "$C_DIM" "$C_OFF" "$*"; }
warn() { printf "%s[dev-up]%s %s\n" "$C_YEL" "$C_OFF" "$*" >&2; }
fail() { printf "%s[dev-up]%s %s\n" "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

# ─── 1. libsql (start container if not already healthy) ────────────────────
note "checking libsql at http://127.0.0.1:8081/health"
if ! curl -fsS --max-time 1 http://127.0.0.1:8081/health >/dev/null 2>&1; then
  note "starting libsql container via 'npm run db:up'"
  npm run db:up
  note "waiting for libsql to respond..."
  for i in {1..20}; do
    if curl -fsS --max-time 1 http://127.0.0.1:8081/health >/dev/null 2>&1; then
      note "libsql ready"
      break
    fi
    sleep 1
    if [ "$i" -eq 20 ]; then
      fail "libsql did not become healthy within 20s — check 'npm run db:logs'"
    fi
  done
else
  note "libsql already running"
fi

# ─── 2-4. Background long-running processes ────────────────────────────────
PIDS=()

# Helper: spawn a command, prefix its output, mirror to a file.
# Usage: launch <name> <color> <command...>
launch() {
  local name="$1"; local color="$2"; shift 2
  local logfile="$ROOT/logs/$name.log"
  : > "$logfile"   # truncate fresh each run

  local prefix; prefix=$(printf "%s[%s]%s " "$color" "$name" "$C_OFF")

  # stderr+stdout merged → tee to file → prefix line by line → terminal
  ( "$@" 2>&1 | tee "$logfile" | sed -u "s|^|${prefix}|" ) &
  local pid=$!
  PIDS+=("$pid")
  note "$name pid=$pid log=logs/$name.log"
}

# Start Next.js first; Inngest auto-discovers it on :3000.
launch next   "$C_GRN" npm run dev

# Wait until Next is responsive before starting the rest, so Inngest's
# discovery succeeds on its first poll.
note "waiting for Next.js to be ready on :3000..."
for i in {1..40}; do
  if curl -fsS --max-time 1 http://localhost:3000/api/inngest >/dev/null 2>&1; then
    note "Next.js ready"
    break
  fi
  sleep 1
  if [ "$i" -eq 40 ]; then
    warn "Next.js didn't respond at /api/inngest within 40s — continuing anyway, check logs/next.log"
  fi
done

launch inngest "$C_BLU" npx --yes inngest-cli@latest dev -u http://localhost:3000/api/inngest

# Agent depends on Next being up; check that workgraph is on PATH first.
if ! command -v workgraph >/dev/null 2>&1; then
  warn "'workgraph' command not found on PATH — running 'npm link' in packages/agent"
  ( cd "$ROOT/packages/agent" && npm link >/dev/null 2>&1 ) || \
    fail "failed to npm link the agent — run it manually: cd packages/agent && npm link"
fi

launch agent  "$C_MAG" workgraph run

# ─── Cleanup on Ctrl-C ─────────────────────────────────────────────────────
cleanup() {
  echo
  note "shutting down (${#PIDS[@]} processes)..."
  for pid in "${PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  # Give them 3s to exit cleanly, then force.
  sleep 3
  for pid in "${PIDS[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  note "stopped. libsql container left running — 'npm run db:down' to stop it too."
  exit 0
}
trap cleanup INT TERM

note "─────────────────────────────────────────────────────────"
note "stack is up. tail logs:    tail -f logs/{next,inngest,agent}.log"
note "                           grep '\\[narrate' logs/agent.log"
note "open the app:              http://localhost:3000"
note "open inngest dev:          http://localhost:8288"
note "open libsql admin (HTTP):  http://localhost:8081/health"
note "ctrl-c here stops next + inngest + agent (libsql stays up)"
note "─────────────────────────────────────────────────────────"

# Block until any child exits, then propagate.
wait -n
note "one process exited — shutting down the rest"
cleanup
