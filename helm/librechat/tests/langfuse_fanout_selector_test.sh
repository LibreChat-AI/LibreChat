#!/usr/bin/env bash
# Regression test for Langfuse fanout Helm selectors.
#
# The fanout collector must not share the main LibreChat app selector labels.
# Otherwise the main Service can route HTTP traffic to the OTEL collector pod.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${CHART_DIR}/../.." && pwd)"
RENDER_CHART_DIR="$(mktemp -d -t librechat-fanout-chart.XXXXXX)"
RENDERED_FILE="$(mktemp -t librechat-fanout-render.XXXXXX)"
INVALID_RENDER_ERROR="$(mktemp -t librechat-fanout-invalid-key.XXXXXX)"
COLLISION_RENDER_ERROR="$(mktemp -t librechat-fanout-colliding-key.XXXXXX)"
trap 'rm -rf "${RENDER_CHART_DIR}"; rm -f "${RENDERED_FILE}" "${INVALID_RENDER_ERROR}" "${COLLISION_RENDER_ERROR}"' EXIT

if ! command -v helm >/dev/null 2>&1; then
  echo "FAIL: helm not on PATH" >&2
  exit 1
fi

mkdir -p "${RENDER_CHART_DIR}/templates"
awk '/^dependencies:/{ exit } { print }' "${CHART_DIR}/Chart.yaml" > "${RENDER_CHART_DIR}/Chart.yaml"
cp "${CHART_DIR}/values.yaml" "${RENDER_CHART_DIR}/values.yaml"
cp "${CHART_DIR}/templates/_helpers.tpl" "${RENDER_CHART_DIR}/templates/_helpers.tpl"
cp "${CHART_DIR}/templates/service.yaml" "${RENDER_CHART_DIR}/templates/service.yaml"
cp "${CHART_DIR}/templates/langfuse-fanout-service.yaml" \
  "${RENDER_CHART_DIR}/templates/langfuse-fanout-service.yaml"
cp "${CHART_DIR}/templates/langfuse-fanout-deployment.yaml" \
  "${RENDER_CHART_DIR}/templates/langfuse-fanout-deployment.yaml"

helm template librechat "${RENDER_CHART_DIR}" \
  --set langfuseFanout.enabled=true \
  --set langfuseFanout.central.authHeaderSecret.name=langfuse-central \
  --set langfuseFanout.redis.uri=redis://langfuse-fanout-redis:6379 \
  --show-only templates/service.yaml \
  --show-only templates/langfuse-fanout-service.yaml \
  --show-only templates/langfuse-fanout-deployment.yaml \
  > "${RENDERED_FILE}"

if helm template librechat "${RENDER_CHART_DIR}" \
  --set langfuseFanout.enabled=true \
  --set langfuseFanout.central.authHeaderSecret.name=langfuse-central \
  --set langfuseFanout.redis.uri=redis://langfuse-fanout-redis:6379 \
  --set langfuseFanout.tenant.destinations.EU.baseUrl=https://cloud.langfuse.com \
  --show-only templates/langfuse-fanout-deployment.yaml \
  > /dev/null 2> "${INVALID_RENDER_ERROR}"; then
  echo "FAIL: Helm accepted invalid uppercase Langfuse fanout destination key" >&2
  exit 1
fi

if ! grep -q 'langfuseFanout.tenant.destinations key "EU" is invalid' "${INVALID_RENDER_ERROR}"; then
  echo "FAIL: invalid destination key render did not explain the key contract" >&2
  cat "${INVALID_RENDER_ERROR}" >&2
  exit 1
fi

if helm template librechat "${RENDER_CHART_DIR}" \
  --set langfuseFanout.enabled=true \
  --set langfuseFanout.central.authHeaderSecret.name=langfuse-central \
  --set langfuseFanout.redis.uri=redis://langfuse-fanout-redis:6379 \
  --set langfuseFanout.tenant.destinations.foo-bar.baseUrl=https://foo-bar.example.com \
  --set langfuseFanout.tenant.destinations.foo_bar.baseUrl=https://foo-bar.example.com \
  --show-only templates/langfuse-fanout-deployment.yaml \
  > /dev/null 2> "${COLLISION_RENDER_ERROR}"; then
  echo "FAIL: Helm accepted colliding Langfuse fanout destination env var keys" >&2
  exit 1
fi

if ! grep -q 'both render LANGFUSE_FANOUT_TENANT_FOO_BAR_BASE_URL' "${COLLISION_RENDER_ERROR}"; then
  echo "FAIL: colliding destination key render did not explain the env var collision" >&2
  cat "${COLLISION_RENDER_ERROR}" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node not on PATH" >&2
  exit 1
fi

NODE_PATH="${REPO_ROOT}/node_modules${NODE_PATH:+:${NODE_PATH}}" \
RENDERED_FILE="${RENDERED_FILE}" node <<'NODE'
const fs = require('fs');
const yaml = require('js-yaml');

const docs = yaml
  .loadAll(fs.readFileSync(process.env.RENDERED_FILE, 'utf8'))
  .filter(Boolean);

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function find(kind, name) {
  const doc = docs.find((candidate) => candidate.kind === kind && candidate.metadata?.name === name);
  if (!doc) {
    fail(`missing ${kind}/${name}`);
  }
  return doc;
}

function isSubset(subset, labels) {
  return Object.entries(subset ?? {}).every(([key, value]) => labels?.[key] === value);
}

function envValue(env, name) {
  return (env ?? []).find((entry) => entry.name === name)?.value;
}

const mainService = find('Service', 'librechat-librechat');
const fanoutService = find('Service', 'librechat-librechat-langfuse-fanout');
const fanoutDeployment = find('Deployment', 'librechat-librechat-langfuse-fanout');
const fanoutContainer = fanoutDeployment.spec?.template?.spec?.containers?.find(
  (container) => container.name === 'langfuse-fanout',
);
if (!fanoutContainer) {
  fail('missing langfuse-fanout container');
}

const mainSelector = mainService.spec?.selector ?? {};
const fanoutSelector = fanoutService.spec?.selector ?? {};
const fanoutMatchLabels = fanoutDeployment.spec?.selector?.matchLabels ?? {};
const fanoutPodLabels = fanoutDeployment.spec?.template?.metadata?.labels ?? {};
const fanoutMetadataLabels = fanoutDeployment.metadata?.labels ?? {};

if (isSubset(mainSelector, fanoutPodLabels)) {
  fail('main Service selector matches fanout pod labels');
}
if (!isSubset(fanoutSelector, fanoutPodLabels)) {
  fail('fanout Service selector does not match fanout pod labels');
}
if (!isSubset(fanoutMatchLabels, fanoutPodLabels)) {
  fail('fanout Deployment selector is not a subset of pod labels');
}
if (mainSelector['app.kubernetes.io/name'] === fanoutSelector['app.kubernetes.io/name']) {
  fail('main and fanout Services share app.kubernetes.io/name selectors');
}
if (fanoutMetadataLabels['app.kubernetes.io/name'] !== fanoutSelector['app.kubernetes.io/name']) {
  fail('fanout Deployment metadata labels do not use fanout app name');
}
if (envValue(fanoutContainer.env, 'LANGFUSE_FANOUT_REDIS_URI') !== 'redis://langfuse-fanout-redis:6379') {
  fail('fanout Deployment did not render configured Redis URI');
}
if (
  envValue(fanoutContainer.env, 'LANGFUSE_FANOUT_PUBLIC_URL') !==
  'http://librechat-librechat-langfuse-fanout.default.svc.cluster.local:4318'
) {
  fail('fanout Deployment did not render derived public URL');
}
if (fanoutContainer.livenessProbe?.httpGet?.path !== '/healthz') {
  fail('fanout Deployment missing /healthz liveness probe');
}
if (fanoutContainer.readinessProbe?.httpGet?.path !== '/healthz') {
  fail('fanout Deployment missing /healthz readiness probe');
}

console.log('PASS: Langfuse fanout selectors are isolated from the main LibreChat Service');
NODE
