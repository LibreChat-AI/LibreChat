import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const chart = fileURLToPath(new URL('..', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'channel-gateway-chart-'));
try {
  // Render the real gateway and main Service without downloading unrelated subcharts.
  mkdirSync(join(fixture, 'templates'));
  const metadata = yaml.load(readFileSync(resolve(chart, 'Chart.yaml'), 'utf8'));
  delete metadata.dependencies;
  writeFileSync(join(fixture, 'Chart.yaml'), yaml.dump(metadata));
  copyFileSync(resolve(chart, 'values.yaml'), join(fixture, 'values.yaml'));
  for (const file of ['_helpers.tpl', 'service.yaml', 'channel-gateway.yaml']) {
    copyFileSync(resolve(chart, 'templates', file), join(fixture, 'templates', file));
  }
  function render(values = {}) {
    return yaml
      .loadAll(
        execFileSync(
          'helm',
          [
            'template',
            'fixture',
            fixture,
            ...Object.entries(values).flatMap(([key, value]) => [
              typeof value === 'boolean' ? '--set' : '--set-string',
              `${key}=${value}`,
            ]),
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ),
      )
      .filter(Boolean);
  }
  assert.equal(render().length, 1, 'disabled gateway must not create resources');
  const enabled = { 'channelGateway.enabled': true, 'channelGateway.channelId': 'connection' };
  assert.throws(() => render({ 'channelGateway.enabled': true }), /channelGateway.channelId/);
  assert.throws(
    () => render({ ...enabled, 'global.librechat.existingSecretName': '' }),
    /existingSecretName/,
  );
  for (const overrides of [
    {},
    { 'image.tag': 'v1.2.3-rc1', 'service.port': '9090' },
    {
      'channelGateway.image.tag': 'v1.2.4',
      'channelGateway.existingSecretName': 'gateway-only',
      'channelGateway.slackAppTokenKey': '',
      fullnameOverride: 'a'.repeat(63),
    },
  ]) {
    const docs = render({ ...enabled, ...overrides });
    const deployment = docs.find((doc) => doc.kind === 'Deployment');
    const service = docs.find(
      (doc) => doc.metadata.name === deployment.metadata.name && doc.kind === 'Service',
    );
    const mainService = docs.find((doc) => doc.kind === 'Service' && doc !== service);
    const pod = deployment.spec.template;
    const container = pod.spec.containers[0];
    const env = Object.fromEntries(container.env.map((entry) => [entry.name, entry]));
    const matches = (selector) =>
      Object.entries(selector).every(([key, value]) => pod.metadata.labels[key] === value);
    assert(!matches(mainService.spec.selector), 'application traffic must never reach the gateway');
    assert(matches(service.spec.selector));
    assert(matches(deployment.spec.selector.matchLabels));
    assert(deployment.metadata.name.length <= 63);
    assert.equal(service.spec.type, 'ClusterIP');
    assert.equal(
      container.image,
      `ghcr.io/librechat-ai/librechat-channel-gateway:${overrides['channelGateway.image.tag'] || overrides['image.tag'] || metadata.appVersion}`,
    );
    assert.equal(
      env.LIBRECHAT_INTERNAL_URL.value,
      `http://${mainService.metadata.name}:${overrides['service.port'] || 3080}`,
    );
    assert.equal(
      env.CHANNEL_SERVICE_TOKEN.valueFrom.secretKeyRef.name,
      overrides['channelGateway.existingSecretName'] || 'librechat-credentials-env',
    );
    assert.equal(
      container.envFrom,
      undefined,
      'gateway must not import unrelated application secrets',
    );
    assert.equal(Boolean(env.SLACK_APP_TOKEN), overrides['channelGateway.slackAppTokenKey'] !== '');
    assert.equal(container.livenessProbe.httpGet.path, '/livez');
    assert.equal(container.readinessProbe.httpGet.path, '/readyz');
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.equal(deployment.spec.strategy.type, 'Recreate');
  }
  console.log(
    'PASS: optional gateway rendering, image matching, secret isolation, selectors and probes',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
