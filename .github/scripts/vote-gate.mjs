#!/usr/bin/env node
/**
 * Codegraph E2E vote gate: whether a merge to dev, or the hourly catch-up, starts a vote run.
 *
 * A vote (codegraph-e2e-votes.yml) runs the whole mock suite on ten runners, about 154
 * job-minutes, and its shards queue for the same runners as PR CI. With repo variable
 * CODEGRAPH_E2E_VOTE_MIN_HOURS set to N > 0, the votes workflow hands its push runs to this gate
 * (codegraph-e2e-vote-gate.yml), which starts the votes workflow on dev at most once per N hours:
 *
 *   - Nothing starts while a vote already covers the newest merge: a run created after that merge
 *     was pushed, or on its commit, that is queued, running or finished with shards that could
 *     report (success or failure). A vote checks out dev's head when it is created, so it holds
 *     every merge before it. A cancelled run is no trial (the codegraph shadow records none), so
 *     it covers nothing. Neither is a push run that has not finished: while throttled it is the
 *     merge's own handoff, created beside this gate's run, whose vote job will be skipped.
 *   - Otherwise a vote starts once the newest started vote is N hours old. A merge inside the
 *     window waits, and the hourly catch-up starts the vote for the newest merge once the window
 *     opens, so the last merge of a burst is voted within about N + 1 hours even when nothing
 *     merges after it. Every started run holds the window, cancelled ones too, so a vote that
 *     keeps failing to finish is retried at most once per N hours. A handoff still in flight
 *     started no vote, so it holds nothing. (A push run that was already voting when the
 *     variable was set is read as a handoff too; the vote the gate starts then waits behind it.)
 *   - While the catch-up has not run for CATCHUP_LIVE_HOURS (its workflow is not on the default
 *     branch yet, or GitHub stopped scheduling it), a merge starts a vote as before: the gate never
 *     holds back a merge it cannot come back for. A push whose history cannot be read fails open
 *     the same way.
 *
 * "The newest merge" is the gate's newest push run: the gate shares the votes workflow's path
 * filter, so a docs-only merge is never voted on its own. Unset, empty or 0 is today's behavior:
 * the votes workflow votes every merge itself and the gate job is skipped. A value that is not a
 * number of hours makes every merge vote through the gate, with a warning.
 */
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOUR = 3_600_000;
/** The catch-up runs hourly; three hours without one tolerates two runs GitHub delays or drops. */
export const CATCHUP_LIVE_HOURS = 3;
export const VOTES_FILE = 'codegraph-e2e-votes.yml';
export const GATE_FILE = 'codegraph-e2e-vote-gate.yml';
const BRANCH = 'dev';

/** Hours from the variable: 0 when unset or empty, null when it is not a non-negative number. */
export function parseMinHours(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') {
    return 0;
  }
  return /^\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

/** Every run started a vote except one whose vote job was skipped (a handed-off push, the kill switch). */
export const startedVote = (run) => !(run.status === 'completed' && run.conclusion === 'skipped');

/** A run that is or will be a trial: queued or running, or finished with shards that could report. */
export const isTrial = (run) =>
  run.status !== 'completed' || run.conclusion === 'success' || run.conclusion === 'failure';

/** While throttled, an unfinished push run is a handoff: its vote job will be skipped. */
export const handoffInFlight = (run) => run.event === 'push' && run.status !== 'completed';

const ms = (iso) => Date.parse(iso);
const stamp = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hours = (t) => Math.round((t / HOUR) * 10) / 10;
const state = (run) => (run.status === 'completed' ? run.conclusion : run.status);

/**
 * The decision, pure.
 *   event      'push' (a merge) or anything else (the catch-up)
 *   minHours   N; 0 means no throttle
 *   now        epoch milliseconds
 *   runs       the votes workflow's runs on dev, any event and status
 *   merge      the newest push to dev that the votes path filter matches, { sha, at }, or null
 *   catchupAt  when the catch-up last ran (ISO), or null
 */
export function decide({ event, minHours, now, runs, merge, catchupAt }) {
  if (!(minHours > 0)) {
    return event === 'push'
      ? { dispatch: true, reason: 'no throttle: every merge votes' }
      : { dispatch: false, reason: 'no throttle: merges vote themselves' };
  }
  if (!merge) {
    return { dispatch: false, reason: 'no merge on record' };
  }
  const votes = runs.filter((run) => !handoffInFlight(run));
  const covering = votes.find(
    (run) => isTrial(run) && (run.head_sha === merge.sha || ms(run.created_at) > ms(merge.at)),
  );
  if (covering) {
    return {
      dispatch: false,
      reason: `run ${covering.id} (${state(covering)}) already covers ${merge.sha.slice(0, 10)}`,
    };
  }
  const last = votes
    .filter(startedVote)
    .reduce(
      (newest, run) => (!newest || ms(run.created_at) > ms(newest.created_at) ? run : newest),
      null,
    );
  const opens = last ? ms(last.created_at) + minHours * HOUR : -Infinity;
  if (now >= opens) {
    return {
      dispatch: true,
      reason: last
        ? `the newest vote, run ${last.id}, started ${hours(now - ms(last.created_at))} h ago (window ${minHours} h)`
        : 'no vote on record',
    };
  }
  const live = catchupAt != null && now - ms(catchupAt) <= CATCHUP_LIVE_HOURS * HOUR;
  if (event === 'push' && !live) {
    return {
      dispatch: true,
      reason: `the hourly catch-up has not run in ${CATCHUP_LIVE_HOURS} h, so the throttle holds nothing back`,
    };
  }
  return {
    dispatch: false,
    reason: `throttled: run ${last.id} started at ${last.created_at}; the next vote may start at ${stamp(opens)}`,
  };
}

function client({ GITHUB_API_URL = 'https://api.github.com', GITHUB_REPOSITORY, GH_TOKEN }) {
  const request = async (method, path, body) => {
    const res = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${GH_TOKEN}`,
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  };
  const runs = async (file, query) => {
    const page = await request(
      'GET',
      `actions/workflows/${file}/runs?${query}&exclude_pull_requests=true`,
    );
    return (page?.workflow_runs ?? []).map(
      ({ id, event, status, conclusion, created_at, head_sha }) => ({
        id,
        event,
        status,
        conclusion,
        created_at,
        head_sha,
      }),
    );
  };
  const dispatch = () =>
    request('POST', `actions/workflows/${VOTES_FILE}/dispatches`, { ref: BRANCH });
  return { runs, dispatch };
}

const sleep = (t) => new Promise((done) => setTimeout(done, t));

async function main(env = process.env) {
  const event = env.GITHUB_EVENT_NAME;
  const parsed = parseMinHours(env.MIN_HOURS);
  if (parsed === null) {
    console.log(
      `::warning::CODEGRAPH_E2E_VOTE_MIN_HOURS=${JSON.stringify(env.MIN_HOURS)} is not a number of hours; every merge votes`,
    );
  }
  const gh = client(env);
  let runs = null;
  let decision;
  try {
    const [voteRuns, pushes, schedules] = await Promise.all([
      gh.runs(VOTES_FILE, `branch=${BRANCH}&per_page=100`),
      gh.runs(GATE_FILE, `branch=${BRANCH}&event=push&per_page=1`),
      gh.runs(GATE_FILE, 'event=schedule&per_page=1'),
    ]);
    runs = voteRuns;
    const merge = pushes[0] ? { sha: pushes[0].head_sha, at: pushes[0].created_at } : null;
    const catchupAt = schedules[0]?.created_at ?? null;
    decision = decide({ event, minHours: parsed ?? 0, now: Date.now(), runs, merge, catchupAt });
  } catch (error) {
    if (event !== 'push') {
      throw error;
    }
    decision = {
      dispatch: true,
      reason: `the vote history could not be read (${error.message}); failing open`,
    };
  }
  const line = `codegraph-vote-gate: ${decision.dispatch ? 'vote' : 'no vote'} (${event}): ${decision.reason}`;
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
  if (!decision.dispatch) {
    return;
  }
  await gh.dispatch();
  if (!runs) {
    return;
  }
  /* The next gate decides from the run list, so wait until the new run is in it. */
  const known = new Set(runs.map((run) => run.id));
  for (let i = 0; i < 12; i++) {
    await sleep(5_000);
    const fresh = await gh.runs(VOTES_FILE, `branch=${BRANCH}&event=workflow_dispatch&per_page=5`);
    const run = fresh.find((candidate) => !known.has(candidate.id));
    if (run) {
      console.log(`codegraph-vote-gate: started run ${run.id} on ${run.head_sha.slice(0, 10)}`);
      return;
    }
  }
  console.log(
    '::warning::the vote run did not appear within 60 s; a gate that decides before it does may start another',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`codegraph-vote-gate: ${error.message}`);
    process.exit(1);
  });
}
