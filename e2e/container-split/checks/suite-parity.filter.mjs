// suite-parity.filter.mjs — the committed reference and its well-formedness check behind PARITY-SUITE-31
// (task 14.6, task 17.6).
//
// PARITY-SUITE-31 is `layer: 'recorded'` in the Check Catalog: it is decided OUTSIDE the harness and
// recorded BY REFERENCE. Requirement 4.4 asks that, run with `DISABLE_STARTUP_TASKS` absent, the
// existing automated test suite finish with the SAME count of passing and failing tests it produces
// against the pre-split image, having modified ZERO existing test files and ZERO existing assertions.
// The backend CI lane already produces that count on every pull request; re-running the suite inside a
// topology run would double the cost to re-derive a result the lane already owns (design.md). So the
// harness records the reference and asserts NOTHING about a local execution — the run report carries a
// `skip` with skipReason `decided-by-reference`, never a `pass`, because a pass would claim an
// observation the run did not make (task 17.6).
//
// This module holds the committed reference and a PURE well-formedness check over it. The
// well-formedness is INTERNAL validation — the reference must name the lane, the criterion and the
// additive roots so the recorded fact is legible — but it is NOT the check's outcome. The outcome is a
// decided-by-reference skip the reporter derives (reporter.mjs), carrying `referenceSummary()` as its
// observation. Nothing here fails on a missing or renamed workflow file: a lane whose path no longer
// resolves is stated in the skip's observation, not turned into a failure (NG10 — no check may depend
// on project code or config staying unchanged).
//
// The exported constants and pure helpers live here, in a non-spec sibling module, so the spec file
// (suite-parity.spec.mjs) can import them and export NOTHING itself. jest.config.mjs's testMatch
// collects only `*.spec.mjs` / `*.test.mjs`, so a `.filter.mjs` is never collected as a test — the
// same shape boot-nowrite.filter.mjs establishes.
//
// NG1/NG2 hold: this decides over the harness's own reference and touches no application code and
// neither container-split script.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// This file's own directory, resolved from `import.meta.url` — the one shape valid under both `node`
// and the Layer B native-ESM Jest config (jest.config.mjs). `__dirname` does not exist under native
// ESM, so it is deliberately not used. checks/ sits one level below e2e/container-split/, and the
// repository root is three levels above that.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

// The check id this record owns, named once and read by the reporter's derivation.
export const CHECK_ID = 'PARITY-SUITE-31';

// ---------------------------------------------------------------------------------------------
// The committed reference. This is the whole substance of PARITY-SUITE-31: the pointer to the lane
// that decides the existing suite's pass/fail counts, the criterion it runs under, and the invariant
// Req 4.4 turns on. Frozen so a reader cannot mutate it and a change to it is a deliberate edit.
//
// The pass/fail counts and the "zero modified test files / zero modified assertions" fact are NOT
// asserted here as pass conditions (task 17.6). They are carried as REFERENCE TEXT — the count is the
// lane's to produce, and the additivity is decided by review of the diff, not by a number this module
// could keep honest. A transcribed count would rot the moment the suite grows a test; the additive
// roots are the reference a reviewer confirms are new directories rather than edits to existing suites.
// ---------------------------------------------------------------------------------------------
export const SUITE_PARITY_REFERENCE = Object.freeze({
  // The requirement this record owns.
  requirement: '4.4',

  // The lane whose run IS the existing suite's pass/fail counts. The harness does NOT re-run the
  // suite (that would double the cost to re-derive a result this lane already produces on every pull
  // request — design.md); it records this pointer. `laneName`, `lanePath` and `jobs` are what a reader
  // looks for in that lane's output. `lanePath` is repo-root-relative; a lane that was renamed or
  // removed is STATED in the skip's observation, not turned into a check failure (NG10).
  laneName: 'Backend Unit Tests',
  lanePath: '.github/workflows/backend-review.yml',
  jobs: Object.freeze([
    'Tests: api (shard N/3)',
    'Tests: @librechat/api (shard N/4)',
    'Tests: data-provider',
    'Tests: data-schemas',
  ]),

  // The criterion Req 4.4 names: the existing suite is run with `DISABLE_STARTUP_TASKS` absent. That
  // is the backend lane's ORDINARY configuration — the gate is a container-split env lever
  // (env-matrix.md), never set in the backend test lane — so the lane's counts are exactly the
  // "DISABLE_STARTUP_TASKS absent" counts Req 4.4 asks about. Recorded so the record states the
  // condition under which the referenced counts hold rather than leaving it implied.
  criterion: 'DISABLE_STARTUP_TASKS absent (the backend lane never sets the gate)',

  // The new roots the harness added, all additive — the concrete form of "zero existing modified".
  // A reviewer confirms these are new directories, not edits to existing suites. This is reference
  // text (decided by review), not a pass condition this module asserts.
  additiveRoots: Object.freeze(['e2e/container-split/', 'api/test/container-split/']),
});

// ---------------------------------------------------------------------------------------------
// Pure well-formedness check over the recorded reference. Returns `{ ok, reason? }`. This is INTERNAL
// validation that the reference names what a reader needs (the requirement it owns, the
// DISABLE_STARTUP_TASKS-absent criterion, a lane path, the additive roots) — NOT the check's outcome,
// which is a decided-by-reference skip regardless. It deliberately does NOT fail on a missing or
// renamed workflow file: whether the cited lane path resolves is REPORTED (see `laneResolves`) so the
// skip's observation can state a dangling pointer, but it never turns into a failure (NG10). The
// modified-file / modified-assertion counts are NOT checked here — that fact is reference text decided
// by review (task 17.6).
// ---------------------------------------------------------------------------------------------
export function decideSuiteParityReference(reference = SUITE_PARITY_REFERENCE) {
  if (reference === null || typeof reference !== 'object') {
    return { ok: false, reason: `${CHECK_ID}: the suite-parity reference is not an object.` };
  }

  // The requirement this record owns must be 4.4 — the record is Req 4.4's owner in the run summary.
  if (reference.requirement !== '4.4') {
    return {
      ok: false,
      reason:
        `${CHECK_ID}: the reference names requirement ${JSON.stringify(reference.requirement)}, ` +
        'but PARITY-SUITE-31 records Requirement 4.4. The recorded requirement must match the ' +
        'check the catalog carries.',
    };
  }

  // The criterion (DISABLE_STARTUP_TASKS absent) must be recorded, so the record states the condition
  // under which the referenced counts hold rather than leaving it implied.
  if (
    typeof reference.criterion !== 'string' ||
    !/DISABLE_STARTUP_TASKS/.test(reference.criterion)
  ) {
    return {
      ok: false,
      reason:
        `${CHECK_ID}: the reference does not record the DISABLE_STARTUP_TASKS-absent criterion Req ` +
        '4.4 names. The record must state the condition under which the referenced counts hold.',
    };
  }

  // A lane path must be recorded so the reference points at SOMETHING — but whether that file exists
  // is not decided here (NG10). An empty path is malformedness, not a missing file: there is nothing
  // for the observation to name.
  if (typeof reference.lanePath !== 'string' || reference.lanePath.trim() === '') {
    return {
      ok: false,
      reason: `${CHECK_ID}: the reference records no lane path; there is nothing to point at.`,
    };
  }

  // The additive roots must be recorded and non-empty — they are the concrete form of "zero existing
  // modified", the roots a reviewer confirms are new rather than edits.
  if (!Array.isArray(reference.additiveRoots) || reference.additiveRoots.length === 0) {
    return {
      ok: false,
      reason:
        `${CHECK_ID}: the reference records no additive roots. The harness's additivity — new roots, ` +
        "no existing test edited — is what makes the existing suite's counts carry by reference.",
    };
  }

  return { ok: true };
}

// Whether the cited lane workflow currently resolves on disk. This is REPORTED, never asserted: a lane
// that was renamed or removed is a fact the skip's observation states, not a failure (NG10). Injectable
// `repoRoot` and `fileExists` so it is unit-exercisable without touching the real filesystem.
export function laneResolves(
  reference = SUITE_PARITY_REFERENCE,
  { repoRoot = REPO_ROOT, fileExists = existsSync } = {},
) {
  if (
    reference === null ||
    typeof reference !== 'object' ||
    typeof reference.lanePath !== 'string'
  ) {
    return false;
  }
  return fileExists(path.join(repoRoot, reference.lanePath));
}

// A human summary of the recorded reference — the observation the decided-by-reference skip carries.
// It names the lane, its workflow path, the jobs, the DISABLE_STARTUP_TASKS-absent criterion and the
// additive roots, and states whether the cited lane path currently resolves (NG10: a missing lane path
// is stated here, not turned into a failure). It carries NO transcribed pass/fail count and asserts
// nothing about a local execution — the counts are the lane's to produce, and "zero modified existing
// tests" is reference text decided by review.
export function referenceSummary(reference = SUITE_PARITY_REFERENCE, options = {}) {
  const resolves = laneResolves(reference, options);
  const laneClause = resolves
    ? `the "${reference.laneName}" lane (${reference.lanePath})`
    : `the "${reference.laneName}" lane, whose recorded path ${reference.lanePath} does NOT currently ` +
      'resolve in-tree (renamed or removed); update the recorded lanePath to the lane that now runs ' +
      'the existing backend suite';
  return (
    `${CHECK_ID} (recorded, Req ${reference.requirement}): decided by reference, no local execution ` +
    `this run. The existing backend suite's pass/fail counts are carried BY REFERENCE to ${laneClause}, ` +
    `jobs [${reference.jobs.join(', ')}], run with ${reference.criterion}. The harness is additive — ` +
    `new roots ${reference.additiveRoots.join(', ')}, zero existing test files and zero existing ` +
    'assertions modified (decided by review of the diff, not asserted here) — so the counts are ' +
    'unchanged by construction. This check records the reference and asserts nothing itself.'
  );
}
