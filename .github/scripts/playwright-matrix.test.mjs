import yaml from 'js-yaml';
import { test } from 'node:test';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { condition, interpolate } from './expressions.mjs';

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

const REPOSITORY = 'LibreChat-AI/LibreChat';
const event = (event_name, ref, payload = {}) => ({
  event_name,
  ref,
  repository: REPOSITORY,
  event: payload,
});
const pushToDev = event('push', 'refs/heads/dev');
const nightly = event('schedule', 'refs/heads/main');
const manual = event('workflow_dispatch', 'refs/heads/dev');
const pullRequest = (action, association = 'MEMBER', head = REPOSITORY) =>
  event('pull_request', 'refs/pull/1/merge', {
    action,
    pull_request: { author_association: association, head: { repo: { full_name: head } } },
  });

/** What the workflow's own expressions resolve to for one event, before any job has run. */
function resolve(github, { inputs = {}, select = {} } = {}) {
  const context = { github, inputs, vars: {}, needs: { codegraph_select: { outputs: select } } };
  const functions = { cancelled: () => false };
  const runs = (job) => condition(workflow.jobs[job].if, context, functions);
  return {
    jobs: {
      select: runs('codegraph_select'),
      shards: runs('e2e_shards'),
      mcp: runs('mcp_tool_list_changed'),
      apps: runs('mcp_apps'),
      gate: runs('e2e'),
    },
    matrix: interpolate(shards.strategy.matrix, context, functions),
    group: interpolate(workflow.concurrency.group, context, functions),
    cancels: interpolate(workflow.concurrency['cancel-in-progress'], context, functions),
  };
}

const everyLane = { select: true, shards: true, mcp: true, apps: true, gate: true };

/** True when the gate's only step runs, which is the step that fails the required check. */
function gateFails(results, mcpRun = '') {
  return condition(workflow.jobs.e2e.steps[0].if, {
    needs: {
      e2e_shards: { result: results.shards ?? 'success' },
      mcp_apps: { result: results.apps ?? 'success' },
      mcp_tool_list_changed: { result: results.mcp ?? 'success' },
      codegraph_select: { outputs: { mcp_run: mcpRun } },
    },
  });
}

test('PR selection and fail-open defaults use ten memory shards and two Redis transport shards', () => {
  assert.equal(defaults.length, 2);
  assert.deepEqual(defaults[0], prMatrix);
  assert.equal(prMatrix.include.length, 12);
  assertPartition(prMatrix, 'memory', 'full', 10);
  assertPartition(prMatrix, 'redis', 'transport', 2);
});

test('nightly and default manual runs retain full-suite coverage on both stores', () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.coverage.default, 'full');
  assert.equal(defaults[1].include.length, 20);
  assertPartition(defaults[1], 'memory', 'full', 10);
  assertPartition(defaults[1], 'redis', 'full', 10);
});

test('PR and nightly matrices preserve both registered-email change modes on one memory shard', () => {
  for (const matrix of [prMatrix, ...defaults]) {
    const emailLanes = matrix.include.filter((lane) => lane.email_change === 'true');
    assert.equal(emailLanes.length, 1);
    assert.equal(emailLanes[0].stream_store, 'memory');
    assert.match(emailLanes[0].shard, /^1\//);
  }
  assert.equal(
    shards.steps.filter((step) => step.if === "matrix.email_change == 'true'").length,
    2,
  );
});

test('manual PR coverage opts into the PR fallback matrix without bypassing the PR author gate', () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.coverage.options, ['full', 'pr']);
  assert.deepEqual(resolve(manual, { inputs: { coverage: 'pr' } }).matrix, prMatrix);
  assert.deepEqual(resolve(manual, { inputs: { coverage: 'full' } }).matrix, defaults[1]);
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
  const full = shards.steps.find((entry) => entry.if === "matrix.suite == 'full'");
  assert.match(full.run, /playwright-shards\.mjs plan[\s\S]*--shard '\$\{\{ matrix\.shard \}\}'/);
  assert.match(full.run, /--test-list=e2e\/\.generated\/shard-tests\.txt/);
  const transport = shards.steps.find((entry) => entry.if === "matrix.suite == 'transport'");
  assert.match(transport.run, /--shard=\$\{\{ matrix\.shard \}\}/);
  for (const step of [full, transport]) {
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
  assert.equal(matrix.include.length, 10);
  assertPartition(matrix, 'memory', 'full', 10);
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
  assert.deepEqual(gate.needs, [
    'codegraph_select',
    'e2e_shards',
    'mcp_tool_list_changed',
    'mcp_apps',
  ]);
  assert.equal(shards.strategy['fail-fast'], false);
  assert.match(gate.if, /!cancelled\(\)/);
  assert.match(shards.if, /!cancelled\(\)/);
  assert.match(gate.steps[0].if, /needs\.e2e_shards\.result != 'success'/);
  assert.match(gate.steps[0].if, /needs\.mcp_apps\.result != 'success'/);
  assert.match(gate.steps[0].if, /needs\.mcp_tool_list_changed\.result != 'success'/);
  assert.match(gate.steps[0].if, /needs\.codegraph_select\.outputs\.mcp_run == 'false'/);
  assert.equal(gate.steps[0].run, 'exit 1');
  assert.equal(resolve(pullRequest('synchronize')).cancels, true);
});

test('a push to dev runs every lane on the pull request matrix with nothing narrowed', () => {
  assert.deepEqual(workflow.on.push.branches, ['dev']);
  assert.deepEqual(workflow.on.push.paths, workflow.on.pull_request.paths);
  const { jobs, matrix } = resolve(pushToDev);
  assert.deepEqual(jobs, { ...everyLane, select: false });
  assert.deepEqual(matrix, prMatrix);
  assert.equal(gateFails({}), false);
  assert.equal(gateFails({ shards: 'failure' }), true);
  assert.equal(gateFails({ apps: 'failure' }), true);
  assert.equal(gateFails({ mcp: 'failure' }), true);
  /** No selector ran on a push, so a skipped MCP lane is a fault there, not a decision. */
  assert.equal(gateFails({ mcp: 'skipped' }), true);
  assert.equal(gateFails({ mcp: 'skipped' }, 'false'), false);
});

test('dev pushes never cancel each other and share no group with any other event', () => {
  const pushed = resolve(pushToDev);
  assert.equal(pushed.group, 'playwright-mock-post-merge-refs/heads/dev');
  assert.equal(pushed.cancels, false);
  const others = [pullRequest('opened'), pullRequest('synchronize'), nightly, manual].map(
    (github) => resolve(github),
  );
  assert.deepEqual(
    others.map(({ group }) => group),
    [
      'playwright-mock-refs/pull/1/merge',
      'playwright-mock-refs/pull/1/merge',
      'playwright-mock-refs/heads/main',
      'playwright-mock-refs/heads/dev',
    ],
  );
  assert.ok(others.every(({ cancels }) => cancels === true));
});

test('pull request, nightly and manual runs resolve as they did without the push trigger', () => {
  const opened = resolve(pullRequest('opened'));
  assert.deepEqual(opened.jobs, { ...everyLane, select: false });
  assert.deepEqual(opened.matrix, prMatrix);

  const memoryOnly = { include: prMatrix.include.filter((lane) => lane.suite === 'full') };
  const narrowed = resolve(pullRequest('synchronize'), {
    select: { e2e_include: JSON.stringify(memoryOnly), mcp_run: 'false' },
  });
  assert.deepEqual(narrowed.jobs, { ...everyLane, mcp: false });
  assert.deepEqual(narrowed.matrix, memoryOnly);

  const outsider = resolve(pullRequest('synchronize', 'CONTRIBUTOR', 'someone/LibreChat'));
  assert.deepEqual(outsider.jobs, {
    select: false,
    shards: false,
    mcp: false,
    apps: false,
    gate: false,
  });
  const sameRepositoryBot = resolve(pullRequest('opened', 'NONE'));
  assert.deepEqual(sameRepositoryBot.jobs, { ...everyLane, select: false });

  for (const github of [nightly, manual]) {
    const run = resolve(github);
    assert.deepEqual(run.jobs, { ...everyLane, select: false });
    assert.deepEqual(run.matrix, defaults[1]);
  }
});
