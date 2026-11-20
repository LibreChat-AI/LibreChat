import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'channel-compose-'));
for (const file of [
  'docker-compose.yml',
  'docker-compose.channels.yml',
  'docker-compose.slack-workspaces.yml',
  'docker-compose.channels-build.yml',
  'docker-compose.mongo-replica.yml',
  '.env.example',
]) {
  copyFileSync(join(root, file), join(fixture, file));
}
copyFileSync(join(root, '.env.example'), join(fixture, '.env'));
process.on('exit', () => rmSync(fixture, { recursive: true, force: true }));

function configuration(tag, source = false, shared = false, gatewayPort) {
  const files = ['docker-compose.yml', 'docker-compose.channels.yml'];
  if (shared) files.push('docker-compose.slack-workspaces.yml');
  if (source) {
    files.push('docker-compose.channels-build.yml');
  }
  files.push('docker-compose.mongo-replica.yml');
  return JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '--env-file',
        '.env.example',
        ...files.flatMap((file) => ['-f', file]),
        '--profile',
        'channels',
        'config',
        '--format',
        'json',
      ],
      {
        cwd: fixture,
        encoding: 'utf8',
        env: {
          ...process.env,
          UID: '1000',
          GID: '1000',
          PORT: '3080',
          LIBRECHAT_IMAGE_TAG: tag,
          SLACK_APP_ID: 'A123',
          SLACK_CLIENT_ID: '123.456',
          SLACK_CLIENT_SECRET: 'fixture-client-secret',
          SLACK_SIGNING_SECRET: 'fixture-signature',
          SLACK_GATEWAY_URL: 'https://slack.example.test',
          CHANNEL_ID: 'legacy-connection',
          CHANNEL_TENANT_ID: 'org.a',
          SLACK_APP_TOKEN: 'xapp-fixture',
          CHANNEL_GATEWAY_PORT: gatewayPort ?? '',
        },
      },
    ),
  ).services;
}

for (const tag of ['', 'v1.2.3-rc1', 'v1.2.3']) {
  const services = configuration(tag);
  assert.equal(services.api.image, `ghcr.io/librechat-ai/librechat:${tag || 'latest'}`);
  assert.equal(
    services['channel-gateway'].image,
    `ghcr.io/librechat-ai/librechat-channel-gateway:${tag || 'latest'}`,
  );
  assert.equal(services.api.build, undefined);
  assert.equal(services['channel-gateway'].build, undefined);
  assert.equal(services.api.depends_on['mongodb-init'].condition, 'service_completed_successfully');
  assert.equal(services['channel-gateway'].depends_on.api.condition, 'service_healthy');
  assert.deepEqual(services['channel-gateway'].profiles, ['channels']);
  assert.equal(services['channel-gateway'].ports, undefined);
}

const source = configuration('v1.2.3-rc1', true);
assert.equal(source.api.image, 'librechat-channels-api:local');
assert.equal(source.api.build.dockerfile, 'Dockerfile');
assert.equal(source['channel-gateway'].image, 'librechat-channel-gateway:local');
assert.equal(source['channel-gateway'].build.dockerfile, 'packages/channel-gateway/Dockerfile');
assert.equal(source.api.pull_policy, 'build');
assert.equal(source['channel-gateway'].pull_policy, 'build');
console.log('PASS: release tags match, releases need no build, source builds remain explicit');

for (const source of [false, true]) {
  const shared = configuration('v1.2.3-rc1', source, true);
  assert.equal(shared.api.environment.SLACK_WORKSPACES_ENABLED, 'true');
  assert.equal(shared.api.environment.SLACK_GATEWAY_URL, 'https://slack.example.test');
  const gateway = shared['channel-gateway'];
  for (const name of [
    'SLACK_APP_ID',
    'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET',
    'SLACK_SIGNING_SECRET',
  ]) {
    assert.equal(shared.api.environment[name], undefined, `${name} is configured in the UI`);
    assert.equal(gateway.environment[name], undefined, `${name} is configured in the UI`);
  }
  assert.equal(gateway.environment.CHANNEL_ID, '');
  assert.equal(gateway.environment.CHANNEL_TENANT_ID, '_');
  assert.equal(gateway.environment.SLACK_APP_TOKEN, '');
  assert.equal(gateway.depends_on.api.condition, 'service_healthy');
  assert.deepEqual(gateway.ports, [
    {
      mode: 'ingress',
      host_ip: '127.0.0.1',
      target: 8080,
      published: '3081',
      protocol: 'tcp',
    },
  ]);
}
assert.equal(
  configuration('v1.2.3', false, true, '3999')['channel-gateway'].ports[0].published,
  '3999',
);
console.log('PASS: shared Compose needs no app credentials and clears all bound-gateway settings');

// Run the shipped healthcheck against an API that listens before initialization completes.
let ready = false;
const server = createServer((req, res) => {
  res.writeHead(req.url === '/health' || (req.url === '/readyz' && ready) ? 200 : 503);
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const { port } = server.address();
  const [kind, command, flag, script] = configuration('').api.healthcheck.test;
  assert.equal(kind, 'CMD');
  assert.equal(command, 'node');
  assert.equal(flag, '-e');
  const probe = () =>
    promisify(execFile)(process.execPath, [
      flag,
      script.replace('127.0.0.1:3080', `127.0.0.1:${port}`),
    ]);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  await assert.rejects(probe(), { code: 1 });
  ready = true;
  await probe();
  console.log('PASS: gateway dependency stays unhealthy until API readiness succeeds');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
