import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

const readWorkflow = (file) =>
  yaml.load(readFileSync(new URL(`../workflows/${file}`, import.meta.url), 'utf8'));
const manual = readWorkflow('main-image-workflow.yml');
for (const workflow of [manual, readWorkflow('tag-images.yml')]) {
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
  const release = git('rev-parse', 'HEAD');
  git('tag', 'v1.2.3');
  git('commit', '--allow-empty', '-m', 'Unreleased main changes');
  assert.notEqual(git('rev-parse', 'HEAD'), release);
  git('tag', 'v1.3.0-rc1');
  git('remote', 'add', 'origin', fixture);

  const output = join(fixture, 'output');
  const resolve = manual.jobs['resolve-tag'].steps.find((step) => step.id === 'tag');
  execFileSync('bash', ['-e', '-c', resolve.run], {
    cwd: fixture,
    env: { ...process.env, GITHUB_OUTPUT: output },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const values = Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
  assert.equal(values.latest_tag, 'v1.2.3');
  assert.equal(values.sha, release, 'a stable version must not publish unreleased main code');
  assert.equal(manual.jobs.publish.with.checkout_ref, '${{ needs.resolve-tag.outputs.sha }}');
  assert.equal(
    manual.jobs.publish.with.build_branch,
    '${{ needs.resolve-tag.outputs.latest_tag }}',
  );
  console.log('PASS: release gateway targets and stable tag provenance with main ahead');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
