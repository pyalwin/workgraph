#!/usr/bin/env bash
# Tear down the Almanac dev stack.
#
# Stops any orphans from a crashed dev-up.sh run + (by default) leaves
# the libsql container running. Pass --all to stop libsql too.
#
# Usage:
#   bash scripts/dev-down.sh         # stops next + inngest + agent
#   bash scripts/dev-down.sh --all   # also stops the libsql container

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

C_RED=$'\033[31m'
C_GRN=$'\033[32m'
C_YEL=$'\033[33m'
C_DIM=$'\033[2m'
C_OFF=$'\033[0m'

note() { printf "%s[dev-down]%s %s\n" "$C_DIM" "$C_OFF" "$*"; }
ok()   { printf "%s[dev-down]%s %s%s%s\n" "$C_DIM" "$C_OFF" "$C_GRN" "$*" "$C_OFF"; }
warn() { printf "%s[dev-down]%s %s%s%s\n" "$C_DIM" "$C_OFF" "$C_YEL" "$*" "$C_OFF" >&2; }

INCLUDE_DB=false
for arg in "$@"; do
  case "$arg" in
    --all|-a) INCLUDE_DB=true ;;
    -h|--help)
      cat <<EOF
Usage: dev-down.sh [--all]

Stops the Almanac dev stack (next + inngest + agent).
Pass --all to also stop the local libsql container.
EOF
      exit 0
      ;;
  esac
done

# Kill processes by pattern. pkill -f matches against the full command line.
# Returns true even if no processes matched, so '|| true' isn't needed.
stop_pattern() {
  local label="$1"
  local pattern="$2"
  # Find first to print PIDs we're about to kill.
  # Use ps + grep -v grep so this script doesn't match itself.
  local pids
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [ -z "$pids" ]; then
    note "$label: nothing running"
    return
  fi
  note "$label: killing pids $(echo "$pids" | tr '\n' ' ')"
  # Polite SIGTERM first, then SIGKILL after 3s for any survivors.
  kill -TERM $pids 2>/dev/null || true
  sleep 1
  local survivors
  survivors=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [ -n "$survivors" ]; then
    sleep 2
    survivors=$(pgrep -f "$pattern" 2>/dev/null || true)
    if [ -n "$survivors" ]; then
      warn "$label: forcing SIGKILL on $(echo "$survivors" | tr '\n' ' ')"
      kill -KILL $survivors 2>/dev/null || true
    fi
  fi
  ok "$label: stopped"
}

# Order matters slightly: stop the agent first so its in-flight job result
# POSTs (if any) hit Next before Next dies. Then Next, then Inngest.
stop_pattern "workgraph agent" 'workgraph run'
stop_pattern "next dev"        'next dev'
stop_pattern "inngest dev"     'inngest-cli'

if $INCLUDE_DB; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^workgraph-libsql$'; then
    note "libsql: stopping container"
    docker compose stop libsql >/dev/null 2>&1 && ok "libsql: stopped" || warn "libsql: stop failed"
  else
    note "libsql: container not running"
  fi
else
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^workgraph-libsql$'; then
    note "libsql: still running (pass --all to stop the container too)"
  fi
fi

note "done."
