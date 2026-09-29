// checks/run-report.spec.mjs — RUN-REPORT-32, the run-report and exit-status check (task 12.4).
//
// RUN-REPORT-32 is the design's `both`-layer check (check-catalog.mjs: layer 'both', Req 5.1–5.5,
// property —): it decides the harness's own REPORTING AND EXIT-STATUS CONTRACT rather than any parent
// split property. The contract has two halves, split across two tasks and joined here:
//
//   * The REPORTING + EXIT-STATUS half (this task, 12.4). The run emits ONE check record per check —
//     keyed by check id, carrying the id, layer, requirement criteria and property the Check Catalog
//     assigns, plus a status and, on any non-pass, the observation that decided it — and the process
//     exit status reflects the run outcome: exit 0 ONLY when every check passed; non-zero on any
//     check failure, any setup failure, or any teardown failure (design: "Exit status and reporting";
//     Check Catalog row RUN-REPORT-32: "Exit 0 on all pass; non-zero otherwise with check id,
//     requirement criteria, property and deciding observation per failure").
//
//   * The TEARDOWN half (task 7.4, already landed). A teardown leak is a TeardownFailure reported
//     distinctly and forcing a non-zero exit even when every check passed (run.mjs: classifyDownResult,
//     classifyTeardownReadback, runTeardown). This check does not re-implement that classification; it
//     asserts the exit-status contract HONORS it — a teardown failure fed to the serializer's outcome
//     yields a non-zero exit even on an all-pass check set.
//
// == This check exercises the serializer; it does not re-implement it ==
// The report shape and the exit-code logic are serializer.mjs's (buildCheckRecord, runOutcome,
// serializeRun), fed live by reporter.mjs from a `jest --runInBand` run. serializer.mjs is pure, so
// this check drives it over SYNTHETIC check results — pass / fail / skip / setup-failure /
// teardown-failure — and asserts the emitted record shape and the computed exit status the contract
// requires. Reusing the serializer is the point: the report an operator reads and the artifact CI
// attaches are produced by exactly the code this check exercises, so a green RUN-REPORT-32 is a
// statement about the real reporting path rather than a parallel re-derivation of it.
//
// == The exit-code matrix this check pins ==
// The five rows of the contract, each asserted below over the serializer's runOutcome:
//
//   1. every check `pass`                       => exit 0            (the ONLY zero-exit case)
//   2. any check `fail`                          => non-zero
//   3. a `setup-failure` (topology never came up)=> non-zero, and reported DISTINCTLY from a check
//                                                    fail (Property 9: setup failure is not property
//                                                    falsification — a topology that never came up
//                                                    falsified nothing)
//   4. a teardown failure                        => non-zero EVEN WHEN every check passed (task 7.4)
//   5. an enumerated `skip` beside a pass       => exit 0 (skip is not fail), but a skip is never a
//                                                    pass — the tally distinguishes "3 pass" from
//                                                    "2 pass, 1 skip"
//   6. EVERY record a `skip` (even enumerated)   => non-zero: a run that executed no check decided
//                                                    nothing and is not the all-clear (task 15.3's
//                                                    "at least one check actually executed" clause)
//   7. a NON-enumerated skip (NOT_EXECUTED)      => non-zero, classified as a SETUP failure: a stage
//                                                    that failed, a spec that would not load, a
//                                                    context never published is not a benign absence
//
// Rows 5–7 are the subtle ones and the reason the outcome cannot be "no fails => exit 0": exit 0
// additionally requires that at least one check executed and that every skip names an ENUMERATED
// reason (decided-by-reference, optional-dependency-absent, external-provider-required). A skip is not counted as
// a pass, so the tally distinguishes "3 pass" from "2 pass, 1 skip" and the human summary reads them
// apart. This check asserts: an enumerated skip beside a pass does not force non-zero, a skip is never
// tallied as a pass, an all-skip run exits non-zero, and a non-enumerated skip blocks exit 0 as a
// setup failure.
//
// == The JSON summary must be well-formed ==
// The CI lane attaches serializeRun's `json` as an artifact; a malformed summary would lose every
// observation the run produced (task 12.4 bullet). So this check asserts the JSON round-trips through
// JSON.stringify/parse unchanged, carries the schema tag, the per-check records keyed by id, and the
// outcome block with the exit code — the shape reporter.mjs writes to run-report.json.
//
// == Zero interactive prompts across the entry command ==
// Req 5.5 / task 12.4 bullet: the local command IS the CI command, which holds only if nothing in the
// entry path blocks on stdin. This check reads the entry command's own source (run.mjs) and the npm
// script that invokes it (package.json) and asserts neither reaches for interactive input — no
// `readline` question, no `prompt`, no `process.stdin` read, no `-it`/`--interactive` docker flag in
// the compose args the runner spells. A static read, because the property is "the command never
// prompts" and a prompt would only surface interactively otherwise.
//
// == Every assertion here is decidable with no topology, and none of them reads this run's artifact ==
// The whole reporting + exit-status contract is decidable over synthetic outcomes, so every assertion
// runs on EVERY invocation: like the sibling suite-parity check, RUN-REPORT-32's core is a
// pure/serializer check rather than a live observation.
//
// It used to carry one HARNESS_LIVE-gated assertion — that a real run wrote a well-formed
// run-report.json to disk — and that assertion was UNSATISFIABLE AS WRITTEN. reporter.mjs writes the
// artifact from `onRunComplete`, after every test has finished, so no test can see its own run's file;
// deleting the previous run's report before stage 1 (so a stale tally can never read as this run's
// result) only made the failure certain instead of luck-dependent. The observation was real but belongs
// to a later moment, so it moved to the runner: `validateWrittenRunReport` (run.mjs) reads the artifact
// back immediately after stage 11 and decides its well-formedness, its catalog accounting and its
// freshness through the SAME deciders this check drives over a synthesized report
// (report-artifact.mjs), then folds the report's own exit code into the run's exit status. What stays
// here is what a check can honestly decide: the RULES the artifact must satisfy, with a counter-example
// for each.
//
// == The check-record tag convention ==
// Each test's title STARTS with `[RUN-REPORT-32]`, which reporter.mjs parses to map the Jest result
// onto the check record (check-catalog.mjs owns id → {layer, requirements, property}: RUN-REPORT-32 →
// layer 'both', Req 5.1–5.5, property null).
//
// NG1/NG2 hold: this exercises the harness's own serializer and reads the harness's own entry command
// and npm script. It adds no application code, no route mount and no HTTP path (NG1), and edits
// neither container-split script (NG2). NG6 holds: no credential validation happens here.

import { readFileSync } from 'node:fs';

import {
  CHECK_STATUS,
  SKIP_REASON,
  buildCheckRecord,
  buildRecords,
  runOutcome,
  tallyByStatus,
} from '../serializer.mjs';
import { SETUP_FAILURE_KINDS, TEARDOWN_FAILURE_KINDS } from '../run.mjs';
// The exported constants and pure deciders live in run-report.filter.mjs (a non-spec sibling) so this
// spec file exports nothing (task 14.6). The spec imports what its checks exercise.
import {
  CHECK_ID,
  RUN_MJS,
  PACKAGE_JSON,
  ENTRY_SCRIPT_NAME,
  ENTRY_COMMAND,
  SAMPLE_PASS_ID,
  SAMPLE_FAIL_ID,
  decideExitMatrix,
  decideRecordShape,
  decideJsonWellFormed,
  decideNoInteractivePrompts,
  decideArtifactRules,
  decideArtifactWellFormed,
} from './run-report.filter.mjs';

// ---------------------------------------------------------------------------------------------
// The checks. Static assertions run now (the reporting + exit-status contract is decidable over
// synthetic outcomes, no topology needed); the live artifact assertion is gated on HARNESS_LIVE=1
// (the signal run.mjs sets against a live topology, task 15) and self-skips loudly otherwise — a
// topology that is not up has written no fresh artifact (Property 9). Every title starts with
// [RUN-REPORT-32] so reporter.mjs maps the result onto the check record.
// ---------------------------------------------------------------------------------------------

describe(`${CHECK_ID}: the run reports per check and the exit status reflects the outcome`, () => {
  // --- Static half: the reporting + exit-status contract over the real serializer. Runs now. ---

  test(`[${CHECK_ID}] exit 0 requires at least one executed check and every skip enumerated; a check fail, setup failure, teardown leak, an all-skip run, or a non-enumerated skip each forces non-zero`, () => {
    const decision = decideExitMatrix();
    expect(decision.ok ? '' : decision.reason).toBe('');
  });

  test(`[${CHECK_ID}] each check record carries its id, layer, requirement criteria, property, and (on non-pass) the deciding observation`, () => {
    const decision = decideRecordShape();
    expect(decision.ok ? '' : decision.reason).toBe('');
  });

  test(`[${CHECK_ID}] the JSON check summary is written and well-formed — schema, outcome, and per-check records keyed by id`, () => {
    const decision = decideJsonWellFormed();
    expect(decision.ok ? '' : decision.reason).toBe('');
  });

  test(`[${CHECK_ID}] the entry command has zero interactive prompts, so the local command is the CI command`, () => {
    const runSource = readFileSync(RUN_MJS, 'utf8');
    const packageJsonText = readFileSync(PACKAGE_JSON, 'utf8');
    const decision = decideNoInteractivePrompts({ runSource, packageJsonText });
    expect(decision.ok ? '' : decision.reason).toBe('');
  });

  test(`[${CHECK_ID}] the artifact's well-formedness and accounting rules hold over a full-catalog report, and reject every counter-example`, () => {
    const decision = decideArtifactRules();
    expect(decision.ok ? '' : decision.reason).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// Static unit exercises for the pure deciders — they run NOW (no topology, no HARNESS_LIVE gate), so
// the reporting + exit-status logic is exercised on every run rather than only once task 15 stands
// the topology up. Each asserts both a pass and a fail so no branch is vacuous (Property 6: no check
// passes vacuously).
// ---------------------------------------------------------------------------------------------

describe(`${CHECK_ID}: pure decider unit exercises`, () => {
  test('decideExitMatrix passes over the real serializer', () => {
    expect(decideExitMatrix().ok).toBe(true);
  });

  test('runOutcome: only an all-pass set exits 0', () => {
    const allPass = buildRecords({
      [SAMPLE_PASS_ID]: { status: CHECK_STATUS.PASS },
      [SAMPLE_FAIL_ID]: { status: CHECK_STATUS.PASS },
    });
    expect(runOutcome(allPass).exitCode).toBe(0);

    const withFail = buildRecords({
      [SAMPLE_FAIL_ID]: { status: CHECK_STATUS.FAIL, observation: 'boom' },
    });
    expect(runOutcome(withFail).exitCode).not.toBe(0);
  });

  test('runOutcome: a setup failure exits non-zero and is flagged distinctly from a check fail', () => {
    const outcome = runOutcome([], {
      setupFailure: { kind: SETUP_FAILURE_KINDS.PROVISION_FAILED, message: 'no Done.' },
    });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.hasSetupFailure).toBe(true);
    expect(outcome.hasCheckFailure).toBe(false);
  });

  test('runOutcome: a teardown leak exits non-zero even when every check passed', () => {
    const allPass = buildRecords({ [SAMPLE_PASS_ID]: { status: CHECK_STATUS.PASS } });
    const outcome = runOutcome(allPass, {
      teardownFailure: {
        kind: TEARDOWN_FAILURE_KINDS.RESOURCES_REMAINED,
        message: 'leak',
        remaining: [],
      },
    });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.hasTeardownFailure).toBe(true);
    expect(outcome.hasCheckFailure).toBe(false);
  });

  test('runOutcome: an enumerated skip beside an executed check does not fail the run, and a skip is never a pass', () => {
    const withSkip = buildRecords({
      [SAMPLE_PASS_ID]: { status: CHECK_STATUS.PASS },
      [SAMPLE_FAIL_ID]: {
        status: CHECK_STATUS.SKIP,
        observation: 'requires an external provider the harness does not stand up',
        skipReason: SKIP_REASON.EXTERNAL_PROVIDER_REQUIRED,
      },
    });
    const outcome = runOutcome(withSkip);
    expect(outcome.exitCode).toBe(0);
    const tally = tallyByStatus(withSkip);
    expect(tally[CHECK_STATUS.PASS]).toBe(1);
    expect(tally[CHECK_STATUS.SKIP]).toBe(1);
  });

  test('runOutcome: an all-skip run exits non-zero even when every skip is enumerated (it decided nothing)', () => {
    const allSkip = buildRecords({
      [SAMPLE_PASS_ID]: {
        status: CHECK_STATUS.SKIP,
        observation: 'decided elsewhere and recorded by reference',
        skipReason: SKIP_REASON.DECIDED_BY_REFERENCE,
      },
      [SAMPLE_FAIL_ID]: {
        status: CHECK_STATUS.SKIP,
        observation: 'mongosh absent',
        skipReason: SKIP_REASON.OPTIONAL_DEPENDENCY_ABSENT,
      },
    });
    const outcome = runOutcome(allSkip);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.nothingExecuted).toBe(true);
    expect(outcome.executedCount).toBe(0);
    expect(outcome.hasCheckFailure).toBe(false);
  });

  test('runOutcome: a non-enumerated (NOT_EXECUTED) skip is a masquerading setup failure that blocks exit 0', () => {
    const withNotExecuted = buildRecords({
      [SAMPLE_PASS_ID]: { status: CHECK_STATUS.PASS },
      [SAMPLE_FAIL_ID]: {
        status: CHECK_STATUS.SKIP,
        observation: 'topology absent; live check never registered',
        skipReason: SKIP_REASON.NOT_EXECUTED,
      },
    });
    const outcome = runOutcome(withNotExecuted);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.hasSetupFailure).toBe(true);
    expect(outcome.hasCheckFailure).toBe(false);
    expect(outcome.nonEnumeratedSkipIds).toContain(SAMPLE_FAIL_ID);
  });

  test('buildCheckRecord: a skip requires an enumerated-or-not skipReason; a pass rejects one', () => {
    // A skip with no skipReason is rejected — the exit gate reads the tag, so it must be present.
    expect(() =>
      buildCheckRecord(SAMPLE_FAIL_ID, { status: CHECK_STATUS.SKIP, observation: 'why' }),
    ).toThrow(/skipReason/);
    // A pass carrying a skipReason is rejected — only a skip names why it did not run.
    expect(() =>
      buildCheckRecord(SAMPLE_PASS_ID, {
        status: CHECK_STATUS.PASS,
        skipReason: SKIP_REASON.EXTERNAL_PROVIDER_REQUIRED,
      }),
    ).toThrow(/skipReason/);
    // A well-formed skip carries the tag onto the record.
    const skip = buildCheckRecord(SAMPLE_FAIL_ID, {
      status: CHECK_STATUS.SKIP,
      observation: 'requires an external provider the harness does not stand up',
      skipReason: SKIP_REASON.EXTERNAL_PROVIDER_REQUIRED,
    });
    expect(skip.skipReason).toBe(SKIP_REASON.EXTERNAL_PROVIDER_REQUIRED);
  });

  test('decideRecordShape passes; a fail record carries its observation and a pass carries none', () => {
    expect(decideRecordShape().ok).toBe(true);
    const pass = buildCheckRecord(SAMPLE_PASS_ID, { status: CHECK_STATUS.PASS });
    expect(pass.observation).toBeNull();
    const fail = buildCheckRecord(SAMPLE_FAIL_ID, {
      status: CHECK_STATUS.FAIL,
      observation: 'why',
    });
    expect(fail.observation).toBe('why');
    expect(fail.requirements.length).toBeGreaterThan(0);
  });

  test('decideJsonWellFormed passes and the summary round-trips carrying the failed observation', () => {
    expect(decideJsonWellFormed().ok).toBe(true);
  });

  test('decideNoInteractivePrompts passes on the real entry command and fails on an injected prompt', () => {
    const runSource = readFileSync(RUN_MJS, 'utf8');
    const packageJsonText = readFileSync(PACKAGE_JSON, 'utf8');
    expect(decideNoInteractivePrompts({ runSource, packageJsonText }).ok).toBe(true);

    // A runner source that reads stdin interactively must fail.
    const withPrompt = `${runSource}\nprocess.stdin.on('data', () => {});\n`;
    expect(decideNoInteractivePrompts({ runSource: withPrompt, packageJsonText }).ok).toBe(false);

    // A readline question must fail.
    const withReadline = `${runSource}\nimport readline from 'node:readline';\n`;
    expect(decideNoInteractivePrompts({ runSource: withReadline, packageJsonText }).ok).toBe(false);

    // A script that wraps the runner in an interactive docker flag must fail.
    const badPkg = JSON.stringify({
      scripts: { [ENTRY_SCRIPT_NAME]: `docker run -it x && ${ENTRY_COMMAND}` },
    });
    expect(decideNoInteractivePrompts({ runSource, packageJsonText: badPkg }).ok).toBe(false);

    // A missing script must fail.
    expect(decideNoInteractivePrompts({ runSource, packageJsonText: '{"scripts":{}}' }).ok).toBe(
      false,
    );

    // A script that does not invoke the documented entry command must fail.
    const wrongCmd = JSON.stringify({
      scripts: { [ENTRY_SCRIPT_NAME]: 'node something-else.mjs' },
    });
    expect(decideNoInteractivePrompts({ runSource, packageJsonText: wrongCmd }).ok).toBe(false);
  });

  test('decideArtifactWellFormed passes on a well-formed artifact and fails on malformed or wrong-schema', () => {
    const good = JSON.stringify({
      schema: 'container-split-run-report/1',
      outcome: { ok: true, exitCode: 0, tally: {} },
      checks: {},
    });
    expect(decideArtifactWellFormed(good).ok).toBe(true);

    // Not JSON at all.
    expect(decideArtifactWellFormed('not json').ok).toBe(false);

    // Wrong schema tag.
    const wrongSchema = JSON.stringify({ schema: 'other/9', outcome: { exitCode: 0 }, checks: {} });
    expect(decideArtifactWellFormed(wrongSchema).ok).toBe(false);

    // No numeric exit code.
    const noExit = JSON.stringify({
      schema: 'container-split-run-report/1',
      outcome: {},
      checks: {},
    });
    expect(decideArtifactWellFormed(noExit).ok).toBe(false);
  });
});
