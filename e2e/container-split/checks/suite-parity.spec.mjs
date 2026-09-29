// checks/suite-parity.spec.mjs — PARITY-SUITE-31, the existing-suite parity RECORD (task 12.3, task 17.6).
//
// Property 4, single-container parity (parent P12, Req 4.4). Requirement 4.4 asks that, run with
// `DISABLE_STARTUP_TASKS` absent, the existing automated test suite finish with the SAME count of
// passing and failing tests it produces against the pre-split image, having modified ZERO existing
// test files and ZERO existing assertions.
//
// == This check is DECIDED BY REFERENCE — it neither re-runs the suite nor reports a pass ==
// Unlike every sibling check, PARITY-SUITE-31 is `layer: 'recorded'` in the Check Catalog
// (check-catalog.mjs) — it is decided OUTSIDE the harness. The backend CI lane runs the existing suite
// with `DISABLE_STARTUP_TASKS` absent (its ordinary configuration) on every pull request and produces
// the pass/fail counts Req 4.4 asks about; re-running the suite inside a topology run would double the
// cost to re-derive a result the lane already owns (design.md). So the harness records the reference —
// the lane name, its workflow path, its jobs, the DISABLE_STARTUP_TASKS-absent condition, and the
// additive roots that make the counts carry — and ASSERTS NOTHING about a local execution.
//
// The run report carries this id as a `skip` with skipReason `decided-by-reference`, NEVER a `pass`:
// a pass would claim an observation the run did not make (task 17.6). The skip is not announced by
// this spec as a `test.skip` (which the reporter reads as NOT_EXECUTED, a run-blocking absence);
// instead this spec REGISTERS NO `[PARITY-SUITE-31]` check, and reporter.mjs derives the
// decided-by-reference skip for the id from the catalog when the id produces no Jest result, carrying
// `referenceSummary()` as the observation. Absence-derived is how every recorded/unexecuted skip is
// expressed in this harness (design: "Unexecuted is not passed"; the Layer B live specs self-skip the
// same way, by registering nothing rather than a definition-time skip).
//
// == Why this file still exists and runs ==
// It carries the committed reference (SUITE_PARITY_REFERENCE, in the sibling suite-parity.filter.mjs)
// and INTERNAL well-formedness exercises over it — that the reference names the requirement it owns,
// the DISABLE_STARTUP_TASKS-absent criterion, a lane path, and the additive roots. That well-formedness
// is validation of the RECORD, not the check's outcome: a malformed reference is a bug in this file
// worth failing a `.spec.mjs` test on, but the id's OUTCOME in the run report is a decided-by-reference
// skip regardless. None of these exercises carry the `[PARITY-SUITE-31]` catalog tag in a bracket, so
// reporter.mjs's parseCheckId does not map any of them onto the check record — the id stays absent from
// the aggregate and the reporter derives its skip.
//
// == NG10: no failure on a missing or renamed workflow file ==
// Whether the cited lane path resolves on disk is REPORTED in the skip's observation
// (referenceSummary states a dangling pointer), never turned into a check failure. A recorded check
// may not depend on project code or config staying unchanged (NG10): a lane that was renamed still
// leaves Req 4.4 owned in the run summary, with the observation telling a reader to update the path.
//
// NG1/NG2 hold: this records a reference to an existing CI lane and adds no application code, no route
// mount and no HTTP path (NG1), and edits neither container-split script (NG2). NG6 holds: no
// credential validation happens here.

// The exported constants and pure helpers live in suite-parity.filter.mjs (a non-spec sibling) so this
// spec file exports nothing (task 14.6). The spec imports what its exercises read.
import {
  CHECK_ID,
  SUITE_PARITY_REFERENCE,
  decideSuiteParityReference,
  laneResolves,
  referenceSummary,
} from './suite-parity.filter.mjs';

// Write the recorded reference to stderr at load time. Written straight to process.stderr, not
// console.warn: Jest's default reporter discards the console buffer of a file, and this reference is
// the record's substance — it must reach the run output regardless of the reporter's buffering, the
// same discipline the sibling self-skipping specs use for their skip reason.
process.stderr.write(`[container-split] ${referenceSummary()}\n`);

// ---------------------------------------------------------------------------------------------
// Internal well-formedness exercises for the recorded reference. They run NOW (no topology, no gate),
// so the reference logic is exercised on every run. NONE of them carries the `[PARITY-SUITE-31]`
// catalog tag in a bracket, so the reporter does not map them onto the check record: the id produces
// no Jest result and the reporter derives its decided-by-reference skip (reporter.mjs). Each asserts
// both a well-formed and a malformed case so no branch is vacuous (Property 6: no check passes
// vacuously).
//
// The cited lane's existence is NOT a well-formedness condition (NG10): `laneResolves` is exercised
// through an injectable `fileExists` and reported into the summary, never asserted as a pass gate.
// ---------------------------------------------------------------------------------------------
describe(`${CHECK_ID}: the recorded suite-parity reference is well-formed`, () => {
  test('the committed reference is well-formed', () => {
    expect(decideSuiteParityReference().ok).toBe(true);
    expect(decideSuiteParityReference(SUITE_PARITY_REFERENCE).ok).toBe(true);
  });

  test('a wrong requirement fails — the record owns Req 4.4', () => {
    const wrongReq = { ...SUITE_PARITY_REFERENCE, requirement: '4.3' };
    expect(decideSuiteParityReference(wrongReq).ok).toBe(false);
  });

  test('a missing DISABLE_STARTUP_TASKS criterion fails — the condition must be recorded', () => {
    const noCriterion = { ...SUITE_PARITY_REFERENCE, criterion: 'some other condition' };
    expect(decideSuiteParityReference(noCriterion).ok).toBe(false);
  });

  test('an empty lane path fails — the reference must point at something', () => {
    const noPath = { ...SUITE_PARITY_REFERENCE, lanePath: '   ' };
    const decision = decideSuiteParityReference(noPath);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain('lane path');
  });

  test('an empty additive-roots list fails — additivity is what makes the counts carry', () => {
    const noRoots = { ...SUITE_PARITY_REFERENCE, additiveRoots: [] };
    expect(decideSuiteParityReference(noRoots).ok).toBe(false);
  });

  test('a non-object reference fails rather than throwing', () => {
    expect(decideSuiteParityReference(null).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The cited lane path is REPORTED, not asserted (NG10). A missing or renamed workflow file does not
// fail the check — it is stated in the skip's observation. These exercises pin that laneResolves is a
// report and that referenceSummary states a dangling pointer rather than throwing or failing.
// ---------------------------------------------------------------------------------------------
describe(`${CHECK_ID}: a missing or renamed lane file is reported, never a failure (NG10)`, () => {
  const present = () => true;
  const absent = () => false;

  test('laneResolves reports the lane file presence rather than deciding an outcome', () => {
    expect(laneResolves(SUITE_PARITY_REFERENCE, { fileExists: present })).toBe(true);
    expect(laneResolves(SUITE_PARITY_REFERENCE, { fileExists: absent })).toBe(false);
  });

  test('the observation states a dangling lane pointer instead of failing on it', () => {
    const summary = referenceSummary(SUITE_PARITY_REFERENCE, { fileExists: absent });
    expect(summary).toContain('does NOT currently');
    expect(summary).toContain(SUITE_PARITY_REFERENCE.lanePath);
  });

  test('referenceSummary names the lane, the criterion, and the additive roots when the lane resolves', () => {
    const summary = referenceSummary(SUITE_PARITY_REFERENCE, { fileExists: present });
    expect(summary).toContain('BY REFERENCE');
    expect(summary).toContain(SUITE_PARITY_REFERENCE.laneName);
    expect(summary).toContain('DISABLE_STARTUP_TASKS');
    expect(summary).toContain('asserts nothing');
  });
});
