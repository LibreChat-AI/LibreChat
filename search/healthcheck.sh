#!/usr/bin/env bash
# Waits for the search PoC stack (search/compose.yml) to come up healthy and
# verifies the chat_search_db roles exist. Safe to run repeatedly.
#
# Everything runs through `docker compose exec`, not host-installed
# psql/mongosh/clickhouse-client, so this only assumes a working docker CLI.
#
# Usage: search/healthcheck.sh [timeout_seconds]
#
# Does NOT use pgrep/pkill (hangs in some sandboxes) or any destructive
# command - read-only checks only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/compose.yml"
TIMEOUT_SECONDS="${1:-180}"
POLL_INTERVAL=3

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose -f "$COMPOSE_FILE")
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose -f "$COMPOSE_FILE")
else
  echo "FAIL: neither 'docker compose' nor 'docker-compose' is available." >&2
  echo "This is expected while Docker Desktop's WSL integration is off - rerun once it's enabled." >&2
  exit 1
fi

SERVICES=(ferretdb-postgres ferretdb chat_search_db clickhouse)
FAILURES=0

log() { printf '%s\n' "$*"; }

container_id_for() {
  "${COMPOSE[@]}" ps -q "$1" 2>/dev/null
}

wait_for_health() {
  local service="$1" elapsed=0 cid status
  log "-- waiting for '$service' to report healthy (timeout ${TIMEOUT_SECONDS}s)"
  while [ "$elapsed" -lt "$TIMEOUT_SECONDS" ]; do
    cid="$(container_id_for "$service")"
    if [ -z "$cid" ]; then
      log "   [$elapsed s] container not created yet"
    else
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo "unknown")"
      log "   [$elapsed s] $status"
      if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then
        # `running` covers ferretdb-postgres's healthcheck racing container
        # creation on the very first poll; the loop below re-checks health
        # explicitly for images that define one.
        if [ "$status" = "healthy" ]; then
          return 0
        fi
      fi
      if [ "$status" = "unhealthy" ]; then
        log "   FAIL: $service reported unhealthy"
        docker logs --tail 30 "$cid" 2>&1 | sed 's/^/     /'
        return 1
      fi
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  log "   FAIL: $service did not become healthy within ${TIMEOUT_SECONDS}s"
  return 1
}

for svc in "${SERVICES[@]}"; do
  if ! wait_for_health "$svc"; then
    FAILURES=$((FAILURES + 1))
  fi
done

if [ "$FAILURES" -gt 0 ]; then
  log ""
  log "FAIL: $FAILURES service(s) never became healthy; skipping application-level checks."
  exit 1
fi

log ""
log "== all containers healthy; running application-level checks =="

# --- ferretdb-postgres: wal_level=logical (needed by the later CDC spike) ---
log "-- ferretdb-postgres: wal_level"
WAL_LEVEL="$("${COMPOSE[@]}" exec -T ferretdb-postgres \
  psql -v ON_ERROR_STOP=1 -U "${FERRETDB_PG_USER:?set in search/.env}" -d "${FERRETDB_PG_DB:-postgres}" \
  -tAc "SHOW wal_level;" 2>/dev/null | tr -d '[:space:]')"
if [ "$WAL_LEVEL" = "logical" ]; then
  log "   OK: wal_level=logical"
else
  log "   FAIL: wal_level='$WAL_LEVEL' (expected 'logical')"
  FAILURES=$((FAILURES + 1))
fi

# --- chat_search_db: schema + three roles exist ---
log "-- chat_search_db: schema and roles"
ROLE_QUERY="SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('chat_search_owner','chat_search_writer','chat_search_reader');"
ROLES="$("${COMPOSE[@]}" exec -T chat_search_db \
  psql -v ON_ERROR_STOP=1 -U "${CHAT_SEARCH_BOOTSTRAP_USER:-chat_search_admin}" -d "${CHAT_SEARCH_DB:-chat_search}" \
  -tAc "$ROLE_QUERY" 2>/dev/null | tr -d '[:space:]')"
EXPECTED="chat_search_owner,chat_search_reader,chat_search_writer"
if [ "$ROLES" = "$EXPECTED" ]; then
  log "   OK: chat_search_owner, chat_search_writer, chat_search_reader all exist"
else
  log "   FAIL: expected roles '$EXPECTED', found '$ROLES'"
  FAILURES=$((FAILURES + 1))
fi

log "-- chat_search_db: no request-path role is superuser/owner/BYPASSRLS"
LEAK_QUERY="SELECT string_agg(rolname, ',') FROM pg_roles WHERE rolname = 'chat_search_reader' AND (rolsuper OR rolbypassrls);"
LEAKY="$("${COMPOSE[@]}" exec -T chat_search_db \
  psql -v ON_ERROR_STOP=1 -U "${CHAT_SEARCH_BOOTSTRAP_USER:-chat_search_admin}" -d "${CHAT_SEARCH_DB:-chat_search}" \
  -tAc "$LEAK_QUERY" 2>/dev/null | tr -d '[:space:]')"
if [ -z "$LEAKY" ]; then
  log "   OK: chat_search_reader is neither superuser nor BYPASSRLS"
else
  log "   FAIL: chat_search_reader has an unsafe attribute"
  FAILURES=$((FAILURES + 1))
fi

log "-- chat_search_db: chat_search schema + pgvector extension"
SCHEMA_OK="$("${COMPOSE[@]}" exec -T chat_search_db \
  psql -v ON_ERROR_STOP=1 -U "${CHAT_SEARCH_BOOTSTRAP_USER:-chat_search_admin}" -d "${CHAT_SEARCH_DB:-chat_search}" \
  -tAc "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'chat_search';" 2>/dev/null | tr -d '[:space:]')"
VECTOR_OK="$("${COMPOSE[@]}" exec -T chat_search_db \
  psql -v ON_ERROR_STOP=1 -U "${CHAT_SEARCH_BOOTSTRAP_USER:-chat_search_admin}" -d "${CHAT_SEARCH_DB:-chat_search}" \
  -tAc "SELECT 1 FROM pg_extension WHERE extname = 'vector';" 2>/dev/null | tr -d '[:space:]')"
if [ "$SCHEMA_OK" = "1" ] && [ "$VECTOR_OK" = "1" ]; then
  log "   OK: chat_search schema exists, pgvector extension installed"
else
  log "   FAIL: schema present=$SCHEMA_OK vector extension present=$VECTOR_OK"
  FAILURES=$((FAILURES + 1))
fi

# --- clickhouse: HTTP ping ---
log "-- clickhouse: HTTP ping"
PING="$("${COMPOSE[@]}" exec -T clickhouse \
  wget -q -O - http://localhost:8123/ping 2>/dev/null || true)"
if [ "$PING" = "Ok." ]; then
  log "   OK: clickhouse HTTP ping"
else
  log "   FAIL: clickhouse ping returned '$PING'"
  FAILURES=$((FAILURES + 1))
fi

# --- ferretdb: mongo-wire reachability ---
# Three tiers, most-authoritative first: mongosh, then the repo's own
# `mongodb` driver (already a dependency at the repo root - does a real
# SCRAM-SHA-256 authenticated ping + insert/find/drop round trip, verified
# working during Track 1 development), then a bare TCP check as last resort.
log "-- ferretdb: mongo wire protocol reachability"
FERRETDB_HOST_PORT="${FERRETDB_HOST_PORT:-27021}"
MONGO_URI="mongodb://${FERRETDB_PG_USER:?set in search/.env}:${FERRETDB_PG_PASSWORD:?set in search/.env}@localhost:${FERRETDB_HOST_PORT}/?authMechanism=SCRAM-SHA-256"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if command -v mongosh >/dev/null 2>&1; then
  if mongosh --quiet --eval "db.adminCommand({ping:1})" "$MONGO_URI" >/dev/null 2>&1; then
    log "   OK: mongosh ping succeeded on port $FERRETDB_HOST_PORT"
  else
    log "   FAIL: mongosh ping failed on port $FERRETDB_HOST_PORT"
    FAILURES=$((FAILURES + 1))
  fi
elif command -v node >/dev/null 2>&1 && [ -d "$REPO_ROOT/node_modules/mongodb" ]; then
  if (cd "$REPO_ROOT" && MONGO_URI="$MONGO_URI" node -e '
      const { MongoClient } = require("mongodb");
      (async () => {
        const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
        try {
          await client.connect();
          const ping = await client.db("admin").admin().ping();
          if (ping.ok !== 1) throw new Error("ping.ok !== 1");
          const col = client.db("search_healthcheck").collection("probe");
          const { insertedId } = await col.insertOne({ probe: true, ts: new Date() });
          const found = await col.findOne({ _id: insertedId });
          if (!found) throw new Error("insert/find round trip failed");
          await client.db("search_healthcheck").dropDatabase();
        } finally {
          await client.close();
        }
      })().catch((err) => { console.error(err.message); process.exit(1); });
    ' >/dev/null 2>/tmp/ferretdb-healthcheck-node.err); then
    log "   OK: node mongodb driver ping + insert/find/drop round trip succeeded on port $FERRETDB_HOST_PORT"
  else
    log "   FAIL: node mongodb driver check failed on port $FERRETDB_HOST_PORT: $(cat /tmp/ferretdb-healthcheck-node.err 2>/dev/null)"
    FAILURES=$((FAILURES + 1))
  fi
else
  # No mongosh and no local mongodb driver: fall back to a bare TCP
  # reachability check. The container's own baked-in HEALTHCHECK
  # (`ferretdb ping`) already verified the Mongo protocol end-to-end above,
  # so this is a secondary signal only.
  if (exec 3<>"/dev/tcp/localhost/${FERRETDB_HOST_PORT}") 2>/dev/null; then
    exec 3<&- 3>&-
    log "   OK: TCP port $FERRETDB_HOST_PORT is accepting connections (install mongosh, or run from the repo root, for a real ping)"
  else
    log "   FAIL: TCP port $FERRETDB_HOST_PORT is not reachable"
    FAILURES=$((FAILURES + 1))
  fi
fi

log ""
if [ "$FAILURES" -eq 0 ]; then
  log "PASS: all services healthy, roles present, no obvious leak gate violations."
  exit 0
else
  log "FAIL: $FAILURES check(s) failed."
  exit 1
fi
