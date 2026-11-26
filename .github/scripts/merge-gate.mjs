#!/usr/bin/env node
/**
 * Helpers for the status checks that dev's merge queue requires.
 *
 * Each workflow in SUITES ends in a gate job named after its context, and that name is the
 * required status check. The gate depends on every other job of its workflow, so it reports
 * whenever the workflow runs: on a pull request and on the merge group that tests the commit
 * about to land.
 *
 *   verify     The gate job itself: fails unless every job it depends on succeeded, or was
 *              skipped for a reason its workflow lists.
 *   plan       Pull requests only. A path-filtered workflow that does not start never reports
 *              its gate, which would leave the required check pending forever. This lists the
 *              suites GitHub did not start for the head commit so merge-gate.yml can report
 *              their contexts instead.
 *   supersede  Merge groups only. A group that is rebuilt gets a new branch, so no concurrency
 *              group ties its runs to the ones it replaces. This cancels the runs whose queue
 *              branch no longer exists.
 */
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/** The gated workflows and the name of the gate job that closes each one. */
export const SUITES = Object.freeze([
  Object.freeze({ workflow: 'backend-review.yml', context: 'backend' }),
  Object.freeze({ workflow: 'frontend-review.yml', context: 'frontend' }),
  Object.freeze({ workflow: 'playwright-mock.yml', context: 'e2e' }),
  Object.freeze({ workflow: 'agents-integration-tests.yml', context: 'integration' }),
  Object.freeze({ workflow: 'cache-integration-tests.yml', context: 'cache-integration' }),
  Object.freeze({ workflow: 'static-checks.yml', context: 'static' }),
]);

const QUEUE_BRANCH_PREFIX = 'gh-readonly-queue/';
const PLAN_ATTEMPTS = 3;
const PLAN_INTERVAL_MS = 10_000;
/** A run younger than this is not cancelled on first sight: its branch may not be readable yet. */
const SUPERSEDE_MIN_AGE_MS = 60_000;
const RUNS_PAGE_SIZE = 100;
const RUNS_MAX_PAGES = 10;

/**
 * The jobs that keep a gate from passing, as `job: result` lines. A job passes when it
 * succeeded, or when it was skipped and its workflow allows that skip.
 */
export function verify(needs, allowSkipped = []) {
  const jobs = Object.entries(needs ?? {});
  if (jobs.length === 0) {
    throw new Error('No job results to verify');
  }
  const unknown = allowSkipped.filter((job) => !Object.hasOwn(needs, job));
  if (unknown.length > 0) {
    throw new Error(`Skips allowed for jobs the gate does not depend on: ${unknown.join(', ')}`);
  }
  const allowed = new Set(allowSkipped);
  return jobs
    .filter(
      ([job, { result }]) => result !== 'success' && !(result === 'skipped' && allowed.has(job)),
    )
    .map(([job, { result }]) => `${job}: ${result}`);
}

/**
 * The contexts of the suites that did not start for a pull request head. Workflow runs of one
 * event are created together, so a suite still missing after a few polls was filtered out. A
 * lookup that fails is retried on the next poll and rejects on the last one: reporting a
 * context for a suite that did start would put two checks of one name on the commit.
 */
export async function plan({
  started,
  suites = SUITES,
  attempts = PLAN_ATTEMPTS,
  intervalMs = PLAN_INTERVAL_MS,
  sleep = delay,
}) {
  let missing = suites;
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts;
    const lookups = await Promise.all(
      missing.map((suite) =>
        started(suite.workflow).catch((error) => {
          if (last) {
            throw error;
          }
          return false;
        }),
      ),
    );
    missing = missing.filter((_, index) => !lookups[index]);
    if (missing.length === 0 || last) {
      return missing.map((suite) => suite.context);
    }
    await sleep(intervalMs);
  }
}

/**
 * Active merge group runs on a queue branch other than `current` that no longer exists, split
 * by age: `cancel` holds the ones old enough to act on, `recheck` the ones created within the
 * last minute, whose branch has to be found missing a second time before they are cancelled.
 * A branch whose lookup fails is left alone, and nothing is returned unless the lookup finds
 * `current` itself: if the branch this run is on reads as missing, the answers cannot be
 * trusted for any other.
 */
export async function stale({ runs, current, exists, now = Date.now() }) {
  const readable = await exists(current).catch(() => false);
  if (!readable) {
    return { cancel: [], recheck: [] };
  }
  const others = runs.filter(
    (run) =>
      run.event === 'merge_group' &&
      typeof run.head_branch === 'string' &&
      run.head_branch.startsWith(QUEUE_BRANCH_PREFIX) &&
      run.head_branch !== current,
  );
  const branches = [...new Set(others.map((run) => run.head_branch))];
  const present = await Promise.all(branches.map((branch) => exists(branch).catch(() => true)));
  const gone = new Set(branches.filter((_, index) => !present[index]));
  const orphaned = others.filter((run) => gone.has(run.head_branch));
  const settled = (run) => now - Date.parse(run.created_at) >= SUPERSEDE_MIN_AGE_MS;
  return {
    cancel: orphaned.filter(settled),
    recheck: orphaned.filter((run) => !settled(run)),
  };
}

/**
 * Cancels the runs `stale` finds and returns what `cancel` reported for each. Runs too young
 * to judge get one more pass after the minimum age, so a group replaced within its first
 * minute is still cleaned up by the group that replaced it.
 */
export async function supersede({
  list,
  current,
  exists,
  cancel,
  sleep = delay,
  clock = Date.now,
}) {
  const first = await stale({ runs: await list(), current, exists, now: clock() });
  const cancelled = await Promise.all(first.cancel.map(cancel));
  if (first.recheck.length === 0) {
    return cancelled;
  }
  await sleep(SUPERSEDE_MIN_AGE_MS);
  const done = new Set(first.cancel.map((run) => run.id));
  const second = await stale({ runs: await list(), current, exists, now: clock() });
  const late = second.cancel.filter((run) => !done.has(run.id));
  return [...cancelled, ...(await Promise.all(late.map(cancel)))];
}

function github(path, init) {
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  return fetch(`${api}/repos/${process.env.GITHUB_REPOSITORY}/${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28',
    },
  });
}

async function read(path) {
  const response = await github(path);
  if (!response.ok) {
    throw new Error(`GET ${path}: HTTP ${response.status}`);
  }
  return response.json();
}

function summarize(lines) {
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
}

function runVerify() {
  const failures = verify(
    JSON.parse(process.env.NEEDS ?? ''),
    (process.env.ALLOW_SKIPPED ?? '').split(/\s+/).filter(Boolean),
  );
  if (failures.length === 0) {
    console.log('Every job this gate depends on passed.');
    return;
  }
  for (const failure of failures) {
    console.log(`::error::${failure}`);
  }
  process.exitCode = 1;
}

async function runPlan() {
  const sha = process.env.HEAD_SHA;
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
    throw new Error('HEAD_SHA must be the pull request head commit');
  }
  const contexts = await plan({
    started: async (workflow) => {
      const query = `event=pull_request&head_sha=${sha}&per_page=1`;
      const { total_count: count } = await read(`actions/workflows/${workflow}/runs?${query}`);
      return count > 0;
    },
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `contexts=${JSON.stringify(contexts)}\n`);
  summarize([
    '### Merge gate',
    contexts.length === 0
      ? 'Every gated suite started for this commit and reports its own gate.'
      : `Path filters kept these suites from starting, so their gates are reported here: ${contexts.join(', ')}.`,
  ]);
}

async function activeRuns(status, page = 1) {
  const query = `event=merge_group&status=${status}&per_page=${RUNS_PAGE_SIZE}&page=${page}`;
  const { workflow_runs: runs } = await read(`actions/runs?${query}`);
  if (runs.length < RUNS_PAGE_SIZE || page >= RUNS_MAX_PAGES) {
    return runs;
  }
  return [...runs, ...(await activeRuns(status, page + 1))];
}

async function activeMergeGroupRuns() {
  const pages = await Promise.all(['queued', 'in_progress'].map((status) => activeRuns(status)));
  return pages.flat();
}

async function branchExists(branch) {
  const response = await github(`git/ref/heads/${branch}`);
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`GET ${branch}: HTTP ${response.status}`);
  }
  return true;
}

async function cancel(run) {
  const response = await github(`actions/runs/${run.id}/cancel`, { method: 'POST' });
  const outcome = response.ok ? 'cancelled' : `HTTP ${response.status}`;
  return `- ${run.name} on \`${run.head_branch}\`: ${outcome}`;
}

/** Housekeeping only: a failure here must not leave a red check on the commit about to land. */
async function runSupersede() {
  try {
    const cancelled = await supersede({
      list: activeMergeGroupRuns,
      current: process.env.GITHUB_REF_NAME,
      exists: branchExists,
      cancel,
    });
    summarize([
      '### Superseded merge group runs',
      cancelled.length === 0 ? 'None.' : cancelled.join('\n'),
    ]);
  } catch (error) {
    console.log(`::warning::Could not look for superseded merge group runs: ${error.message}`);
  }
}

const COMMANDS = { verify: runVerify, plan: runPlan, supersede: runSupersede };

async function main() {
  const command = COMMANDS[process.argv[2]];
  if (!command) {
    throw new Error(`Usage: merge-gate.mjs <${Object.keys(COMMANDS).join('|')}>`);
  }
  await command();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
