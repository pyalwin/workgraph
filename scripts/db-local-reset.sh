#!/usr/bin/env bash
# Wipe the local libsql data dir and restart the container so the next request
# re-runs ensureSchemaAsync against an empty DB. Useful when a smoke test
# leaves orphan rows or you want to validate the migration path.
#
# Requires: docker-compose stack from ./docker-compose.yml.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$ROOT/data/libsql"

echo "→ stopping libsql container"
docker compose -f "$ROOT/docker-compose.yml" stop libsql >/dev/null 2>&1 || true

echo "→ removing $DATA_DIR"
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

echo "→ starting libsql container"
docker compose -f "$ROOT/docker-compose.yml" up -d libsql

echo "→ probing http://127.0.0.1:8081/health"
for i in {1..20}; do
  if curl -fsS http://127.0.0.1:8081/health >/dev/null 2>&1; then
    echo "✓ libsql ready at http://127.0.0.1:8081"
    exit 0
  fi
  sleep 1
done

echo "✗ libsql did not respond at http://127.0.0.1:8081 within 20s"
docker compose -f "$ROOT/docker-compose.yml" logs --tail=30 libsql
exit 1
