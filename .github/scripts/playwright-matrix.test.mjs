import yaml from 'js-yaml';
import { test } from 'node:test';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const workflow = yaml.load(
  readFileSync(new URL('../workflows/playwright-mock.yml', import.meta.url), 'utf8'),
);
const selector = workflow.jobs.codegraph_select.steps.find((step) => step.id === 'sel');
const shards = workflow.jobs.e2e_shards;
const defaults = [...shards.strategy.matrix.matchAll(/fromJSON\('([^']+)'\)/g)].map((match) =>
  JSON.parse(match[1]),
);
const prMatrix = JSON.parse(selector.env.FULL_INCLUDE);

function assertPartition(matrix, store, suite, count) {
  const lanes = matrix.include.filter(
    (lane) => lane.stream_store === store && lane.suite === suite,
  );
  assert.equal(lanes.length, count);
  assert.deepEqual(
    lanes.map((lane) => lane.shard),
    Array.from({ length: count }, (_, index) => `${index + 1}/${count}`),
  );
  assert.ok(
    lanes.every((lane) => lane.redis_image === (store === 'redis' ? 'redis:7-alpine' : '')),
  );
}

function select(t, response, overrides = {}) {
  const scratch = mkdtempSync(join(scriptsDir, '.playwright-matrix-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  writeFileSync(join(scratch, 'response.json'), JSON.stringify(response));
  writeFileSync(join(scratch, 'output'), '');
  writeFileSync(join(scratch, 'selector.sh'), selector.run);
  writeFileSync(
    join(scratch, 'gh'),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' \'{"path":"client/src/example.ts","status":"modified"}\'\nexit "${GH_EXIT:-0}"\n',
    { mode: 0o700 },
  );
  writeFileSync(
    join(scratch, 'curl'),
    '#!/usr/bin/env bash\ncat response.json\nexit "${CURL_EXIT:-0}"\n',
    { mode: 0o700 },
  );
  const result = spawnSync('bash', ['selector.sh'], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      PATH: `${scratch}:${process.env.PATH}`,
      FULL_INCLUDE: selector.env.FULL_INCLUDE,
      URL: 'https://selector.invalid',
      TOKEN: 'test-fixture',
      REPO: 'fixture/repo',
      PR: '1',
      BASE_SHA: 'base',
      HEAD_SHA: 'head',
      CHANGED: '1',
      E2E_SKIP_ARMED: '',
      GITHUB_OUTPUT: join(scratch, 'output'),
      GITHUB_STEP_SUMMARY: join(scratch, 'summary'),
      ...overrides,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const outputs = Object.fromEntries(
    readFileSync(join(scratch, 'output'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  return { outputs, matrix: outputs.e2e_include ? JSON.parse(outputs.e2e_include) : defaults[0] };
}

function decision(redis, mcp = true) {
  return { matrix: { 'playwright-mock': { redis_transport: redis, mcp_tool_list_changed: mcp } } };
}

test('PR selection and fail-open defaults use six memory shards and two Redis transport shards', () => {
  assert.equal(defaults.length, 2);
  assert.deepEqual(defaults[0], prMatrix);
  assert.equal(prMatrix.include.length, 8);
  assertPartition(prMatrix, 'memory', 'full', 6);
  assertPartition(prMatrix, 'redis', 'transport', 2);
});

test('nightly and default manual runs retain full-suite coverage on both stores', () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.coverage.default, 'full');
  assert.equal(defaults[1].include.length, 4);
  assertPartition(defaults[1], 'memory', 'full', 2);
  assertPartition(defaults[1], 'redis', 'full', 2);
});

test('manual PR coverage opts into the PR fallback matrix without bypassing the PR author gate', () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.coverage.options, ['full', 'pr']);
  assert.match(
    shards.strategy.matrix,
    /github\.event_name == 'pull_request' \|\| inputs\.coverage == 'pr'/,
  );
  assert.match(shards.if, /github\.event_name == 'workflow_dispatch'/);
  assert.match(shards.if, /github\.event\.pull_request\.author_association/);
});

test('every shard has a unique job name and artifact namespace', () => {
  for (const matrix of [prMatrix, ...defaults]) {
    for (const key of ['name', 'artifact']) {
      assert.equal(new Set(matrix.include.map((lane) => lane[key])).size, matrix.include.length);
    }
  }
});

test('both suite commands consume the matrix shard without increasing worker concurrency', () => {
  for (const suite of ['full', 'transport']) {
    const step = shards.steps.find((entry) => entry.if === `matrix.suite == '${suite}'`);
    assert.match(step.run, /--shard=\$\{\{ matrix\.shard \}\}/);
    assert.doesNotMatch(step.run, /--workers/);
  }
  const config = readFileSync(
    new URL('../../e2e/playwright.config.mock.ts', import.meta.url),
    'utf8',
  );
  assert.match(config, /workers: 1,/);
  assert.equal(shards['runs-on'], 'ubuntu-latest');
});

test('an explicit Redis skip drops both transport shards and no memory shard', (t) => {
  const { matrix, outputs } = select(t, decision(false, false));
  assert.equal(outputs.decided, 'true');
  assert.equal(outputs.mcp_run, 'false');
  assert.equal(matrix.include.length, 6);
  assertPartition(matrix, 'memory', 'full', 6);
});

test('missing or non-boolean Redis decisions retain both transport shards', (t) => {
  for (const redis of [true, 'false', null, undefined]) {
    const { matrix } = select(t, decision(redis));
    assert.deepEqual(matrix, prMatrix);
    assertPartition(matrix, 'redis', 'transport', 2);
  }
});

test('unavailable configuration, failed requests, and incomplete file lists fall back to the full PR matrix', (t) => {
  for (const overrides of [
    { URL: '' },
    { TOKEN: '' },
    { CURL_EXIT: '28' },
    { GH_EXIT: '1' },
    { CHANGED: '2' },
  ]) {
    const { matrix, outputs } = select(t, decision(false, false), overrides);
    assert.equal(outputs.e2e_include, undefined);
    assert.equal(outputs.mcp_run, undefined);
    assert.deepEqual(matrix, prMatrix);
  }
  const { matrix, outputs } = select(t, {});
  assert.equal(outputs.e2e_include, undefined);
  assert.deepEqual(matrix, prMatrix);
});

test('graduated spec skips keep the same pool across shards and remain opt-in', (t) => {
  const response = {
    ...decision(true),
    e2e: { fail_open: false, graduated: ['e2e/specs/mock/sidebar.spec.ts'] },
  };
  const dark = select(t, response);
  assert.equal(dark.outputs.e2e_skip, '');
  const armed = select(t, response, { E2E_SKIP_ARMED: 'on' });
  assert.equal(armed.outputs.e2e_skip, 'specs/mock/sidebar.spec.ts');
  assert.deepEqual(armed.matrix, prMatrix);
  const fallback = select(
    t,
    { ...response, e2e: { ...response.e2e, fail_open: true } },
    { E2E_SKIP_ARMED: 'on' },
  );
  assert.equal(fallback.outputs.e2e_skip, '');
  assert.deepEqual(fallback.matrix, prMatrix);
});

test('the required gate still waits for all shards and rejects failures without fighting cancellation', () => {
  const gate = workflow.jobs.e2e;
  assert.equal(gate.name, 'e2e');
  assert.deepEqual(gate.needs, ['codegraph_select', 'e2e_shards', 'mcp_tool_list_changed']);
  assert.equal(shards.strategy['fail-fast'], false);
  assert.match(gate.if, /!cancelled\(\)/);
  assert.match(shards.if, /!cancelled\(\)/);
  assert.match(gate.steps[0].if, /needs\.e2e_shards\.result != 'success'/);
  assert.match(gate.steps[0].if, /needs\.mcp_tool_list_changed\.result != 'success'/);
  assert.match(gate.steps[0].if, /needs\.codegraph_select\.outputs\.mcp_run == 'false'/);
  assert.equal(gate.steps[0].run, 'exit 1');
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
});
