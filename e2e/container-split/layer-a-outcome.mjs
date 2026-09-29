// layer-a-outcome.mjs — how Layer A's single spawn result becomes twelve catalog records.
//
// Layer A (the api workspace's `test/container-split` suites, plus the static NG3 compose guard) runs
// at stage 1, in its own Jest, in its own workspace. It decides twelve catalog ids and reports one
// exit status for all of them. Turning that one status into per-id records is a small classification
// with a sharp edge — a self-skip for want of `mongosh` exits 0 exactly as a clean pass does — so it
// lives here, in one module, imported by BOTH writers of a run report:
//
//   * run.mjs, for the early-exit report a run that never reaches stage 11 writes itself; and
//   * reporter.mjs, for the stage-11 report the Layer B Jest run writes.
//
// It lived in run.mjs alone before, which is why the stage-11 report was WRONG about Layer A: the
// reporter had no knowledge of Layer A at all and derived every Layer A id as
// `skip / optional-dependency-absent`, inventing a missing `mongosh` on a run whose Layer A had just
// passed 135 tests with `mongosh` present. The report said twelve checks did not run when they had.
// One classifier, two callers, is what keeps the two reports from disagreeing about the same spawn.
//
// NG1/NG2 hold: this classifies the harness's own check outcomes. It touches no application code and
// neither container-split script.

import { CHECK_STATUS as RECORD_STATUS, SKIP_REASON } from './serializer.mjs';
import { catalogEntryFor } from './check-catalog.mjs';

// The stderr marker api/test/container-split/harness.js writes when `mongosh` is absent and the grant
// suites self-skip. It is the ONLY signal that distinguishes "Layer A ran and passed" from "Layer A
// self-skipped", because Jest exits 0 in both cases — a self-skip is a reported skip, never a pass
// (design: Layer A "self-skips loudly"), so recording those ids as `pass` off a zero exit alone would
// be precisely the false pass Req 5.10 forbids. Matched as a prefix of the harness's own sentence so
// a reword of the tail does not silently turn a skip into a pass.
export const LAYER_A_SELF_SKIP_MARKER = 'SKIPPING container-split suites';

// The environment variable through which run.mjs hands Layer A's verdict to the Layer B Jest run, so
// the stage-11 reporter can record what Layer A actually decided. It carries the SUMMARY
// (`{ status, selfSkipped }`) rather than Layer A's stderr: the two booleans are everything the
// classification reads, and a multi-megabyte log has no business crossing a process boundary through
// an environment variable.
export const LAYER_A_RESULT_ENV = 'HARNESS_LAYER_A_RESULT';

// Reduce a Layer A spawn result to the two facts the classification turns on. Accepts either the raw
// spawn result (`{ status, stderr }`, what the exec seam resolves) or an already-reduced summary
// (`{ status, selfSkipped }`, what crosses the process boundary), so both call sites feed the same
// classifier.
export function summarizeLayerAResult({ status, stderr = '', selfSkipped = null } = {}) {
  return {
    status,
    selfSkipped:
      typeof selfSkipped === 'boolean' ? selfSkipped : stderr.includes(LAYER_A_SELF_SKIP_MARKER),
  };
}

// Serialize the summary for the environment hand-off. Kept beside the parse so the two agree.
export function serializeLayerASummary(result) {
  return JSON.stringify(summarizeLayerAResult(result));
}

// Read the summary back out of an environment map. Returns null when the variable is absent or
// unparseable — the plain `npx jest` case, where no runner ran Layer A at all, and where the reporter
// must NOT claim to know what Layer A decided. A malformed value reads as absent rather than throwing:
// the report is diagnostic, and losing it over a bad env value would be worse than recording the
// Layer A ids as decided in the backend lane.
export function readLayerASummary(env = process.env) {
  const raw = env?.[LAYER_A_RESULT_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.status !== 'number') {
      return null;
    }
    return summarizeLayerAResult(parsed);
  } catch {
    return null;
  }
}

// Whether a catalog id is decided by LAYER A rather than in the Layer B Jest aggregate. The catalog's
// own `layer` decides it: 'A' is a grant/provision suite (needs `mongosh`) and 'static' is the NG3
// compose guard (needs nothing). Both live in `api/test/container-split/`, which is what the runner
// spawns as stage 1, so both are decided by Layer A's exit status.
export function isBackendLaneCheck(id) {
  const { layer } = catalogEntryFor(id);
  return layer === 'A' || layer === 'static';
}

// Classify one backend-lane catalog id from Layer A's captured spawn result (or its summary). Pure, so
// every branch is unit-exercisable without spawning Jest.
//
//   * status !== 0            -> fail. The Layer A verdict is per-suite and a spawn result cannot
//                               attribute it to individual ids, so the observation says so. Recorded
//                               as `fail` rather than `pass` or `skip` because at least one Layer A
//                               check WAS falsified, and erring toward `pass` here would be a false
//                               green on the cheapest, most load-bearing half of the run.
//   * self-skip marker present -> layer 'A' ids skip (OPTIONAL_DEPENDENCY_ABSENT: `mongosh` absent,
//                               so the grant suites asserted nothing); layer 'static' ids pass, since
//                               the NG3 compose guard needs no `mongosh` and ran.
//   * otherwise               -> pass. Exit 0 with no self-skip means the suites ran and every
//                               assertion held.
export function classifyLayerAOutcomeFor(id, result = {}) {
  const { status, selfSkipped } = summarizeLayerAResult(result);
  if (status !== 0) {
    return {
      status: RECORD_STATUS.FAIL,
      observation:
        `Layer A (api/test/container-split) exited ${status}. Layer A reports per suite, so this ` +
        'record cannot attribute the failure to one catalog id — read the Layer A Jest output for ' +
        'the failing assertion. Recorded as a fail rather than a pass because at least one Layer A ' +
        'check was falsified.',
    };
  }
  if (selfSkipped) {
    if (catalogEntryFor(id).layer === 'static') {
      // The NG3 compose guard needs no mongosh, so it ran and passed inside that same zero exit.
      return { status: RECORD_STATUS.PASS };
    }
    return {
      status: RECORD_STATUS.SKIP,
      skipReason: SKIP_REASON.OPTIONAL_DEPENDENCY_ABSENT,
      observation:
        'Layer A self-skipped: `mongosh` was not on PATH, so provision.mongo.js could not be run ' +
        'and the grant suites asserted nothing. A skip, never a pass and never a defect.',
    };
  }
  return { status: RECORD_STATUS.PASS };
}
