import yaml from 'js-yaml';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { condition, interpolate } from './expressions.mjs';
import { SUITES, plan, stale, supersede, verify } from './merge-gate.mjs';

const REPO = 'LibreChat-AI/LibreChat';
const workflowsDir = new URL('../workflows/', import.meta.url);
const load = (file) => yaml.load(readFileSync(new URL(file, workflowsDir), 'utf8'));
const workflows = Object.fromEntries(
  readdirSync(workflowsDir)
    .filter((file) => file.endsWith('.yml'))
    .map((file) => [file, load(file)]),
);

const unwrap = (text) =>
  String(text)
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
const STATUS_FUNCTION = /\b(?:always|cancelled|success|failure)\(/;

/** The status functions as GitHub resolves them for a job with these `needs`, in a live run. */
function statusOf(needs) {
  const results = Object.values(needs).map((job) => job.result);
  return {
    always: () => true,
    cancelled: () => false,
    success: () => results.every((result) => result === 'success'),
    failure: () => results.includes('failure'),
  };
}

const needsOf = (job) => [job.needs ?? []].flat();

/**
 * Resolves which jobs of a workflow run for one event, assuming every job that runs succeeds
 * unless `forced` gives it another result. `outputs` supplies job outputs (the codegraph
 * decision). Returns each job's result plus the Playwright matrix when the workflow has one.
 */
function simulate(workflow, github, { outputs = {}, forced = {}, inputs = {}, vars = {} } = {}) {
  const jobs = {};
  const context = { github: { repository: REPO, ...github }, inputs, vars };
  const resolve = (id) => {
    if (jobs[id]) return jobs[id];
    const job = workflow.jobs[id];
    const needs = Object.fromEntries(needsOf(job).map((need) => [need, resolve(need)]));
    const scope = { ...context, needs };
    const functions = statusOf(needs);
    const written = job.if === undefined ? 'success()' : unwrap(job.if);
    const guarded = STATUS_FUNCTION.test(written) ? written : `success() && (${written})`;
    const runs = condition(guarded, scope, functions);
    const result = runs ? (forced[id] ?? 'success') : 'skipped';
    jobs[id] = { result, outputs: result === 'success' ? (outputs[id] ?? {}) : {} };
    if (runs && typeof job.strategy?.matrix === 'string') {
      jobs[id].matrix = interpolate(job.strategy.matrix, scope, functions);
    }
    return jobs[id];
  };
  Object.keys(workflow.jobs).forEach(resolve);
  return jobs;
}

/** Whether a workflow's gate lets the simulated run through. A skipped check counts as passed. */
function gatePasses(suite, jobs) {
  const [id, gate] = gateOf(suite);
  if (jobs[id].result !== 'success') return jobs[id].result === 'skipped';
  const needs = Object.fromEntries(
    needsOf(gate).map((need) => [need, { result: jobs[need].result, outputs: jobs[need].outputs }]),
  );
  const functions = statusOf(needs);
  const step = gate.steps.at(-1);
  if (step.run === 'exit 1') {
    return !condition(step.if, { needs }, functions);
  }
  assert.equal(step.run, 'node .github/scripts/merge-gate.mjs verify');
  assert.equal(step.env.NEEDS, '${{ toJSON(needs) }}');
  const allowed = String(interpolate(step.env.ALLOW_SKIPPED ?? '', { needs }, functions));
  return (
    verify(JSON.parse(JSON.stringify(needs)), allowed.split(/\s+/).filter(Boolean)).length === 0
  );
}

function gateOf(suite) {
  const entries = Object.entries(workflows[suite.workflow].jobs).filter(
    ([, job]) => job.name === suite.context,
  );
  assert.equal(entries.length, 1, `${suite.workflow} needs exactly one job named ${suite.context}`);
  return entries[0];
}

const member = { author_association: 'MEMBER', head: { repo: { full_name: REPO } } };
const outsider = {
  author_association: 'CONTRIBUTOR',
  head: { repo: { full_name: 'fork/LibreChat' } },
};
const pullRequest = (action, pull_request = member) => ({
  event_name: 'pull_request',
  event: { action, pull_request },
});
const mergeGroup = (
  entry = 'pr-104-929f8209d40f77f4abc622a499c93a83babdbe64',
  sha = 'a'.repeat(40),
) => ({
  event_name: 'merge_group',
  ref: `refs/heads/gh-readonly-queue/dev/${entry}`,
  sha,
  event: {
    action: 'checks_requested',
    merge_group: {
      head_ref: `refs/heads/gh-readonly-queue/dev/${entry}`,
      base_ref: 'refs/heads/dev',
    },
  },
});
const SELECT = 'codegraph_select';
const ran = (jobs) => Object.keys(jobs).filter((id) => jobs[id].result === 'success');
const skipped = (jobs) => Object.keys(jobs).filter((id) => jobs[id].result === 'skipped');

test('every gated workflow starts for a merge group and closes in one gate over all of its jobs', () => {
  for (const suite of SUITES) {
    const workflow = workflows[suite.workflow];
    assert.ok(workflow, `${suite.workflow} is missing`);
    assert.deepEqual(workflow.on.merge_group, { types: ['checks_requested'] }, suite.workflow);
    const [id, gate] = gateOf(suite);
    const others = Object.keys(workflow.jobs).filter((job) => job !== id);
    assert.deepEqual([...needsOf(gate)].sort(), others.sort(), `${suite.workflow} gate needs`);
    assert.match(unwrap(gate.if), /^\s*!cancelled\(\)/, `${suite.workflow} gate condition`);
    for (const [job, definition] of Object.entries(workflow.jobs)) {
      assert.notEqual(
        definition['continue-on-error'],
        true,
        `${suite.workflow} ${job} would report success to the gate after failing`,
      );
    }
  }
});

test('an artifact upload can fail a gated job only when another job downloads the artifact', () => {
  const runs = (step, action) => step.uses?.startsWith(`actions/${action}-artifact@`);
  for (const suite of SUITES) {
    const steps = Object.entries(workflows[suite.workflow].jobs).flatMap(([job, definition]) =>
      definition.steps.map((step) => ({ job, step })),
    );
    const downloaded = new Set(
      steps.filter(({ step }) => runs(step, 'download')).map(({ step }) => step.with.name),
    );
    for (const { job, step } of steps.filter(({ step }) => runs(step, 'upload'))) {
      const label = `${suite.workflow} ${job} uploads ${step.with.name}`;
      if (downloaded.has(step.with.name)) {
        assert.equal(step['continue-on-error'], undefined, `${label}, which a later job needs`);
        continue;
      }
      assert.equal(step['continue-on-error'], true, `${label}, which no job downloads`);
      assert.ok(step['timeout-minutes'] > 0, `${label} without a bound on a stalled upload`);
    }
  }
});

test('a required context is the name of exactly one gate job and of nothing else', () => {
  const contexts = SUITES.map((suite) => suite.context);
  assert.equal(new Set(contexts).size, contexts.length);
  const owners = contexts.map((context) =>
    Object.entries(workflows).flatMap(([file, workflow]) =>
      Object.values(workflow.jobs)
        .filter((job) => job.name === context)
        .map(() => file),
    ),
  );
  assert.deepEqual(
    owners,
    SUITES.map((suite) => [suite.workflow]),
  );
});

test('a merge group runs every job in full and only the codegraph selector is skipped', () => {
  for (const suite of SUITES) {
    const workflow = workflows[suite.workflow];
    const jobs = simulate(workflow, mergeGroup(), {
      outputs: { [SELECT]: { api_run: 'false', client_run: 'false', mcp_run: 'false' } },
    });
    assert.deepEqual(skipped(jobs), SELECT in workflow.jobs ? [SELECT] : [], suite.workflow);
    assert.equal(gatePasses(suite, jobs), true, suite.workflow);
  }
});

test('a merge group gate fails when any job fails, is cancelled or is skipped', () => {
  for (const suite of SUITES) {
    const workflow = workflows[suite.workflow];
    const [gate] = gateOf(suite);
    const required = Object.keys(workflow.jobs).filter((id) => id !== gate && id !== SELECT);
    assert.ok(required.length > 0, suite.workflow);
    for (const id of required) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        const jobs = simulate(workflow, mergeGroup(), { forced: { [id]: result } });
        jobs[id].result = result;
        assert.equal(gatePasses(suite, jobs), false, `${suite.workflow} ${id} ${result}`);
      }
    }
  }
});

test('the Playwright merge group matrix is the pull request profile with no lane narrowed', () => {
  const workflow = workflows['playwright-mock.yml'];
  const selector = workflow.jobs[SELECT].steps.find((step) => step.id === 'sel');
  const profile = JSON.parse(selector.env.FULL_INCLUDE);
  const queued = simulate(workflow, mergeGroup());
  assert.deepEqual(queued.e2e_shards.matrix, profile);
  assert.equal(profile.include.length, 12);
  assert.deepEqual(ran(queued).sort(), ['e2e', 'e2e_shards', 'mcp_apps', 'mcp_tool_list_changed']);
  const opened = simulate(workflow, pullRequest('opened'));
  assert.deepEqual(opened.e2e_shards.matrix, profile);
  const nightly = simulate(workflow, { event_name: 'schedule', event: {} });
  assert.equal(nightly.e2e_shards.matrix.include.length, 20);
});

test('pull request runs keep their selection: full when opened, narrowed on synchronize', () => {
  const backend = workflows['backend-review.yml'];
  const suite = SUITES.find((entry) => entry.workflow === 'backend-review.yml');
  const opened = simulate(backend, pullRequest('opened'));
  assert.deepEqual(skipped(opened), [SELECT]);
  assert.equal(gatePasses(suite, opened), true);

  const decision = { [SELECT]: { decided: 'true', api_run: 'false', pkgapi_run: 'true' } };
  const narrowed = simulate(backend, pullRequest('synchronize'), { outputs: decision });
  assert.deepEqual(skipped(narrowed), ['test-api']);
  assert.equal(gatePasses(suite, narrowed), true);

  const undecided = simulate(backend, pullRequest('synchronize'));
  undecided['test-api'].result = 'skipped';
  assert.equal(gatePasses(suite, undecided), false);

  const killed = simulate(backend, pullRequest('synchronize'), {
    outputs: decision,
    vars: { CODEGRAPH_GATING: 'off' },
  });
  assert.deepEqual(skipped(killed), [SELECT]);

  const frontend = workflows['frontend-review.yml'];
  const frontendSuite = SUITES.find((entry) => entry.workflow === 'frontend-review.yml');
  const trimmed = simulate(frontend, pullRequest('synchronize'), {
    outputs: { [SELECT]: { client_run: 'false', clientpkg_run: 'false' } },
  });
  assert.deepEqual(skipped(trimmed), ['test-packages-client', 'test-ubuntu']);
  assert.equal(gatePasses(frontendSuite, trimmed), true);
});

test('a failing job fails the pull request gate, which still runs to report it', () => {
  for (const suite of SUITES) {
    const workflow = workflows[suite.workflow];
    const [gate] = gateOf(suite);
    const first = Object.keys(workflow.jobs).find((id) => id !== gate && id !== SELECT);
    const jobs = simulate(workflow, pullRequest('opened'), { forced: { [first]: 'failure' } });
    assert.equal(jobs[gate].result, 'success', `${suite.workflow} gate must still run`);
    assert.equal(gatePasses(suite, jobs), false, suite.workflow);
  }
});

test('push and manual runs still succeed job by job, as main promotion requires', () => {
  const events = {
    push: { event_name: 'push', event: {} },
    workflow_dispatch: { event_name: 'workflow_dispatch', event: {} },
  };
  for (const file of ['backend-review.yml', 'frontend-review.yml']) {
    const suite = SUITES.find((entry) => entry.workflow === file);
    for (const [name, github] of Object.entries(events)) {
      assert.ok(name in workflows[file].on, `${file} ${name}`);
      const jobs = simulate(workflows[file], github);
      assert.deepEqual(skipped(jobs), [SELECT], `${file} ${name}`);
      assert.equal(gatePasses(suite, jobs), true, `${file} ${name}`);
    }
  }
});

test('Playwright still skips outside contributors on pull requests and reports that as a skip', () => {
  const workflow = workflows['playwright-mock.yml'];
  const jobs = simulate(workflow, pullRequest('opened', outsider));
  assert.deepEqual(ran(jobs), []);
  assert.equal(
    gatePasses(
      SUITES.find((suite) => suite.context === 'e2e'),
      jobs,
    ),
    true,
  );
  assert.deepEqual(ran(simulate(workflow, mergeGroup())).includes('e2e_shards'), true);
});

test('merge group runs never share a concurrency group across queue entries', () => {
  const first = mergeGroup('pr-104-929f8209d40f77f4abc622a499c93a83babdbe64', 'a'.repeat(40));
  const second = mergeGroup('pr-105-2ffea6db159f6b6c47a24e778fb9ef40cf6b1c7d', 'b'.repeat(40));
  const groups = new Set();
  const files = [...SUITES.map((suite) => suite.workflow), 'merge-gate.yml'];
  for (const file of files) {
    const { concurrency, name } = workflows[file];
    const group = (github) =>
      interpolate(concurrency.group, { github: { workflow: name, ...github } }, statusOf({}));
    assert.notEqual(group(first), group(second), file);
    assert.equal(group(first), group(mergeGroup()), `${file} re-created group`);
    for (const github of [first, second]) {
      assert.equal(groups.has(group(github)), false, `${file} shares a group`);
      groups.add(group(github));
    }
    const pull = { ...pullRequest('synchronize'), ref: 'refs/pull/7/merge', sha: 'c'.repeat(40) };
    pull.event.pull_request = { ...member, number: 7 };
    assert.equal(groups.has(group(pull)), false, `${file} pull request group`);
  }
});

test('static checks read the merge group base wherever they read the pull request base', () => {
  const text = readFileSync(new URL('static-checks.yml', workflowsDir), 'utf8');
  const reads = text.match(/jq --raw-output .*GITHUB_EVENT_PATH.*/g);
  assert.ok(reads.length > 0);
  for (const read of reads) {
    assert.match(read, /'\.pull_request\.base\.sha \/\/ \.merge_group\.base_sha'/);
  }
});

test('the companion workflow reports a context only for a suite that did not start', () => {
  const workflow = workflows['merge-gate.yml'];
  assert.deepEqual(Object.keys(workflow.on).sort(), ['merge_group', 'pull_request']);
  assert.equal(workflow.on.pull_request, null);
  const { plan: planner, placeholder, supersede } = workflow.jobs;
  assert.equal(placeholder.name, '${{ matrix.context }}');
  assert.equal(placeholder.strategy.matrix.context, '${{ fromJSON(needs.plan.outputs.contexts) }}');
  assert.equal(planner.outputs.contexts, '${{ steps.plan.outputs.contexts }}');

  const pull = simulate(workflow, pullRequest('opened'), {
    outputs: { plan: { contexts: '["backend","static"]' } },
  });
  assert.deepEqual(ran(pull).sort(), ['placeholder', 'plan']);
  const none = simulate(workflow, pullRequest('opened'), { outputs: { plan: { contexts: '[]' } } });
  assert.deepEqual(ran(none), ['plan']);
  const failed = simulate(workflow, pullRequest('opened'), { forced: { plan: 'failure' } });
  assert.deepEqual(skipped(failed).sort(), ['placeholder', 'supersede']);
  const queued = simulate(workflow, mergeGroup());
  assert.deepEqual(ran(queued), ['supersede']);
  assert.deepEqual(supersede.permissions, { contents: 'read', actions: 'write' });
  assert.deepEqual(planner.permissions, { contents: 'read', actions: 'read' });
});

test('verify passes success and listed skips only', () => {
  const ok = { result: 'success', outputs: {} };
  const skip = { result: 'skipped', outputs: {} };
  assert.deepEqual(verify({ build: ok, test: ok }), []);
  assert.deepEqual(verify({ build: ok, select: skip }, ['select']), []);
  assert.deepEqual(verify({ build: ok, select: skip }), ['select: skipped']);
  assert.deepEqual(
    verify({ build: { result: 'failure' }, test: skip, lint: { result: 'cancelled' } }, ['test']),
    ['build: failure', 'lint: cancelled'],
  );
  assert.deepEqual(verify({ build: { result: 'neutral' } }), ['build: neutral']);
  assert.throws(() => verify({}), /No job results/);
  assert.throws(() => verify(null), /No job results/);
  assert.throws(() => verify({ build: ok }, ['tests']), /does not depend on: tests/);
});

test('plan reports the suites GitHub did not start and waits for late runs', async () => {
  const sleeps = [];
  const sleep = async (ms) => sleeps.push(ms);
  const polls = {};
  const started = (answers) => async (workflow) => {
    polls[workflow] = (polls[workflow] ?? 0) + 1;
    const answer = answers[workflow] ?? true;
    const value = Array.isArray(answer)
      ? answer[Math.min(polls[workflow], answer.length) - 1]
      : answer;
    if (value instanceof Error) throw value;
    return value;
  };

  assert.deepEqual(await plan({ started: started({}), sleep }), []);
  assert.deepEqual(sleeps, []);

  const docsOnly = Object.fromEntries(SUITES.map((suite) => [suite.workflow, false]));
  assert.deepEqual(
    await plan({ started: started(docsOnly), sleep }),
    SUITES.map((suite) => suite.context),
  );
  assert.deepEqual(sleeps, [10_000, 10_000]);

  Object.keys(polls).forEach((key) => delete polls[key]);
  const late = { 'backend-review.yml': [false, true], 'static-checks.yml': false };
  assert.deepEqual(await plan({ started: started(late), sleep }), ['static']);
  assert.equal(polls['backend-review.yml'], 2);
  assert.equal(polls['static-checks.yml'], 3);
  assert.equal(polls['frontend-review.yml'], 1);

  Object.keys(polls).forEach((key) => delete polls[key]);
  const flaky = { 'backend-review.yml': [new Error('HTTP 502'), true] };
  assert.deepEqual(await plan({ started: started(flaky), sleep }), []);

  Object.keys(polls).forEach((key) => delete polls[key]);
  const down = { 'backend-review.yml': new Error('HTTP 502') };
  await assert.rejects(plan({ started: started(down), sleep }), /HTTP 502/);
});

const queueRun = (id, head_branch, overrides = {}) => ({
  id,
  head_branch,
  event: 'merge_group',
  created_at: '2026-11-11T11:50:00Z',
  ...overrides,
});

test('stale finds only active merge group runs whose queue branch is gone', async () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const current = 'gh-readonly-queue/dev/pr-9-new';
  const runs = [
    queueRun(1, 'gh-readonly-queue/dev/pr-9-old'),
    queueRun(2, 'gh-readonly-queue/dev/pr-9-old'),
    queueRun(3, 'gh-readonly-queue/dev/pr-8-live'),
    queueRun(4, current),
    queueRun(5, 'gh-readonly-queue/dev/pr-7-unknown'),
    queueRun(6, 'gh-readonly-queue/dev/pr-6-fresh', { created_at: '2026-11-11T11:59:30Z' }),
    queueRun(7, 'dev', { event: 'push' }),
    queueRun(8, 'feature/gh-readonly-queue/dev/pr-5'),
    queueRun(9, null),
    queueRun(10, 'gh-readonly-queue/dev/pr-4-live', { created_at: '2026-11-11T11:59:50Z' }),
  ];
  const lookups = [];
  const exists = async (branch) => {
    lookups.push(branch);
    if (branch.endsWith('unknown')) throw new Error('HTTP 500');
    return branch === current || branch.endsWith('live');
  };
  const { cancel, recheck } = await stale({ runs, current, exists, now });
  assert.deepEqual(
    cancel.map((entry) => entry.id),
    [1, 2],
  );
  assert.deepEqual(
    recheck.map((entry) => entry.id),
    [6],
  );
  assert.deepEqual(lookups.sort(), [
    'gh-readonly-queue/dev/pr-4-live',
    'gh-readonly-queue/dev/pr-6-fresh',
    'gh-readonly-queue/dev/pr-7-unknown',
    'gh-readonly-queue/dev/pr-8-live',
    current,
    'gh-readonly-queue/dev/pr-9-old',
  ]);
  assert.deepEqual(await stale({ runs: [], current, exists, now }), { cancel: [], recheck: [] });

  const nothing = { cancel: [], recheck: [] };
  const allMissing = async () => false;
  const failing = async () => {
    throw new Error('HTTP 503');
  };
  assert.deepEqual(await stale({ runs, current, exists: allMissing, now }), nothing);
  assert.deepEqual(await stale({ runs, current, exists: failing, now }), nothing);
  assert.deepEqual(await stale({ runs, current: undefined, exists: allMissing, now }), nothing);
});

test('supersede cancels each stale run once and revisits runs that were too young', async () => {
  const current = 'gh-readonly-queue/dev/pr-9-new';
  const old = queueRun(1, 'gh-readonly-queue/dev/pr-9-old');
  const fresh = queueRun(2, 'gh-readonly-queue/dev/pr-8-fresh', {
    created_at: '2026-11-11T11:59:40Z',
  });
  const reborn = queueRun(3, 'gh-readonly-queue/dev/pr-7-back', {
    created_at: '2026-11-11T11:59:45Z',
  });
  const live = queueRun(4, 'gh-readonly-queue/dev/pr-6-live');
  const harness = (runs, missing) => {
    const state = { time: Date.parse('2026-11-11T12:00:00Z'), lists: 0, sleeps: [], cancelled: [] };
    const options = {
      current,
      list: async () => {
        state.lists += 1;
        return runs;
      },
      exists: async (branch) => branch === current || !missing(branch),
      cancel: async (run) => {
        state.cancelled.push(run.id);
        return `cancelled ${run.id}`;
      },
      sleep: async (ms) => {
        state.sleeps.push(ms);
        state.time += ms;
      },
      clock: () => state.time,
    };
    return { state, options };
  };

  const settled = harness([old, live], (branch) => branch.endsWith('old'));
  assert.deepEqual(await supersede(settled.options), ['cancelled 1']);
  assert.deepEqual([settled.state.lists, settled.state.sleeps], [1, []]);

  const lookups = {};
  const mixed = harness([old, fresh, reborn, live], (branch) => {
    lookups[branch] = (lookups[branch] ?? 0) + 1;
    if (branch.endsWith('back')) return lookups[branch] === 1;
    return !branch.endsWith('live');
  });
  assert.deepEqual(await supersede(mixed.options), ['cancelled 1', 'cancelled 2']);
  assert.deepEqual(mixed.state.cancelled, [1, 2]);
  assert.deepEqual([mixed.state.lists, mixed.state.sleeps], [2, [60_000]]);
});

test('the verify command exits non-zero unless the gate passes', () => {
  const script = fileURLToPath(new URL('./merge-gate.mjs', import.meta.url));
  const run = (env) =>
    spawnSync(process.execPath, [script, 'verify'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });
  const needs = {
    build: { result: 'success', outputs: {} },
    select: { result: 'skipped', outputs: {} },
  };
  const passed = run({ NEEDS: JSON.stringify(needs), ALLOW_SKIPPED: ' select  ' });
  assert.equal(passed.status, 0, passed.stdout);
  const blocked = run({ NEEDS: JSON.stringify(needs) });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /::error::select: skipped/);
  assert.equal(run({ NEEDS: '' }).status, 1);
  assert.equal(run({}).status, 1);
  assert.equal(run({ NEEDS: '{}' }).status, 1);
  assert.equal(spawnSync(process.execPath, [script, 'nonsense'], { encoding: 'utf8' }).status, 1);
});
