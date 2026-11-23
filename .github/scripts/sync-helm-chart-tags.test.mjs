import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'sync-helm-chart-tags.sh');
const CHART_PATH = 'helm/librechat/Chart.yaml';
const WORKFLOW_REFUSAL =
  'refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission';

/**
 * A real remote whose `update` hook refuses the listed tags with `refusal`, which is how GitHub
 * answers a workflow token that tags a commit holding workflow file changes. The registry and the
 * GitHub CLI are the only fakes.
 */
function setup(
  t,
  { refused = [], refusal = WORKFLOW_REFUSAL, published = [], registryStatus = '' },
) {
  const scratch = mkdtempSync(join(tmpdir(), 'sync-helm-chart-tags-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const origin = join(scratch, 'origin.git');
  const work = join(scratch, 'work');
  const bin = join(scratch, 'bin');
  const calls = join(scratch, 'calls');
  const registry = join(scratch, 'registry');
  const summary = join(scratch, 'summary');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    CALLS_PATH: calls,
    REGISTRY_PATH: registry,
    REGISTRY_STATUS: registryStatus,
    GITHUB_REPOSITORY: 'LibreChat-AI/LibreChat',
    GITHUB_STEP_SUMMARY: summary,
    GH_TOKEN: 'test',
    BACKFILL_FROM_VERSION: '1.0.0',
    DISPATCH_WORKFLOW: 'helmcharts.yml',
    PUSH_TAGS: 'true',
  };
  delete env.GITHUB_TOKEN;

  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
    return result.stdout.trim();
  };

  mkdirSync(bin);
  writeFileSync(calls, '');
  writeFileSync(registry, published.map((version) => `${version}\n`).join(''));
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS_PATH"
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
url="\${!#}"
case "$url" in
  */token\\?*) printf '{"token":"pull"}' ;;
  https://ghcr.io/v2/librechat-ai/librechat-chart/librechat/manifests/*)
    version="\${url##*/}"
    status=404
    if grep -Fqx "$version" "$REGISTRY_PATH"; then status=200; fi
    printf '%s' "\${REGISTRY_STATUS:-$status}"
    ;;
  *) echo "unexpected registry call: $url" >&2; exit 1 ;;
esac
`,
    { mode: 0o700 },
  );

  git(scratch, 'init', '--quiet', '--bare', '-b', 'main', origin);
  writeFileSync(
    join(origin, 'hooks', 'update'),
    `#!/usr/bin/env bash
case " ${refused.map((tag) => `refs/tags/${tag}`).join(' ')} " in
  *" $1 "*) echo ${JSON.stringify(refusal)} >&2; exit 1 ;;
esac
`,
    { mode: 0o700 },
  );

  git(scratch, 'init', '--quiet', '-b', 'main', work);
  git(work, 'remote', 'add', 'origin', origin);
  mkdirSync(dirname(join(work, CHART_PATH)), { recursive: true });
  const commits = {};
  for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
    writeFileSync(join(work, CHART_PATH), `name: librechat\nversion: ${version}\n`);
    git(work, 'add', CHART_PATH);
    git(work, 'commit', '--quiet', '-m', version);
    commits[version] = git(work, 'rev-parse', 'HEAD');
  }
  git(work, 'push', '--quiet', 'origin', 'main');
  git(work, 'fetch', '--quiet', 'origin');

  return {
    commits,
    summary,
    publish: (version) => appendFileSync(registry, `${version}\n`),
    sync: () => {
      const result = spawnSync('bash', [script], { cwd: work, env, encoding: 'utf8' });
      return {
        status: result.status,
        output: `${result.stdout}\n${result.stderr}`,
        dispatched: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
        remoteTags: git(origin, 'tag', '--list').split('\n').filter(Boolean),
      };
    },
  };
}

const dispatch = (tag, commit) =>
  `workflow run helmcharts.yml --repo LibreChat-AI/LibreChat --ref main -f chart_tag=${tag}` +
  (commit ? ` -f chart_sha=${commit}` : '');

test('a tag GitHub refuses does not block later versions and its chart is released from its commit', (t) => {
  const { commits, summary, sync } = setup(t, { refused: ['chart-1.1.0'] });
  const { status, output, dispatched, remoteTags } = sync();

  assert.equal(status, 0, output);
  assert.deepEqual(remoteTags, ['chart-1.0.0', 'chart-1.2.0']);
  assert.deepEqual(dispatched, [
    dispatch('chart-1.0.0'),
    dispatch('chart-1.1.0', commits['1.1.0']),
    dispatch('chart-1.2.0'),
  ]);

  const command = `git push origin ${commits['1.1.0']}:refs/tags/chart-1.1.0`;
  assert.match(output, /::warning::GitHub refused chart-1\.1\.0/);
  assert.ok(output.includes(command), output);
  assert.ok(readFileSync(summary, 'utf8').includes(command));
});

test('a refused tag whose chart is already published is not released again', (t) => {
  const { sync } = setup(t, { refused: ['chart-1.1.0'], published: ['1.1.0'] });
  const { status, output, dispatched, remoteTags } = sync();

  assert.equal(status, 0, output);
  assert.deepEqual(remoteTags, ['chart-1.0.0', 'chart-1.2.0']);
  assert.deepEqual(dispatched, [dispatch('chart-1.0.0'), dispatch('chart-1.2.0')]);
  assert.match(output, /::warning::GitHub refused chart-1\.1\.0/);
});

test('the next sync asks for the refused tag again without releasing its chart twice', (t) => {
  const { commits, publish, sync } = setup(t, { refused: ['chart-1.1.0'] });
  const first = sync();
  publish('1.1.0');
  const second = sync();

  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /::warning::GitHub refused chart-1\.1\.0/);
  assert.deepEqual(second.dispatched, first.dispatched);
  assert.deepEqual(second.dispatched, [
    dispatch('chart-1.0.0'),
    dispatch('chart-1.1.0', commits['1.1.0']),
    dispatch('chart-1.2.0'),
  ]);
});

test('a push that fails for any other reason still fails the sync', (t) => {
  const { sync } = setup(t, { refused: ['chart-1.1.0'], refusal: 'pre-receive hook declined' });
  const { status, output, dispatched, remoteTags } = sync();

  assert.equal(status, 1, output);
  assert.match(output, /::error::Failed to push chart-1\.1\.0/);
  assert.deepEqual(remoteTags, ['chart-1.0.0']);
  assert.deepEqual(dispatched, [dispatch('chart-1.0.0')]);
});

test('a registry outage is not read as an unpublished chart', (t) => {
  const { summary, sync } = setup(t, { refused: ['chart-1.1.0'], registryStatus: '503' });
  const { status, output, dispatched } = sync();

  assert.equal(status, 1, output);
  assert.match(output, /::error::Unexpected status 503 from ghcr\.io/);
  assert.deepEqual(dispatched, [dispatch('chart-1.0.0')]);
  assert.equal(existsSync(summary), false);
});
