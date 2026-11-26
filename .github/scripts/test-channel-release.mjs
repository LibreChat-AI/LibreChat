import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

const readWorkflow = (file) =>
  yaml.load(readFileSync(new URL(`../workflows/${file}`, import.meta.url), 'utf8'));
const manual = readWorkflow('main-image-workflow.yml');
assert.ok(
  readWorkflow('retry-docker-builds.yml').on.workflow_run.workflows.includes(manual.name),
  'the retry workflow must subscribe to the manual release publisher by its current name',
);
for (const workflow of [readWorkflow('tag-images.yml')]) {
  const images = JSON.parse(workflow.jobs.publish.with.images);
  const gateway = images.find((image) => image.image_name === 'librechat-channel-gateway');
  assert.equal(gateway.file, 'packages/channel-gateway/Dockerfile');
  assert.equal(gateway.target, 'runtime');
}

const fixture = mkdtempSync(join(tmpdir(), 'channel-release-'));
try {
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: fixture,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Release fixture');
  git('commit', '--allow-empty', '-m', 'Stable release');
  let release = git('rev-parse', 'HEAD');
  git('tag', 'v1.2.3');
  git('commit', '--allow-empty', '-m', 'Unreleased main changes');
  assert.notEqual(git('rev-parse', 'HEAD'), release);
  git('tag', 'v1.3.0-rc1');
  git('remote', 'add', 'origin', fixture);

  const output = join(fixture, 'output');
  const resolve = manual.jobs['resolve-tag'].steps.find((step) => step.id === 'tag');
  function resolveRelease() {
    writeFileSync(output, '');
    execFileSync('bash', ['-e', '-c', resolve.run], {
      cwd: fixture,
      env: { ...process.env, GITHUB_OUTPUT: output },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    );
  }
  const old = resolveRelease();
  assert.equal(old.latest_tag, 'v1.2.3');
  assert.equal(old.sha, release);
  assert.equal(
    JSON.parse(old.images).length,
    2,
    'old releases must not attempt a missing gateway build',
  );

  mkdirSync(join(fixture, 'packages/channel-gateway'), { recursive: true });
  writeFileSync(join(fixture, 'packages/channel-gateway/Dockerfile'), 'FROM scratch AS runtime\n');
  git('add', '.');
  git('commit', '-m', 'Release with gateway');
  release = git('rev-parse', 'HEAD');
  git('tag', 'v1.2.4');
  git('commit', '--allow-empty', '-m', 'More unreleased main changes');
  const values = resolveRelease();
  assert.equal(values.latest_tag, 'v1.2.4');
  assert.equal(values.sha, release, 'a stable version must not publish unreleased main code');
  const gateway = JSON.parse(values.images).find(
    (image) => image.image_name === 'librechat-channel-gateway',
  );
  assert.equal(gateway.file, 'packages/channel-gateway/Dockerfile');
  assert.equal(gateway.target, 'runtime');
  assert.equal(manual.jobs.publish.with.images, '${{ needs.resolve-tag.outputs.images }}');
  assert.equal(manual.jobs.publish.with.checkout_ref, '${{ needs.resolve-tag.outputs.sha }}');
  assert.equal(
    manual.jobs.publish.with.build_branch,
    '${{ needs.resolve-tag.outputs.latest_tag }}',
  );
  console.log('PASS: release gateway targets and stable tag provenance with main ahead');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
