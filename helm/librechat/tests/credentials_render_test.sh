#!/usr/bin/env bash
# Missing named credential Secrets must block startup, not generate per-pod keys.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${CHART_DIR}/../.." && pwd)"
TEST_DIR="$(mktemp -d -t librechat-credentials-chart.XXXXXX)"
trap 'rm -rf "${TEST_DIR}"' EXIT

command -v helm >/dev/null || { echo 'FAIL: helm not on PATH' >&2; exit 1; }
mkdir -p "${TEST_DIR}/chart/templates"
awk '/^dependencies:/{ exit } { print }' "${CHART_DIR}/Chart.yaml" > "${TEST_DIR}/chart/Chart.yaml"
cp "${CHART_DIR}/values.yaml" "${TEST_DIR}/chart/values.yaml"
for template in _helpers.tpl deployment.yaml configmap.yaml configmap-env.yaml; do
  cp "${CHART_DIR}/templates/${template}" "${TEST_DIR}/chart/templates/${template}"
done

render() {
  helm template librechat "${TEST_DIR}/chart" \
    --set mongodb.enabled=false --set meilisearch.enabled=false \
    --set redis.enabled=false --set librechat-rag-api.enabled=false \
    --set-string librechat.configEnv.MONGO_URI=mongodb://database:27017/LibreChat "$@"
}
render > "${TEST_DIR}/default.yaml"
render --set replicaCount=2 --set global.librechat.existingSecretName=shared-credentials > "${TEST_DIR}/replicas.yaml"
# This alternate fixture intentionally excludes bundled Meilisearch's separate Secret.
cat > "${TEST_DIR}/alternate-values.yaml" <<'YAML'
meilisearch:
  enabled: false
global:
  librechat:
    existingSecretName: ""
    env:
      - name: JWT_SECRET
        valueFrom:
          secretKeyRef:
            name: separately-managed
            key: jwt
librechat:
  configEnv:
    JWT_REFRESH_SECRET: fixture-refresh
    CREDS_KEY: fixture-key
    CREDS_IV: fixture-iv
YAML
render -f "${TEST_DIR}/alternate-values.yaml" > "${TEST_DIR}/alternate.yaml"

NODE_PATH="${REPO_ROOT}/node_modules${NODE_PATH:+:${NODE_PATH}}" TEST_DIR="${TEST_DIR}" node <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const docs = (name) => yaml.loadAll(fs.readFileSync(path.join(process.env.TEST_DIR, name), 'utf8')).filter(Boolean);
const deployment = (items) => items.find((doc) => doc.kind === 'Deployment');
const container = (items) => deployment(items).spec.template.spec.containers[0];
const defaults = docs('default.yaml');
assert.deepEqual(container(defaults).envFrom.find((entry) => entry.secretRef), {
  secretRef: { name: 'librechat-credentials-env', optional: false },
});
const replicas = docs('replicas.yaml');
assert.equal(deployment(replicas).spec.replicas, 2);
assert.deepEqual(container(replicas).envFrom.find((entry) => entry.secretRef), {
  secretRef: { name: 'shared-credentials', optional: false },
});
const alternateValues = yaml.load(fs.readFileSync(path.join(process.env.TEST_DIR, 'alternate-values.yaml'), 'utf8'));
assert.equal(alternateValues.meilisearch.enabled, false);
const chartValues = yaml.load(fs.readFileSync(path.join(process.env.TEST_DIR, 'chart/values.yaml'), 'utf8'));
assert.equal(chartValues.meilisearch.enabled, true);
assert.equal(chartValues.meilisearch.auth.existingMasterKeySecret, 'librechat-credentials-env');
const alternate = docs('alternate.yaml');
assert.equal(container(alternate).envFrom.some((entry) => entry.secretRef), false);
assert.deepEqual(container(alternate).env, [{
  name: 'JWT_SECRET', valueFrom: { secretKeyRef: { name: 'separately-managed', key: 'jwt' } },
}]);
const config = alternate.find((doc) => doc.kind === 'ConfigMap' && doc.metadata.name.endsWith('-configenv'));
assert.ok(Object.values(config.data).every((value) => typeof value === 'string'));
assert.equal(Object.hasOwn(config.data, 'JWT_SECRET'), false);
assert.equal(config.data.JWT_REFRESH_SECRET, 'fixture-refresh');
assert.equal(config.data.CREDS_KEY, 'fixture-key');
assert.equal(config.data.CREDS_IV, 'fixture-iv');
console.log('PASS: required default/custom Secrets, shared replica credentials, and alternate environment injection with bundled Meilisearch disabled');
NODE
