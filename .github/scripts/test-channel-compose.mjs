import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'channel-compose-'));
for (const file of [
  'docker-compose.yml',
  'docker-compose.channels.yml',
  'docker-compose.channels-build.yml',
  'docker-compose.mongo-replica.yml',
  '.env.example',
]) {
  copyFileSync(join(root, file), join(fixture, file));
}
copyFileSync(join(root, '.env.example'), join(fixture, '.env'));
process.on('exit', () => rmSync(fixture, { recursive: true, force: true }));

function configuration(tag, source = false) {
  const files = ['docker-compose.yml', 'docker-compose.channels.yml'];
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
        env: { ...process.env, UID: '1000', GID: '1000', LIBRECHAT_IMAGE_TAG: tag },
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
