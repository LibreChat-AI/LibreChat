#!/bin/sh
# Creates the usage analytics views (analytics.sql) as the ClickHouse admin.
#
# The views read tables other services create: Langfuse's migrations and the
# HyperDX collector's schema. This waits for them, then applies the SQL. It runs
# as a one-shot Compose service locally and as a one-off ECS task on AWS
# (terraform/clickhouse.tf), on the ClickHouse image.
#
# Environment: CLICKHOUSE_HOST, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, and the SQL
# either inline in ANALYTICS_SQL (ECS has no bind mounts) or as a file at
# ANALYTICS_SQL_FILE.
set -eu

client() {
  clickhouse-client --host "$CLICKHOUSE_HOST" --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" "$@"
}

sql_file=/tmp/analytics.sql
if [ -n "${ANALYTICS_SQL:-}" ]; then
  printf '%s' "$ANALYTICS_SQL" > "$sql_file"
else
  cp "$ANALYTICS_SQL_FILE" "$sql_file"
fi

attempts=0
until [ "$(client --query "SELECT count() FROM system.tables WHERE (database, name) IN (('default', 'events_core'), ('default', 'scores'), ('hyperdx', 'otel_traces'))" 2>/dev/null || echo 0)" = "3" ]; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 60 ]; then
    echo "Gave up after 10 minutes waiting for the Langfuse and HyperDX tables." >&2
    exit 1
  fi
  echo "Waiting for the Langfuse and HyperDX tables..."
  sleep 10
done

client --multiquery < "$sql_file"
echo "Usage analytics views are up to date: $(client --query "SELECT arrayStringConcat(groupArray(name), ', ') FROM system.tables WHERE database = 'analytics'")"
