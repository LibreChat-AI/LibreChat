#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_DIR="$ROOT_DIR/redis-config"

require_redis() {
  if command -v redis-server >/dev/null && command -v redis-cli >/dev/null; then
    return
  fi

  echo "Redis is required. Install it with: sudo apt-get install redis-server redis-tools"
  exit 1
}

redis_is_running() {
  redis-cli -p "$1" ping >/dev/null 2>&1
}

stop_single() {
  if redis_is_running 6379; then
    redis-cli -p 6379 shutdown nosave >/dev/null 2>&1 || true
  fi
}

start_single() {
  mkdir -p "$CLUSTER_DIR/data/6379"

  if redis_is_running 6379; then
    echo "Redis single node is already running on port 6379."
    return
  fi

  redis-server --port 6379 --dir "$CLUSTER_DIR/data/6379" --save '' --appendonly no --daemonize yes
  redis-cli -p 6379 ping >/dev/null
  echo "Redis single node is ready on port 6379."
}

case "${1:-}" in
  single)
    require_redis
    "$CLUSTER_DIR/stop-cluster.sh" >/dev/null 2>&1 || true
    start_single
    ;;
  cluster)
    require_redis
    stop_single
    exec "$CLUSTER_DIR/start-cluster.sh"
    ;;
  stop)
    require_redis
    stop_single
    exec "$CLUSTER_DIR/stop-cluster.sh"
    ;;
  *)
    echo "Usage: $0 {single|cluster|stop}"
    exit 1
    ;;
esac