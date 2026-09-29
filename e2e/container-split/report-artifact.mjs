// report-artifact.mjs — what makes a run-report.json trustworthy, decided over the artifact's text.
//
// Two deciders live here, both pure over a serialized report, and both consumed twice:
//
//   * decideArtifactWellFormed(text) — the artifact parses, carries the schema tag, an outcome block
//     with a numeric exit code, and a checks map keyed by id. A malformed artifact loses every
//     observation the run produced.
//   * decideArtifactAccounting(json) — the ACCOUNTING RULES the report exists to uphold: every catalog
//     id has a record (a vanished id is how "no failures reported" gets misread as "everything
//     passed"), no record is a status the vocabulary does not define, every skip names a reason from
//     the closed set, `ok` is true only when at least one check executed and nothing failed and every
//     skip reason is enumerated, and the exit code agrees with `ok`.
//
// == Why they live here rather than in the check that asserts them ==
// RUN-REPORT-32 used to assert `existsSync(run-report.json)` under the live gate. That was
// unsatisfiable by construction: the reporter writes the artifact in `onRunComplete`, AFTER every test
// has finished, so no test can ever see its own run's file. Deleting the stale report at run start
// (which the runner does, so a reader cannot mistake an old tally for this run's) turned that check
// from luck-dependent into certainly-failing.
//
// So the check is split, and the split is the whole point of this module:
//
//   * The CHECK (checks/run-report.spec.mjs, inside the Jest run) decides these rules over a report it
//     SYNTHESIZES through the real serializer, covering the whole catalog. It needs no file, so it
//     asserts what it means to assert — the artifact's well-formedness and the pass/skip/fail
//     accounting rules — without depending on its own run's output.
//   * The RUNNER (run.mjs, stage 11 tail) decides the same rules over the file the reporter actually
//     wrote, at the only moment that file exists, and folds the report's own exit code into the run's
//     exit status.
//
// One decider, two inputs. The alternative designs were considered and rejected: asserting over a
// PREVIOUS run's artifact makes a check's verdict a function of an unrelated run (the exact confusion
// the run-start deletion exists to end), and asserting over "the structure the reporter is about to
// write" from inside a test cannot see the results of the tests still to come, so it would decide the
// rules over a partial record set and call it the artifact.
//
// NG1/NG2 hold: this decides over the harness's own artifact. It touches no application code and
// neither container-split script.

import { CHECK_STATUS, ENUMERATED_SKIP_REASONS, SKIP_REASON } from './serializer.mjs';
import { CHECK_IDS } from './check-catalog.mjs';

// The schema tag serializer.mjs stamps. Named here so both the writer's consumers and this validator
// read one string; a mismatch is a visible version bump rather than a silent reinterpretation.
export const RUN_REPORT_SCHEMA = 'container-split-run-report/1';

const ALL_STATUSES = Object.freeze(Object.values(CHECK_STATUS));
const ALL_SKIP_REASONS = Object.freeze(Object.values(SKIP_REASON));

// Decide a run-report artifact's well-formedness from its TEXT. Pure; returns `{ ok, reason?, json? }`
// so a caller that needs the parsed report (the accounting decider) gets it without parsing twice.
export function decideArtifactWellFormed(artifactText) {
  const text = typeof artifactText === 'string' ? artifactText : '';
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason:
        `run-report.json is not valid JSON: ${error.message}. The CI lane attaches this file; a ` +
        'malformed artifact loses every observation the run produced.',
    };
  }
  if (json === null || typeof json !== 'object') {
    return { ok: false, reason: 'run-report.json did not parse to an object.' };
  }
  if (json.schema !== RUN_REPORT_SCHEMA) {
    return {
      ok: false,
      reason: `run-report.json carries schema ${JSON.stringify(json.schema)}, expected ${JSON.stringify(
        RUN_REPORT_SCHEMA,
      )}.`,
      json,
    };
  }
  if (
    typeof json.outcome !== 'object' ||
    json.outcome === null ||
    typeof json.outcome.exitCode !== 'number'
  ) {
    return {
      ok: false,
      reason: 'run-report.json has no outcome block with a numeric exitCode.',
      json,
    };
  }
  if (typeof json.checks !== 'object' || json.checks === null) {
    return { ok: false, reason: 'run-report.json has no checks map keyed by check id.', json };
  }
  return { ok: true, json };
}

// Decide the accounting rules over a parsed report. Pure; returns `{ ok, reason? }` naming every rule
// that failed, so one read fixes a report with two defects.
//
// The rules, and the misreading each exists to prevent:
//
//   1. COMPLETE — every catalog id the run's profile selects carries a record. A vanished id is
//      precisely how "no failures reported" gets misread as "everything passed" (Req 5.10).
//   2. KEYED — each record sits at its own id and repeats that id, so a reader can look a check up.
//   3. VOCABULARY — every status is one the record shape defines, and a `skip` names a reason from the
//      closed set. An unrecognized tag would slip past the exit gate's membership test.
//   4. NO SILENT PASS — a `pass` carries no observation and a non-pass carries one, so a non-pass can
//      never be a record that says nothing.
//   5. EXIT AGREEMENT — `ok` is true only when at least one check executed, none failed, no run-level
//      setup/teardown failure was recorded, and every skip reason is enumerated; and exitCode is 0 if
//      and only if `ok`. This is the honest-exit contract read back off the artifact.
export function decideArtifactAccounting(json, { ids = CHECK_IDS } = {}) {
  const problems = [];
  const checks = json?.checks ?? {};
  const outcome = json?.outcome ?? {};

  const missing = ids.filter((id) => checks[id] === undefined);
  if (missing.length > 0) {
    problems.push(
      `${missing.length} catalog id(s) carry no record: ${missing.join(', ')}. The report must be ` +
        'complete by construction — an id that produced no result is a `skip` with a reason, never ' +
        'an absence (Req 5.10).',
    );
  }

  let executed = 0;
  let failed = 0;
  let setupFailureRecords = 0;
  const nonEnumeratedSkips = [];
  for (const [key, record] of Object.entries(checks)) {
    if (record?.id !== key) {
      problems.push(
        `the checks map is not keyed by id: key ${JSON.stringify(key)} holds a record with id ` +
          `${JSON.stringify(record?.id)}.`,
      );
      continue;
    }
    if (!ALL_STATUSES.includes(record.status)) {
      problems.push(
        `${key} carries status ${JSON.stringify(record.status)}, which is not one of ` +
          `${ALL_STATUSES.join(', ')}.`,
      );
      continue;
    }
    if (record.status === CHECK_STATUS.PASS) {
      executed += 1;
      if (record.observation !== null && record.observation !== undefined) {
        problems.push(
          `${key} passed but carries an observation; a pass is decided by the check id and its ` +
            'property, not by prose.',
        );
      }
      continue;
    }
    if (typeof record.observation !== 'string' || record.observation.trim() === '') {
      problems.push(
        `${key} is a "${record.status}" with no deciding observation — the opaque outcome Req 5.3 ` +
          'forbids.',
      );
    }
    if (record.status === CHECK_STATUS.FAIL) {
      executed += 1;
      failed += 1;
      continue;
    }
    if (record.status === CHECK_STATUS.SETUP_FAILURE) {
      // A per-check setup-failure record decided nothing and blocks the all-clear on its own, exactly
      // as the run-level setupFailure does (Property 9).
      setupFailureRecords += 1;
      continue;
    }
    if (record.status === CHECK_STATUS.SKIP) {
      if (!ALL_SKIP_REASONS.includes(record.skipReason)) {
        problems.push(
          `${key} is a skip whose reason ${JSON.stringify(record.skipReason)} is not in the closed ` +
            `set ${ALL_SKIP_REASONS.join(', ')}; the exit gate reads this tag.`,
        );
      } else if (!ENUMERATED_SKIP_REASONS.includes(record.skipReason)) {
        nonEnumeratedSkips.push(key);
      }
    }
  }

  const shouldBeOk =
    problems.length === 0 &&
    failed === 0 &&
    executed > 0 &&
    setupFailureRecords === 0 &&
    nonEnumeratedSkips.length === 0 &&
    !json?.setupFailure &&
    !json?.teardownFailure;
  if (outcome.ok !== shouldBeOk) {
    problems.push(
      `the report claims ok=${outcome.ok} but the records say ok=${shouldBeOk} ` +
        `(${executed} executed, ${failed} failed, ${setupFailureRecords} setup-failure record(s), ` +
        `${nonEnumeratedSkips.length} non-enumerated ` +
        `skip(s)${nonEnumeratedSkips.length > 0 ? `: ${nonEnumeratedSkips.join(', ')}` : ''}, ` +
        `setupFailure=${json?.setupFailure ? 'present' : 'none'}, teardownFailure=` +
        `${json?.teardownFailure ? 'present' : 'none'}). Exit 0 requires at least one executed ` +
        'check, no failure, and every skip reason enumerated.',
    );
  }
  if ((outcome.exitCode === 0) !== Boolean(outcome.ok)) {
    problems.push(
      `the report's exitCode ${outcome.exitCode} disagrees with ok=${outcome.ok}; exit 0 is the ` +
        'all-clear and only the all-clear.',
    );
  }

  if (problems.length > 0) {
    return { ok: false, reason: problems.join(' ') };
  }
  return { ok: true };
}

// Decide both halves over one artifact text, which is what the runner's post-run validation wants:
// well-formedness first (an unparseable file has no accounting to check), then the accounting rules.
// Returns `{ ok, reason?, json? }`.
export function decideArtifact(artifactText, { ids = CHECK_IDS } = {}) {
  const wellFormed = decideArtifactWellFormed(artifactText);
  if (!wellFormed.ok) {
    return wellFormed;
  }
  const accounting = decideArtifactAccounting(wellFormed.json, { ids });
  if (!accounting.ok) {
    return { ok: false, reason: accounting.reason, json: wellFormed.json };
  }
  return { ok: true, json: wellFormed.json };
}
