#!/usr/bin/env bash
# Regression test for the librechat ConfigMap template.
#
# Background: at one point templates/configmap.yaml ran
# `.Values.librechat.configYamlContent | toYaml | indent 4`. Because the
# value is already a YAML literal string, toYaml re-wrapped it in another `|`
# block scalar, producing a mounted /app/librechat.yaml whose first line was
# a bare `|`. js-yaml "recovered" by returning the body as a string, so
# LibreChat silently fell back to internal defaults for every config block
# (endpoints, interface, modelSpecs, ...).
#
# This test renders the ConfigMap with a sample configYamlContent and asserts
# that the rendered librechat.yaml is a proper YAML object preserving nested
# keys.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VALUES_FILE="$(mktemp -t librechat-configmap-values.XXXXXX)"
RENDERED_FILE="$(mktemp -t librechat-configmap-render.XXXXXX)"
trap 'rm -f "${VALUES_FILE}" "${RENDERED_FILE}"' EXIT

cat > "${VALUES_FILE}" <<'YAML'
librechat:
  configYamlContent: |
    version: 1.3.11
    endpoints:
      agents:
        disableBuilder: false
YAML

if ! command -v helm >/dev/null 2>&1; then
  echo "FAIL: helm not on PATH" >&2
  exit 1
fi

# Render only the chart's templates so dependent sub-charts don't need network access.
helm template librechat "${CHART_DIR}" \
  --show-only templates/configmap.yaml \
  -f "${VALUES_FILE}" > "${RENDERED_FILE}"

# Pull the block scalar body that lives under `librechat.yaml: |`.
# awk: enter the block on the header line, then emit subsequent lines while
# they are indented (the body) and stop at the next unindented line.
BODY="$(awk '
  /^  librechat\.yaml: \|/ { in_block = 1; next }
  in_block {
    if ($0 ~ /^    /) { sub(/^    /, ""); print; next }
    if ($0 ~ /^$/)    { print; next }
    exit
  }
' "${RENDERED_FILE}")"

if [[ -z "${BODY}" ]]; then
  echo "FAIL: could not extract librechat.yaml body from rendered ConfigMap" >&2
  cat "${RENDERED_FILE}" >&2
  exit 1
fi

FIRST_LINE="$(printf '%s\n' "${BODY}" | awk 'NF { print; exit }')"
if [[ "${FIRST_LINE}" == "|" ]]; then
  echo "FAIL: rendered librechat.yaml starts with a bare '|' — configYamlContent is double-wrapped" >&2
  echo "----- rendered body -----" >&2
  printf '%s\n' "${BODY}" >&2
  exit 1
fi

if ! printf '%s\n' "${BODY}" | grep -qE '^version: 1\.3\.11$'; then
  echo "FAIL: expected top-level 'version: 1.3.11' in rendered librechat.yaml" >&2
  printf '%s\n' "${BODY}" >&2
  exit 1
fi

if ! printf '%s\n' "${BODY}" | grep -qE '^endpoints:$'; then
  echo "FAIL: expected top-level 'endpoints:' key in rendered librechat.yaml" >&2
  printf '%s\n' "${BODY}" >&2
  exit 1
fi

if ! printf '%s\n' "${BODY}" | grep -qE '^  agents:$'; then
  echo "FAIL: expected nested 'endpoints.agents' key in rendered librechat.yaml" >&2
  printf '%s\n' "${BODY}" >&2
  exit 1
fi

# If a YAML parser is available, do a real parse to confirm the body loads as
# an object (not a string) and that endpoints.agents survives the round trip.
PARSER=""
if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' >/dev/null 2>&1; then
  PARSER="python3"
elif command -v node >/dev/null 2>&1 && node -e 'require("js-yaml")' >/dev/null 2>&1; then
  PARSER="node"
fi

case "${PARSER}" in
  python3)
    BODY="${BODY}" python3 - <<'PY'
import os, sys, yaml
body = os.environ["BODY"]
doc = yaml.safe_load(body)
if not isinstance(doc, dict):
    sys.stderr.write(f"FAIL: parsed librechat.yaml is {type(doc).__name__}, expected dict\n")
    sys.exit(1)
agents = (doc.get("endpoints") or {}).get("agents")
if not isinstance(agents, dict) or "disableBuilder" not in agents:
    sys.stderr.write(f"FAIL: endpoints.agents missing or malformed after parse: {agents!r}\n")
    sys.exit(1)
PY
    ;;
  node)
    BODY="${BODY}" node -e '
      const yaml = require("js-yaml");
      const doc = yaml.load(process.env.BODY);
      if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
        console.error("FAIL: parsed librechat.yaml is " + typeof doc + ", expected object");
        process.exit(1);
      }
      const agents = doc.endpoints && doc.endpoints.agents;
      if (!agents || typeof agents.disableBuilder === "undefined") {
        console.error("FAIL: endpoints.agents missing after parse: " + JSON.stringify(agents));
        process.exit(1);
      }
    '
    ;;
  *)
    echo "NOTE: skipping YAML-parser assertion (install python3+pyyaml or node+js-yaml to enable)"
    ;;
esac

echo "PASS: rendered librechat.yaml is a proper YAML document with nested keys preserved"
