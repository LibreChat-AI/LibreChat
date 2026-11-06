import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATCHUP_LIVE_HOURS, decide, parseMinHours } from './vote-gate.mjs';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-23T12:00:00Z');
const ago = (h) => new Date(NOW - h * HOUR).toISOString();

let nextId = 1;
/** A votes-workflow run created `h` hours before NOW. */
function run(
  h,
  {
    status = 'completed',
    conclusion = 'success',
    sha = `sha-${h}`,
    event = 'workflow_dispatch',
  } = {},
) {
  return { id: nextId++, event, status, conclusion, created_at: ago(h), head_sha: sha };
}

/** The newest merge, pushed `h` hours before NOW. */
const merge = (h, sha = 'merge-sha') => ({ sha, at: ago(h) });

const base = { minHours: 2, now: NOW, catchupAt: ago(0.5) };

test('parseMinHours: unset, empty and 0 mean no throttle; anything but hours is invalid', () => {
  assert.equal(parseMinHours(undefined), 0);
  assert.equal(parseMinHours(''), 0);
  assert.equal(parseMinHours(' 0 '), 0);
  assert.equal(parseMinHours('2'), 2);
  assert.equal(parseMinHours('2.5'), 2.5);
  assert.equal(parseMinHours('2h'), null);
  assert.equal(parseMinHours('-1'), null);
  assert.equal(parseMinHours('off'), null);
});

test('no throttle: a merge votes and the catch-up starts nothing', () => {
  const runs = [run(0.1, { sha: 'merge-sha' })];
  assert.equal(
    decide({ ...base, minHours: 0, event: 'push', runs, merge: merge(0) }).dispatch,
    true,
  );
  assert.equal(
    decide({ ...base, minHours: 0, event: 'schedule', runs: [], merge: merge(5) }).dispatch,
    false,
  );
});

test('a merge inside the window waits while the catch-up is live', () => {
  const decision = decide({ ...base, event: 'push', runs: [run(1)], merge: merge(0) });
  assert.equal(decision.dispatch, false);
  assert.match(decision.reason, /next vote may start at 2026-10-23T13:00:00Z/);
});

test('a merge votes once the newest started vote is N hours old', () => {
  assert.equal(decide({ ...base, event: 'push', runs: [run(2)], merge: merge(0) }).dispatch, true);
  assert.equal(decide({ ...base, event: 'push', runs: [], merge: merge(0) }).dispatch, true);
});

test('a merge votes as before while the catch-up is not running', () => {
  const runs = [run(1)];
  const never = decide({ ...base, event: 'push', runs, merge: merge(0), catchupAt: null });
  assert.equal(never.dispatch, true);
  const stale = decide({
    ...base,
    event: 'push',
    runs,
    merge: merge(0),
    catchupAt: ago(CATCHUP_LIVE_HOURS + 0.1),
  });
  assert.equal(stale.dispatch, true);
});

test('the catch-up votes the last merge of a burst once the window opens, and not before', () => {
  const runs = [run(2.2), run(3)];
  assert.equal(decide({ ...base, event: 'schedule', runs, merge: merge(1) }).dispatch, true);
  assert.equal(
    decide({ ...base, event: 'schedule', runs: [run(1.5)], merge: merge(1) }).dispatch,
    false,
  );
});

test('a vote created after the newest merge, or on its commit, covers it', () => {
  for (const covering of [
    run(0.5),
    run(0.5, { status: 'queued', conclusion: null }),
    run(0.5, { status: 'in_progress', conclusion: null }),
    run(0.5, { conclusion: 'failure' }),
    run(0.5, { event: 'push' }),
    run(3, { sha: 'merge-sha' }),
  ]) {
    const decision = decide({ ...base, event: 'schedule', runs: [covering], merge: merge(1) });
    assert.equal(
      decision.dispatch,
      false,
      `${covering.status}/${covering.conclusion} at ${covering.created_at}`,
    );
    assert.match(decision.reason, /already covers/);
  }
});

test('a handed-off push run neither holds the window nor covers the merge', () => {
  const handoff = run(0.2, { conclusion: 'skipped', sha: 'merge-sha', event: 'push' });
  const decision = decide({ ...base, event: 'push', runs: [handoff, run(3)], merge: merge(0.2) });
  assert.equal(decision.dispatch, true);
});

test('a handoff still in flight neither covers its merge nor holds the window', () => {
  for (const status of ['queued', 'in_progress']) {
    const handoff = run(0, { status, conclusion: null, sha: 'merge-sha', event: 'push' });
    const decision = decide({ ...base, event: 'push', runs: [handoff, run(3)], merge: merge(0) });
    assert.equal(decision.dispatch, true, `${status}: ${decision.reason}`);
  }
  const earlier = run(0.2, { status: 'in_progress', conclusion: null, sha: 'prev', event: 'push' });
  const decision = decide({
    ...base,
    event: 'schedule',
    runs: [earlier, run(3)],
    merge: merge(0.1),
  });
  assert.equal(decision.dispatch, true, decision.reason);
});

test('a cancelled vote covers nothing but holds the window, so it is retried once per window', () => {
  const cancelled = run(1, { conclusion: 'cancelled' });
  const inside = decide({ ...base, event: 'schedule', runs: [cancelled], merge: merge(1.5) });
  assert.equal(inside.dispatch, false);
  assert.match(inside.reason, /throttled/);
  const after = decide({
    ...base,
    event: 'schedule',
    runs: [run(2.5, { conclusion: 'cancelled' })],
    merge: merge(3),
  });
  assert.equal(after.dispatch, true);
});

test('the catch-up starts nothing before any merge is on record', () => {
  assert.equal(decide({ ...base, event: 'schedule', runs: [], merge: null }).dispatch, false);
});

/**
 * A day of merges every 20 minutes from 08:00 to 20:00 UTC, then quiet: every vote is at least N
 * hours after the one before, and the last merge is voted by the catch-up within N + 1 hours.
 */
test('a burst: votes keep the window, and the catch-up votes its tail', () => {
  const N = 2;
  const day = Date.parse('2026-10-23T00:00:00Z');
  const pushes = Array.from({ length: 37 }, (_, i) => ({
    t: day + 8 * HOUR + i * 20 * 60_000,
    sha: `m${i}`,
  }));
  const ticks = Array.from({ length: 24 }, (_, h) => ({
    t: day + h * HOUR + 17 * 60_000,
    schedule: true,
  }));
  const events = [...pushes, ...ticks].sort((a, b) => a.t - b.t);
  const runs = [];
  let newest = null;
  for (const e of events) {
    if (!e.schedule) {
      newest = { sha: e.sha, at: new Date(e.t).toISOString() };
    }
    const event = e.schedule ? 'schedule' : 'push';
    const decision = decide({
      event,
      minHours: N,
      now: e.t,
      runs,
      merge: newest,
      catchupAt: new Date(e.t - HOUR).toISOString(),
    });
    if (decision.dispatch) {
      runs.unshift({
        id: runs.length + 1,
        status: 'completed',
        conclusion: 'success',
        created_at: new Date(e.t + 1_000).toISOString(),
        head_sha: newest.sha,
      });
    }
  }
  const starts = runs.map((r) => Date.parse(r.created_at)).reverse();
  for (let i = 1; i < starts.length; i++) {
    assert.ok(
      starts[i] - starts[i - 1] >= N * HOUR,
      `vote ${i} started ${(starts[i] - starts[i - 1]) / HOUR} h after the one before`,
    );
  }
  const lastMerge = pushes[pushes.length - 1];
  assert.equal(runs[0].head_sha, lastMerge.sha);
  assert.ok(starts[starts.length - 1] - lastMerge.t <= (N + 1) * HOUR);
  assert.equal(starts.length, 7);
});
