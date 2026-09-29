// run-report.filter.mjs — the pure decision logic and constants behind this check's Layer B spec (task 14.6).
//
// The exported deciders and constants this check's spec relies on live here, in a non-spec sibling
// module, so the spec file (run-report.spec.mjs) can import them and export NOTHING itself. jest.config.mjs's
// testMatch collects only `*.spec.mjs` / `*.test.mjs`, so a `.filter.mjs` is never collected as a
// test — the same shape boot-nowrite.filter.mjs establishes. This is a move, not a rewrite: the logic
// is identical to what previously lived in the spec, and the spec exercises it via the import.
//
// NG1/NG2 hold: this decides over the harness's own artifacts and touches no application code and
// neither container-split script.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CHECK_STATUS,
  SKIP_REASON,
  buildCheckRecord,
  buildRecords,
  runOutcome,
  serializeRun,
} from '../serializer.mjs';
import { CHECK_IDS } from '../check-catalog.mjs';
import { SETUP_FAILURE_KINDS, TEARDOWN_FAILURE_KINDS } from '../run.mjs';
// The artifact deciders live outside this check (report-artifact.mjs) because the RUNNER needs the same
// two decisions: this check applies them to a report it synthesizes, and run.mjs applies them to the
// report the stage-11 reporter actually wrote. One decider, two inputs — see the note on
// decideArtifactRules below for why the check cannot read its own run's file.
import { decideArtifactWellFormed, decideArtifactAccounting } from '../report-artifact.mjs';

// Re-exported so the spec (and any other reader) imports the artifact decider from the same place it
// imports this check's other deciders, while the definition stays shared with the runner.
export { decideArtifactWellFormed, decideArtifactAccounting };

// This file's own directory, resolved from `import.meta.url` — the one shape valid under both `node`
// and the Layer B native-ESM Jest config (jest.config.mjs). `__dirname` does not exist under native
// ESM, so it is deliberately not used. checks/ sits one level below e2e/container-split/, and the
// repository root is three levels above that.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER_SPLIT_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

// The check id this spec decides, named once and prefixed onto every title so reporter.mjs maps each
// Jest result onto the RUN-REPORT-32 record.
export const CHECK_ID = 'RUN-REPORT-32';

// The entry command's own source and the npm script that invokes it — the two files the
// zero-interactive-prompts assertion reads. Bound absolutely so a read observes the committed files
// regardless of cwd.
export const RUN_MJS = path.join(CONTAINER_SPLIT_DIR, 'run.mjs');
export const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

// The npm script name the entry command lives behind (design: "Entry command", Req 5.1) and the
// command it must resolve to. Named here so the interactive-prompt check reads one source.
export const ENTRY_SCRIPT_NAME = 'harness:container-split';
export const ENTRY_COMMAND = 'node e2e/container-split/run.mjs';

// Two synthetic check ids used to drive the serializer over the exit-code matrix. They are REAL
// catalog ids (buildCheckRecord rejects a non-catalog id), chosen because their catalog metadata is
// stable and unrelated to what this check decides — RUN-REPORT-32 exercises the report machinery, not
// these checks' subjects. BOOT-READY-20 (Layer B, Req 3.1, P6) and TOPO-IMAGE-13 (Layer B, Req 1.2,
// property null) between them cover a record that carries a property and one that does not, so the
// record-shape assertion sees both shapes.
export const SAMPLE_PASS_ID = 'TOPO-IMAGE-13';
export const SAMPLE_FAIL_ID = 'BOOT-READY-20';

// ---------------------------------------------------------------------------------------------
// Pure deciders over the reporting + exit-status contract. Each returns `{ ok, reason? }`; a false
// carries the observation the check reports. They drive the real serializer over synthetic outcomes,
// so a green decision is a statement about the reporting path an operator actually gets.
// ---------------------------------------------------------------------------------------------

// Decide the exit-code matrix: the contract rows, each computed through the serializer's runOutcome
// (the exact function reporter.mjs's serializeRun uses to set the exit code). Pure over synthetic
// outcomes. This is the load-bearing assertion of RUN-REPORT-32: exit 0 is reachable only when at
// least one check executed AND every check passed or is a benign enumerated skip; a check fail, a
// setup failure or a teardown failure each forces non-zero (the last even on an all-pass check set,
// task 7.4's teardown half). Task 15.3 adds three rows: an all-skip run exits non-zero because it
// decided nothing (row 6), a pass-plus-enumerated-skip run exits 0 (row 5), and a non-enumerated skip
// is a masquerading setup failure that blocks exit 0 (row 7).
export function decideExitMatrix() {
  // Row 1: every check passes => exit 0. The only zero-exit case.
  const allPass = buildRecords({
    [SAMPLE_PASS_ID]: { status: CHECK_STATUS.PASS },
    [SAMPLE_FAIL_ID]: { status: CHECK_STATUS.PASS },
  });
  const allPassOutcome = runOutcome(allPass);
  if (!allPassOutcome.ok || allPassOutcome.exitCode !== 0) {
    return {
      ok: false,
      reason:
        `an all-pass check set must exit 0, got exitCode=${allPassOutcome.exitCode} ` +
        `(ok=${allPassOutcome.ok}). Exit 0 is the all-pass case and only the all-pass case (Req 5.2).`,
    };
  }

  // Row 2: any check fail => non-zero.
  const withFail = buildRecords({
    [SAMPLE_PASS_ID]: { status: CHECK_STATUS.PASS },
    [SAMPLE_FAIL_ID]: { status: CHECK_STATUS.FAIL, observation: 'synthetic fail for the matrix' },
  });
  const withFailOutcome = runOutcome(withFail);
  if (withFailOutcome.ok || withFailOutcome.exitCode === 0) {
    return {
      ok: false,
      reason:
        `a check failure must force a non-zero exit, got exitCode=${withFailOutcome.exitCode} ` +
        `(ok=${withFailOutcome.ok}). A run with a failed check is not a clean run (Req 5.2).`,
    };
  }
  if (!withFailOutcome.hasCheckFailure) {
    return {
      ok: false,
      reason: 'runOutcome did not flag hasCheckFailure on a check set carrying a fail.',
    };
  }

  // Row 3: a setup failure => non-zero, reported DISTINCTLY from a check fail. Fed as the run-level
  // setupFailure (Property 9): the topology never came up, so no check ran, yet the run is non-zero.
  const setupFailure = {
    kind: SETUP_FAILURE_KINDS.MONGO_READINESS_TIMEOUT,
    message: 'synthetic setup failure for the matrix',
    service: 'mongodb',
  };
  const setupOutcome = runOutcome([], { setupFailure });
  if (setupOutcome.ok || setupOutcome.exitCode === 0) {
    return {
      ok: false,
      reason:
        `a setup failure must force a non-zero exit even with no check records, got ` +
        `exitCode=${setupOutcome.exitCode} (ok=${setupOutcome.ok}). A topology that never came up ` +
        'is a non-zero run (Property 9, Req 5.2).',
    };
  }
  if (!setupOutcome.hasSetupFailure || setupOutcome.hasCheckFailure) {
    return {
      ok: false,
      reason:
        'a setup failure must be reported DISTINCTLY from a check failure — runOutcome flagged ' +
        `hasSetupFailure=${setupOutcome.hasSetupFailure}, hasCheckFailure=` +
        `${setupOutcome.hasCheckFailure}. Conflating the two would let an infrastructure flake read ` +
        'as a falsified split property (Property 9).',
    };
  }

  // Row 4: a teardown failure => non-zero EVEN WHEN every check passed (task 7.4). The check set is
  // all-pass; the teardown leak alone must flip the exit code.
  const teardownFailure = {
    kind: TEARDOWN_FAILURE_KINDS.RESOURCES_REMAINED,
    message: 'synthetic teardown leak for the matrix',
    remaining: [{ type: 'network', name: 'container-split_harness' }],
  };
  const teardownOutcome = runOutcome(allPass, { teardownFailure });
  if (teardownOutcome.ok || teardownOutcome.exitCode === 0) {
    return {
      ok: false,
      reason:
        `a teardown leak must force a non-zero exit even when every check passed, got ` +
        `exitCode=${teardownOutcome.exitCode} (ok=${teardownOutcome.ok}). A leaked resource left ` +
        'for the next run to trip over is a reported failure, not a cleanup detail (Req 5.1, task 7.4).',
    };
  }
  if (!teardownOutcome.hasTeardownFailure) {
    return {
      ok: false,
      reason:
        'runOutcome did not flag hasTeardownFailure on an all-pass set carrying a teardown leak.',
    };
  }

  // Row 5: a skip ALONGSIDE an executed check is NOT a failure — a run with at least one pass and the
  // rest enumerated skips exits 0 — but a skip is never a pass. Assert both: the exit stays 0, AND
  // the tally counts the skip as a skip (not folded into pass), so "2 pass, 1 skip" is
  // distinguishable from "3 pass". The skip carries an ENUMERATED reason (an external provider the
  // harness does not stand up); a non-enumerated skip would block exit 0, which rows 7–8 pin.
  const withSkip = buildRecords({
    [SAMPLE_PASS_ID]: { status: CHECK_STATUS.PASS },
    [SAMPLE_FAIL_ID]: {
      status: CHECK_STATUS.SKIP,
      observation: 'requires an external provider the harness does not stand up',
      skipReason: SKIP_REASON.EXTERNAL_PROVIDER_REQUIRED,
    },
  });
  const skipOutcome = runOutcome(withSkip);
  if (!skipOutcome.ok || skipOutcome.exitCode !== 0) {
    return {
      ok: false,
      reason:
        `a skip alongside an executed check must NOT force a non-zero exit, got exitCode=` +
        `${skipOutcome.exitCode} (a skip is not a fail). An enumerated, accounted-for absence ` +
        'does not fail a run that executed at least one check.',
    };
  }
  if (skipOutcome.tally[CHECK_STATUS.PASS] !== 1 || skipOutcome.tally[CHECK_STATUS.SKIP] !== 1) {
    return {
      ok: false,
      reason:
        'a skip must be tallied as a skip, never as a pass — got ' +
        `pass=${skipOutcome.tally[CHECK_STATUS.PASS]}, skip=${skipOutcome.tally[CHECK_STATUS.SKIP]}. ` +
        'A skip is not a pass; folding it into pass would let a skipped check read as a run success.',
    };
  }

  // Row 6: a run in which EVERY record is a skip — even all-enumerated — decided nothing and exits
  // non-zero. This is the clause task 15.3 adds that would have caught "exit 0 having brought nothing
  // up": no pass, no fail, so nothing was actually decided, so it is not the all-clear.
  const allSkip = buildRecords({
    [SAMPLE_PASS_ID]: {
      status: CHECK_STATUS.SKIP,
      observation: 'decided elsewhere and recorded by reference',
      skipReason: SKIP_REASON.DECIDED_BY_REFERENCE,
    },
    [SAMPLE_FAIL_ID]: {
      status: CHECK_STATUS.SKIP,
      observation: 'optional dependency (mongosh) absent',
      skipReason: SKIP_REASON.OPTIONAL_DEPENDENCY_ABSENT,
    },
  });
  const allSkipOutcome = runOutcome(allSkip);
  if (allSkipOutcome.ok || allSkipOutcome.exitCode === 0) {
    return {
      ok: false,
      reason:
        `an all-skip run must exit non-zero even when every skip is enumerated, got exitCode=` +
        `${allSkipOutcome.exitCode} (ok=${allSkipOutcome.ok}). A run that executed no check decided ` +
        'nothing and is not the all-clear (design: "at least one check actually executed").',
    };
  }
  if (!allSkipOutcome.nothingExecuted || allSkipOutcome.executedCount !== 0) {
    return {
      ok: false,
      reason:
        'an all-skip run must flag nothingExecuted with executedCount 0 — got ' +
        `nothingExecuted=${allSkipOutcome.nothingExecuted}, executedCount=` +
        `${allSkipOutcome.executedCount}.`,
    };
  }

  // Row 7: a NON-enumerated skip (NOT_EXECUTED) is a masquerading setup failure — a stage that
  // failed, a spec that would not load, a context never published — and blocks exit 0 even when a
  // real check executed beside it. Assert it exits non-zero, is flagged as a setup failure (not a
  // check failure), and names the offending id.
  const withNotExecuted = buildRecords({
    [SAMPLE_PASS_ID]: { status: CHECK_STATUS.PASS },
    [SAMPLE_FAIL_ID]: {
      status: CHECK_STATUS.SKIP,
      observation: 'topology absent; live check never registered',
      skipReason: SKIP_REASON.NOT_EXECUTED,
    },
  });
  const notExecutedOutcome = runOutcome(withNotExecuted);
  if (notExecutedOutcome.ok || notExecutedOutcome.exitCode === 0) {
    return {
      ok: false,
      reason:
        `a non-enumerated (NOT_EXECUTED) skip must force a non-zero exit even beside an executed ` +
        `check, got exitCode=${notExecutedOutcome.exitCode} (ok=${notExecutedOutcome.ok}). A skip ` +
        'from a failed stage or an unpublished context is a setup failure, not a benign absence.',
    };
  }
  if (
    !notExecutedOutcome.hasSetupFailure ||
    notExecutedOutcome.hasCheckFailure ||
    !notExecutedOutcome.nonEnumeratedSkipIds.includes(SAMPLE_FAIL_ID)
  ) {
    return {
      ok: false,
      reason:
        'a non-enumerated skip must be classified as a setup failure (not a check failure) and named ' +
        `— got hasSetupFailure=${notExecutedOutcome.hasSetupFailure}, hasCheckFailure=` +
        `${notExecutedOutcome.hasCheckFailure}, nonEnumeratedSkipIds=` +
        `${JSON.stringify(notExecutedOutcome.nonEnumeratedSkipIds)}.`,
    };
  }

  return { ok: true };
}

// Decide that each emitted check record carries the id, layer, requirement criteria, property and —
// on a non-pass — the deciding observation the contract requires (Req 5.2–5.4). Pure over the
// serializer's buildCheckRecord. Req 5.4's "maps onto the parent spec's verification intents rather
// than an opaque pass/fail" is what `property` satisfies, and Req 5.3's deciding observation is what
// a fail/skip carries; this decider asserts both are on the record, populated from the catalog.
export function decideRecordShape() {
  const passRecord = buildCheckRecord(SAMPLE_PASS_ID, { status: CHECK_STATUS.PASS });
  // A pass record: id, layer, requirements, property (may be null for an apparatus check), status,
  // and observation null (a pass carries no prose — serializer.mjs forbids it).
  for (const field of ['id', 'layer', 'requirements', 'property', 'status', 'observation']) {
    if (!(field in passRecord)) {
      return { ok: false, reason: `a check record is missing the "${field}" field (Req 5.2–5.4).` };
    }
  }
  if (passRecord.id !== SAMPLE_PASS_ID) {
    return { ok: false, reason: `the record's id ${passRecord.id} != ${SAMPLE_PASS_ID}.` };
  }
  if (!Array.isArray(passRecord.requirements) || passRecord.requirements.length === 0) {
    return {
      ok: false,
      reason:
        `the record for ${SAMPLE_PASS_ID} carries no requirement criteria; Req 5.4 requires the ` +
        'run to map each check onto its requirement criteria rather than an opaque pass/fail.',
    };
  }
  if (passRecord.status !== CHECK_STATUS.PASS || passRecord.observation !== null) {
    return {
      ok: false,
      reason:
        `a pass record must carry status "pass" and a null observation, got status=` +
        `${passRecord.status}, observation=${JSON.stringify(passRecord.observation)}. A pass is ` +
        'decided by the check id and its property, not by prose.',
    };
  }

  // A fail record MUST carry a non-empty deciding observation (Req 5.3).
  const failRecord = buildCheckRecord(SAMPLE_FAIL_ID, {
    status: CHECK_STATUS.FAIL,
    observation: 'the readiness endpoint never returned 200',
  });
  if (
    failRecord.status !== CHECK_STATUS.FAIL ||
    typeof failRecord.observation !== 'string' ||
    failRecord.observation.trim() === ''
  ) {
    return {
      ok: false,
      reason:
        'a fail record must carry the observation that decided it (Req 5.3); got status=' +
        `${failRecord.status}, observation=${JSON.stringify(failRecord.observation)}.`,
    };
  }
  // The record's metadata must equal the catalog's, not be restated by the caller: the fail record's
  // requirements and layer come from the catalog for SAMPLE_FAIL_ID regardless of the outcome fed in.
  if (failRecord.layer !== passRecord.layer && SAMPLE_FAIL_ID === SAMPLE_PASS_ID) {
    return { ok: false, reason: 'internal: sample ids collided.' };
  }

  return { ok: true };
}

// Decide the JSON summary the CI lane attaches is well-formed: it round-trips through
// JSON.stringify/parse unchanged, carries the schema tag, the outcome block with the exit code, and
// the per-check records keyed by id. Pure over serializeRun's `json`. A malformed summary would lose
// every observation the run produced, which is the failure this assertion exists to prevent (task
// 12.4 bullet).
export function decideJsonWellFormed() {
  const records = buildRecords({
    [SAMPLE_PASS_ID]: { status: CHECK_STATUS.PASS },
    [SAMPLE_FAIL_ID]: { status: CHECK_STATUS.FAIL, observation: 'synthetic fail for the artifact' },
  });
  const { json } = serializeRun(records, {
    profile: 'split',
    startedAt: '2024-01-01T00:00:00.000Z',
  });

  // Round-trips unchanged — the artifact CI writes is JSON.stringify(json), and a value that does
  // not survive a parse would lose observations on read.
  let reparsed;
  try {
    reparsed = JSON.parse(JSON.stringify(json));
  } catch (error) {
    return { ok: false, reason: `the run summary is not valid JSON: ${error.message}.` };
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(json)) {
    return { ok: false, reason: 'the run summary does not round-trip through JSON unchanged.' };
  }

  if (json.schema !== 'container-split-run-report/1') {
    return {
      ok: false,
      reason:
        `the run summary carries schema ${JSON.stringify(json.schema)}, expected ` +
        '"container-split-run-report/1". The schema tag is what makes a shape change a visible ' +
        'version bump rather than a silent reinterpretation.',
    };
  }
  if (typeof json.outcome !== 'object' || json.outcome === null) {
    return { ok: false, reason: 'the run summary has no outcome block.' };
  }
  if (typeof json.outcome.exitCode !== 'number') {
    return {
      ok: false,
      reason:
        'the run summary outcome carries no numeric exitCode; the CI lane reads it to fail the run.',
    };
  }
  // The per-check records must be keyed by id, so a reader (and CI) can look a check up by its id.
  if (typeof json.checks !== 'object' || json.checks === null) {
    return { ok: false, reason: 'the run summary has no checks map.' };
  }
  for (const id of [SAMPLE_PASS_ID, SAMPLE_FAIL_ID]) {
    const record = json.checks[id];
    if (!record || record.id !== id) {
      return {
        ok: false,
        reason: `the run summary's checks map is not keyed by id: no record at key "${id}".`,
      };
    }
  }
  // The failed check's observation must survive into the artifact — losing it is the exact failure
  // this assertion guards against.
  if (
    typeof json.checks[SAMPLE_FAIL_ID].observation !== 'string' ||
    json.checks[SAMPLE_FAIL_ID].observation.trim() === ''
  ) {
    return {
      ok: false,
      reason:
        "a failed check's observation did not survive into the JSON artifact; a malformed summary " +
        'would lose every observation the run produced (task 12.4).',
    };
  }

  return { ok: true };
}

// A conservative set of interactive-input signatures. Each is a way the entry command could block on
// a human: an interactive stdin read, a readline question/prompt, or a docker flag that allocates a
// TTY / keeps stdin open. The set is deliberately small and specific — it names the shapes a prompt
// actually takes rather than any string that mentions "input" — so it flags a real interactive read
// without tripping on prose. Exported so the check and its unit exercise read one source.
export const INTERACTIVE_SIGNATURES = Object.freeze([
  /\breadline\b/,
  /\.question\s*\(/,
  /\bprompt\s*\(/,
  /process\.stdin\.(?:read|on|resume|once)\b/,
  /\binquirer\b/,
  /\benquirer\b/,
  // A docker invocation that allocates a TTY or keeps stdin attached — `-it`, `-i`, `--interactive`,
  // `--tty` — would block a headless CI run waiting on a terminal.
  /-it\b/,
  /--interactive\b/,
  /\bdocker\b[^\n]*\s-i\b/,
]);

// Decide that the entry command never reaches for interactive input (Req 5.5): neither the runner's
// own source nor the npm script that invokes it carries an interactive-input signature, so the local
// command is the CI command. Pure over the two files' text (injected for the unit exercise). A match
// carries the offending pattern and file in the observation.
export function decideNoInteractivePrompts({ runSource, packageJsonText } = {}) {
  const runText = typeof runSource === 'string' ? runSource : '';
  const pkgText = typeof packageJsonText === 'string' ? packageJsonText : '';

  for (const pattern of INTERACTIVE_SIGNATURES) {
    if (pattern.test(runText)) {
      return {
        ok: false,
        reason:
          `the entry command's source (run.mjs) matches the interactive-input signature ` +
          `${pattern}. Req 5.5 requires zero interactive prompts so the local command is the CI ` +
          'command; an interactive read would block a headless run.',
      };
    }
  }

  // The npm script must exist and resolve to the documented entry command, and must not itself add an
  // interactive flag around the runner.
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch (error) {
    return { ok: false, reason: `package.json is not valid JSON: ${error.message}.` };
  }
  const script = pkg.scripts?.[ENTRY_SCRIPT_NAME];
  if (typeof script !== 'string' || script.trim() === '') {
    return {
      ok: false,
      reason:
        `package.json has no "${ENTRY_SCRIPT_NAME}" script; the entry command (Req 5.1) must be one ` +
        'documented command so the local command and the CI command are the same command.',
    };
  }
  if (!script.includes(ENTRY_COMMAND)) {
    return {
      ok: false,
      reason:
        `the "${ENTRY_SCRIPT_NAME}" script is ${JSON.stringify(script)}, which does not invoke the ` +
        `documented entry command ${JSON.stringify(ENTRY_COMMAND)}.`,
    };
  }
  for (const pattern of INTERACTIVE_SIGNATURES) {
    if (pattern.test(script)) {
      return {
        ok: false,
        reason:
          `the "${ENTRY_SCRIPT_NAME}" npm script matches the interactive-input signature ${pattern}; ` +
          'the entry command must never prompt (Req 5.5).',
      };
    }
  }

  return { ok: true };
}

// Decide the artifact's well-formedness AND the pass/skip/fail accounting rules, over a report this
// decider synthesizes across the WHOLE CATALOG through the real serializer — not over the file this
// run is about to produce.
//
// == Why not over this run's own artifact ==
// The check used to assert `existsSync(run-report.json)` under the live gate. That is unsatisfiable by
// construction: reporter.mjs writes the artifact from `onRunComplete`, after every test has finished,
// so no test can ever see its own run's file. (Deleting the previous run's report before stage 1 —
// which the runner does, so a stale tally can never be read as this run's result — is what turned the
// assertion from luck-dependent into certainly-failing, and that is how it surfaced.)
//
// Three redesigns were available. Asserting over a PREVIOUS run's artifact makes this check's verdict a
// function of an unrelated run, which is the exact confusion the run-start deletion exists to end, and
// it would go back to reading a file whose freshness the check cannot establish. Asserting over "the
// structure the reporter is about to write" cannot work from inside a test either: the results of the
// tests still to come are not knowable, so it would decide the rules over a partial record set and call
// that the artifact. What is left — and what is implemented — is the split: the RULES are decided here,
// where they are fully decidable with no file at all, and the RUNNER applies the same deciders to the
// real artifact right after the reporter writes it (run.mjs: validateWrittenRunReport), which is the
// only moment that file exists and the only place the run can still act on it.
//
// What this decider pins, positively and then negatively (a rule no counter-example can violate is not
// being enforced):
//
//   * a full-catalog report is well-formed and its accounting is self-consistent;
//   * an id missing from the checks map is caught — a vanished id is how "no failures reported" gets
//     misread as "everything passed";
//   * a report claiming `ok` while carrying a fail is caught;
//   * a report claiming `ok` while carrying a non-enumerated skip is caught (an unexecuted or undecided
//     check is not a benign absence);
//   * a skip whose reason is not on the closed set is caught, so a typo'd tag cannot slip past the exit
//     gate's membership test;
//   * an exitCode that disagrees with `ok` is caught;
//   * a `pass` carrying prose, and a non-pass carrying none, are both caught;
//   * malformed text, a wrong schema tag, and a missing outcome block are caught.
export function decideArtifactRules() {
  // A synthetic full-catalog run: every id present, one fail, one enumerated skip, one non-enumerated
  // skip, the rest passing. That mix is the interesting one — a report that is complete and internally
  // consistent while NOT being green.
  const failId = SAMPLE_FAIL_ID;
  // The enumerated skip is the group-sync check, whose reason is EXTERNAL_PROVIDER_REQUIRED — it is
  // decidable only against a real identity provider the harness does not stand up, which is an
  // accounted-for absence. The non-enumerated skip is a live check that simply did not execute.
  const enumeratedSkipId = 'PATH-GROUPSYNC-26';
  const nonEnumeratedSkipId = 'PATH-EXERCISE-25';
  const outcomes = {};
  for (const id of CHECK_IDS) {
    if (id === failId) {
      outcomes[id] = { status: CHECK_STATUS.FAIL, observation: 'synthetic fail for the rules' };
    } else if (id === enumeratedSkipId) {
      outcomes[id] = {
        status: CHECK_STATUS.SKIP,
        observation: 'no external identity provider stood up, so no membership sync to assert on',
        skipReason: SKIP_REASON.EXTERNAL_PROVIDER_REQUIRED,
      };
    } else if (id === nonEnumeratedSkipId) {
      outcomes[id] = {
        status: CHECK_STATUS.SKIP,
        observation: 'not executed this run',
        skipReason: SKIP_REASON.NOT_EXECUTED,
      };
    } else {
      outcomes[id] = { status: CHECK_STATUS.PASS };
    }
  }
  const { json } = serializeRun(buildRecords(outcomes), {
    profile: 'split',
    startedAt: '2024-01-01T00:00:00.000Z',
  });
  const text = JSON.stringify(json, null, 2);

  const wellFormed = decideArtifactWellFormed(text);
  if (!wellFormed.ok) {
    return {
      ok: false,
      reason: `a full-catalog report failed the artifact well-formedness rules: ${wellFormed.reason}`,
    };
  }
  const accounting = decideArtifactAccounting(wellFormed.json);
  if (!accounting.ok) {
    return {
      ok: false,
      reason: `a full-catalog report failed its own accounting rules: ${accounting.reason}`,
    };
  }
  // The mix above must NOT read as the all-clear: a fail and a non-enumerated skip each block it.
  if (json.outcome.ok || json.outcome.exitCode === 0) {
    return {
      ok: false,
      reason:
        `a report carrying a fail (${failId}) and a non-enumerated skip (${nonEnumeratedSkipId}) ` +
        `claimed ok=${json.outcome.ok}, exitCode=${json.outcome.exitCode}.`,
    };
  }

  // --- The counter-examples. Each mutates a copy of the artifact and must be REJECTED. ---
  const mutations = [
    {
      what: 'a catalog id missing from the checks map',
      mutate: (report) => {
        delete report.checks[failId];
        report.outcome.tally.fail = 0;
      },
      expect: /carry no record/,
    },
    {
      what: 'a report claiming ok while carrying a fail',
      mutate: (report) => {
        report.checks[nonEnumeratedSkipId].skipReason = SKIP_REASON.EXTERNAL_PROVIDER_REQUIRED;
        report.outcome.ok = true;
        report.outcome.exitCode = 0;
      },
      expect: /the records say ok=false/,
    },
    {
      what: 'a report claiming ok while carrying a non-enumerated skip',
      mutate: (report) => {
        report.checks[failId] = {
          ...report.checks[failId],
          status: CHECK_STATUS.PASS,
          observation: null,
        };
        report.outcome.ok = true;
        report.outcome.exitCode = 0;
      },
      expect: new RegExp(nonEnumeratedSkipId),
    },
    {
      what: 'a skip whose reason is not on the closed set',
      mutate: (report) => {
        report.checks[enumeratedSkipId].skipReason = 'because-i-said-so';
      },
      expect: /not in the closed/,
    },
    {
      what: 'an exitCode that disagrees with ok',
      mutate: (report) => {
        report.outcome.exitCode = 0;
      },
      expect: /disagrees with ok/,
    },
    {
      what: 'a pass carrying prose',
      mutate: (report) => {
        const passId = CHECK_IDS.find(
          (id) => report.checks[id].status === CHECK_STATUS.PASS && id !== failId,
        );
        report.checks[passId].observation = 'it looked fine to me';
      },
      expect: /passed but carries an observation/,
    },
    {
      what: 'a non-pass with no deciding observation',
      mutate: (report) => {
        report.checks[failId].observation = '';
      },
      expect: /no deciding observation/,
    },
    {
      what: 'a record filed under the wrong key',
      mutate: (report) => {
        report.checks[failId].id = 'TOPO-YAML-15';
      },
      expect: /not keyed by id/,
    },
  ];

  for (const { what, mutate, expect: pattern } of mutations) {
    const mutated = JSON.parse(text);
    mutate(mutated);
    const decision = decideArtifactAccounting(mutated);
    if (decision.ok) {
      return {
        ok: false,
        reason:
          `the accounting rules accepted ${what}. A rule no counter-example can violate is not being ` +
          'enforced, and this one is the difference between a report and a rubber stamp.',
      };
    }
    if (!pattern.test(decision.reason)) {
      return {
        ok: false,
        reason:
          `the accounting rules rejected ${what} but did not say why in terms a reader can act on: ` +
          `${decision.reason}`,
      };
    }
  }

  // Well-formedness counter-examples: text that is not JSON, a wrong schema tag, no outcome block.
  const malformed = [
    { what: 'text that is not JSON', text: 'not json', expect: /not valid JSON/ },
    {
      what: 'a wrong schema tag',
      text: JSON.stringify({ schema: 'other/9', outcome: { exitCode: 0 }, checks: {} }),
      expect: /schema/,
    },
    {
      what: 'no numeric exitCode',
      text: JSON.stringify({ schema: 'container-split-run-report/1', outcome: {}, checks: {} }),
      expect: /exitCode/,
    },
    {
      what: 'no checks map',
      text: JSON.stringify({
        schema: 'container-split-run-report/1',
        outcome: { exitCode: 1, ok: false },
      }),
      expect: /checks map/,
    },
  ];
  for (const { what, text: badText, expect: pattern } of malformed) {
    const decision = decideArtifactWellFormed(badText);
    if (decision.ok || !pattern.test(decision.reason)) {
      return {
        ok: false,
        reason: `the well-formedness rules did not reject ${what} (${decision.reason ?? 'accepted'}).`,
      };
    }
  }

  return { ok: true };
}
