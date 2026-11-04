import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadConfig } from '../../../packages/channel-gateway/src/config.ts';

const chart = fileURLToPath(new URL('..', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'channel-gateway-chart-'));
try {
  // Render the real gateway and main Service without downloading unrelated subcharts.
  mkdirSync(join(fixture, 'templates'));
  const metadata = yaml.load(readFileSync(resolve(chart, 'Chart.yaml'), 'utf8'));
  delete metadata.dependencies;
  writeFileSync(join(fixture, 'Chart.yaml'), yaml.dump(metadata));
  const defaults = yaml.load(readFileSync(resolve(chart, 'values.yaml'), 'utf8'));
  for (const name of ['mongodb', 'meilisearch', 'redis']) defaults[name].enabled = false;
  writeFileSync(join(fixture, 'values.yaml'), yaml.dump(defaults));
  for (const file of [
    '_helpers.tpl',
    'service.yaml',
    'deployment.yaml',
    'configmap-env.yaml',
    'serviceaccount.yaml',
    'channel-gateway.yaml',
    'channel-gateway-ingress.yaml',
    'ingress.yaml',
  ]) {
    copyFileSync(resolve(chart, 'templates', file), join(fixture, 'templates', file));
  }
  function render(values = {}, platform = {}, kubeVersion) {
    writeFileSync(join(fixture, 'platform.yaml'), yaml.dump(platform));
    return yaml
      .loadAll(
        execFileSync(
          'helm',
          [
            'template',
            'fixture',
            fixture,
            '-f',
            join(fixture, 'platform.yaml'),
            ...(kubeVersion ? ['--kube-version', kubeVersion] : []),
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
  assert.equal(
    render().filter((doc) => doc.kind === 'Deployment').length,
    1,
    'disabled gateway must leave only the application Deployment',
  );
  const enabled = {
    'channelGateway.enabled': true,
    'channelGateway.channelId': 'connection',
    'image.tag': 'v1.2.3',
  };
  assert.throws(() => render({ 'channelGateway.enabled': true }), /Set image.tag/);
  assert.throws(() => render({ ...enabled, 'image.tag': '' }), /Set image.tag/);
  assert.throws(
    () => render({ ...enabled, 'image.tag': '', 'channelGateway.image.tag': 'v1.2.3' }),
    /Set image.tag/,
  );
  assert.throws(
    () => render({ ...enabled, 'channelGateway.channelId': '' }),
    /channelGateway.channelId/,
  );
  assert.throws(
    () => render({ ...enabled, 'global.librechat.existingSecretName': '' }),
    /existingSecretName/,
  );
  for (const overrides of [
    {},
    { 'librechat.configEnv.APP_TITLE': 'Example Agents' },
    { 'librechat.configEnv.APP_TITLE': 'é'.repeat(40) },
    { 'librechat.configEnv.APP_TITLE': '😀'.repeat(20) },
    { 'librechat.configEnv.APP_TITLE': '\ufeff  Example Agents  \ufeff' },
    { 'librechat.configEnv.APP_TITLE': 'x'.repeat(41), 'channelGateway.appTitle': 'Short Title' },
    {
      'librechat.configEnv.APP_TITLE': 'Example Agents',
      'channelGateway.appTitle': 'Custom Agents',
    },
    { fullnameOverride: 'a'.repeat(47) + '-channel-gateway' },
    { 'channelGateway.image.tag': 'a'.repeat(128) },
    { 'channelGateway.image.tag': '_custom_' },
    { 'image.tag': 'v1.2.3-rc1', 'service.port': '9090' },
    {
      'channelGateway.image.tag': 'v1.2.4',
      'channelGateway.existingSecretName': 'gateway-only',
      'channelGateway.slackAppTokenKey': '',
      fullnameOverride: 'a'.repeat(63),
    },
  ]) {
    const docs = render({ ...enabled, ...overrides });
    const deployment = docs.find(
      (doc) =>
        doc.kind === 'Deployment' &&
        doc.spec.template.spec.containers.some((container) => container.name === 'channel-gateway'),
    );
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
    const version =
      overrides['channelGateway.image.tag'] || overrides['image.tag'] || enabled['image.tag'];
    const labelVersion = version.slice(0, 63).replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
    assert.equal(deployment.metadata.labels['app.kubernetes.io/version'], labelVersion);
    assert.equal(pod.metadata.labels['app.kubernetes.io/version'], labelVersion);
    assert.equal(service.metadata.labels['app.kubernetes.io/version'], labelVersion);
    assert.equal(service.spec.type, 'ClusterIP');
    assert.equal(
      container.image,
      `ghcr.io/librechat-ai/librechat-channel-gateway:${overrides['channelGateway.image.tag'] || overrides['image.tag'] || enabled['image.tag']}`,
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
    assert.equal(
      env.APP_TITLE.value,
      (
        overrides['channelGateway.appTitle'] ||
        overrides['librechat.configEnv.APP_TITLE'] ||
        'LibreChat'
      ).trim(),
    );
    const runtime = loadConfig({
      CHANNEL_SERVICE_TOKEN: 'fixture',
      CHANNEL_TENANT_ID: '_',
      CHANNEL_ID: 'fixture',
      APP_TITLE: env.APP_TITLE.value,
    });
    assert.equal(
      runtime.APP_TITLE,
      env.APP_TITLE.value,
      'accepted Helm titles must satisfy the actual runtime schema',
    );
    assert.notEqual(deployment.metadata.name, mainService.metadata.name);
    assert.equal(Boolean(env.SLACK_APP_TOKEN), overrides['channelGateway.slackAppTokenKey'] !== '');
    assert.equal(container.livenessProbe.httpGet.path, '/livez');
    assert.equal(container.readinessProbe.httpGet.path, '/readyz');
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.equal(deployment.spec.strategy.type, 'Recreate');
  }
  for (const title of ['x'.repeat(41), '😀'.repeat(21), '<title>', 'a|b', '\u0085', '\ufeff']) {
    assert.throws(
      () => render(enabled, { librechat: { configEnv: { APP_TITLE: title } } }),
      /channelGateway.appTitle/,
    );
    assert.throws(
      () => render({ ...enabled, 'channelGateway.appTitle': title }),
      /channelGateway.appTitle/,
    );
  }
  assert.doesNotThrow(
    () => render({}, { librechat: { configEnv: { APP_TITLE: 'x'.repeat(41) } } }),
    'disabled gateways must not restrict the application title',
  );
  assert.throws(
    () => render({}, { channelGateway: { ingress: { enabled: true } } }),
    /Enable channelGateway/,
  );
  assert.throws(
    () => render(enabled, { channelGateway: { ingress: { enabled: true } } }),
    /ingress.host/,
  );
  assert.throws(
    () =>
      render(
        enabled,
        { channelGateway: { ingress: { enabled: true, host: 'gateway.example.test' } } },
        '1.18.20',
      ),
    /Kubernetes 1.19/,
  );
  const webhooks = render(enabled, {
    ingress: {
      enabled: true,
      className: 'platform-controller',
      annotations: { apiOnly: 'fixture' },
      hosts: [{ host: 'gateway.example.test', paths: [{ path: '/', pathType: 'Prefix' }] }],
    },
    channelGateway: {
      slackAppTokenKey: '',
      ingress: {
        enabled: true,
        host: 'gateway.example.test',
        annotations: { callback: 'fixture' },
        tls: [{ hosts: ['gateway.example.test'], secretName: 'gateway-tls' }],
      },
    },
  });
  const webhookDeployment = webhooks.find(
    (doc) =>
      doc.kind === 'Deployment' && doc.spec.template.spec.containers[0].name === 'channel-gateway',
  );
  const webhookIngress = webhooks.find(
    (doc) => doc.kind === 'Ingress' && doc.metadata.name === webhookDeployment.metadata.name,
  );
  const apiIngress = webhooks.find((doc) => doc.kind === 'Ingress' && doc !== webhookIngress);
  assert.equal(webhookIngress.spec.ingressClassName, 'platform-controller');
  assert.equal(webhookIngress.spec.tls[0].secretName, 'gateway-tls');
  assert.equal(
    webhookIngress.metadata.annotations.apiOnly,
    undefined,
    'API rewrite annotations must not alter gateway callbacks',
  );
  assert.deepEqual(
    webhookIngress.spec.rules[0].http.paths.map((route) => route.path),
    ['/slack/events', '/slack/interactions'],
  );
  for (const route of webhookIngress.spec.rules[0].http.paths) {
    assert.equal(route.pathType, 'Prefix');
    assert.equal(route.backend.service.name, webhookDeployment.metadata.name);
    assert.equal(route.backend.service.port.number, 8080);
    assert.notEqual(
      route.backend.service.name,
      apiIngress.spec.rules[0].http.paths[0].backend.service.name,
    );
  }
  assert(
    !webhookDeployment.spec.template.spec.containers[0].env.some(
      (entry) => entry.name === 'SLACK_APP_TOKEN',
    ),
  );
  const ownClass = render(enabled, {
    channelGateway: {
      ingress: { enabled: true, host: 'gateway.example.test', className: 'gateway-controller' },
    },
  }).find((doc) => doc.kind === 'Ingress');
  assert.equal(ownClass.spec.ingressClassName, 'gateway-controller');
  const platform = {
    serviceAccount: { create: false, name: 'workload-account' },
    enableServiceLinks: false,
    hostAliases: [{ ip: '127.0.0.2', hostnames: ['fixture.invalid'] }],
    dnsPolicy: 'ClusterFirst',
    dnsConfig: { options: [{ name: 'ndots', value: '2' }] },
    imagePullSecrets: [{ name: 'registry-credentials' }],
    nodeSelector: { 'kubernetes.io/os': 'linux' },
    tolerations: [{ key: 'dedicated', operator: 'Exists', effect: 'NoSchedule' }],
    affinity: { podAntiAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [] } },
    podAnnotations: { platform: 'fixture' },
    podLabels: { platform: 'fixture' },
    deploymentAnnotations: { platform: 'fixture' },
    deploymentLabels: { platform: 'fixture' },
    securityContext: { runAsUser: 10001 },
  };
  const deployments = render(enabled, platform).filter((doc) => doc.kind === 'Deployment');
  const gateway = deployments.find(
    (doc) => doc.spec.template.spec.containers[0].name === 'channel-gateway',
  );
  const app = deployments.find((doc) => doc !== gateway);
  const spec = gateway.spec.template.spec;
  for (const key of [
    'serviceAccountName',
    'enableServiceLinks',
    'hostAliases',
    'dnsPolicy',
    'dnsConfig',
    'imagePullSecrets',
    'nodeSelector',
    'tolerations',
    'affinity',
  ]) {
    assert.deepEqual(spec[key], app.spec.template.spec[key], `gateway must honor shared ${key}`);
    if (key !== 'serviceAccountName')
      assert.deepEqual(spec[key], platform[key], `configured ${key} must survive rendering`);
  }
  assert.equal(spec.serviceAccountName, 'workload-account');
  assert.equal(spec.enableServiceLinks, false);
  assert.equal(spec.containers[0].securityContext.runAsUser, 10001);
  assert.equal(spec.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(gateway.spec.template.metadata.annotations.platform, 'fixture');
  assert.equal(gateway.spec.template.metadata.labels.platform, 'fixture');
  assert.equal(gateway.metadata.annotations.platform, 'fixture');
  assert.equal(gateway.metadata.labels.platform, 'fixture');
  assert.equal(spec.containers[0].envFrom, undefined);
  const defaultGateway = render(enabled).find(
    (doc) =>
      doc.kind === 'Deployment' && doc.spec.template.spec.containers[0].name === 'channel-gateway',
  );
  assert.equal(defaultGateway.spec.template.spec.serviceAccountName, 'fixture-librechat');
  assert.equal(defaultGateway.spec.template.spec.enableServiceLinks, true);
  const clearedSecurity = render(enabled, { securityContext: null, podSecurityContext: null }).find(
    (doc) =>
      doc.kind === 'Deployment' && doc.spec.template.spec.containers[0].name === 'channel-gateway',
  );
  assert.equal(clearedSecurity.spec.template.spec.containers[0].securityContext.runAsUser, 1000);
  assert.deepEqual(
    clearedSecurity.spec.template.spec.containers[0].securityContext.capabilities.drop,
    ['ALL'],
  );
  assert.equal(
    app.metadata.labels['app.kubernetes.io/version'],
    metadata.appVersion,
    'existing application labels must remain unchanged',
  );
  console.log(
    'PASS: optional gateway rendering, image matching, secret isolation, selectors and probes',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
