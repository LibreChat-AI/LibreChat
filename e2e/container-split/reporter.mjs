// reporter.mjs — the Jest custom reporter that feeds the check-record serializer (task 7.5).
//
// This is the thin adapter between Jest's `jest --runInBand` output and serializer.mjs. Jest reports
// per-test results; a Layer B check IS a test, and the reporter's whole job is to map each test's
// result to a check outcome `{ status, observation? }` keyed by the check id the test declares, then
// hand the collected outcomes to serializeRun to produce the JSON artifact and the human summary.
//
// == How a spec declares its check id ==
// A checks/*.spec.mjs check names its id as a bracketed tag at the START of its title, e.g. a title
// of the form:  [BOOT-NOWRITE-23] zero write commands attributed to the Auth_Surface in the boot
// window
//
// The tag is the id the Check Catalog keys on. The reporter parses it from the title, looks it up in
// the catalog for layer/requirements/property, and derives status from Jest's result:
//
//   * passed  -> pass
//   * failed  -> fail,  observation = the assertion's failure message (what decided it)
//              -> UNLESS the message carries the undecided signal (undecided.mjs), in which case the
//                 record is a `skip` with the signal's reason: the check ran and found its OBSERVATION
//                 unusable, so it falsified nothing and must not report a verdict it did not earn. The
//                 Jest test still counts as failed, so the run's exit status stays non-zero.
//   * skipped / todo / pending -> skip, observation = a skip reason if the title carries one
//
// == Layer A's verdict arrives from the runner, it is not derived ==
// Layer A runs at stage 1, in the api workspace, in its own Jest, and decides twelve catalog ids. It
// never registers a result in THIS aggregate. The runner therefore hands its verdict over through
// HARNESS_LAYER_A_RESULT and the reporter classifies those twelve ids from it (layer-a-outcome.mjs —
// the same classifier the runner's early-exit report uses). Before that hand-off existed, the reporter
// derived all twelve as `skip / optional-dependency-absent`, so a run whose Layer A had just passed 135
// tests with `mongosh` on PATH produced an artifact stating that twelve checks did not run for want of
// `mongosh`. A false statement in the artifact is worse than a missing one.
//
// A test whose title carries no `[CHECK-ID]` tag is not a catalog check (a helper `describe` block,
// say) and is ignored rather than forced into a record it has no id for. A tag that is not a catalog
// id throws through the serializer's catalog lookup — a typo'd check id is a bug worth failing on,
// not an orphan record shipped to CI.
//
// == Absence is derived from the catalog, not announced by the spec (Req 5.10, task 14.7/15.3) ==
// A check that did not run leaves NO Jest result behind — the Layer B spec files register a live
// check only when the live gate is satisfied (HARNESS_LIVE=1 and the harness context present), so a
// non-live invocation registers nothing for that id rather than a `test.skip`. To keep the report
// complete by construction, `onRunComplete` walks the Check Catalog — specifically the ids THIS RUN'S
// PROFILE SELECTS (check-catalog.mjs: checkIdsForProfile; a collapsed run does not carry the checks
// whose claim is about two containers) — and, for every selected id that
// produced no Jest result this run, emits a `skip` record with a MACHINE-READABLE `skipReason` tag
// (task 15.3) — EXTERNAL_PROVIDER_REQUIRED for the group-sync check, OPTIONAL_DEPENDENCY_ABSENT for the
// Layer A suites, DECIDED_BY_REFERENCE for the recorded parity check, and NOT_EXECUTED for everything
// else. The tag is what serializer.mjs's runOutcome reads to tell a benign, enumerated absence from a
// "the run decided nothing here" skip that blocks exit 0. A vanished id is precisely how "no failures
// reported" gets misread as "everything passed" (design: "Unexecuted is not passed"), so the reporter
// derives absence from the catalog rather than trusting each spec to announce its own skip.
//
// == Why a reporter and not test assertions ==
// The design emits the records "as a JSON summary alongside the human-readable reporter output". A
// reporter sees every test's result in one place and writes one artifact for the run; doing the same
// from inside the tests would scatter the write across files and race under a shared topology. The
// heavy lifting is all in serializer.mjs (pure, unit-tested); this file only translates Jest's shape.
//
// NG1/NG2 hold: this reports on the harness's own checks and touches no application code or either
// container-split script.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { CHECK_STATUS, SKIP_REASON, buildCheckRecord, serializeRun } from './serializer.mjs';
import {
  CHECK_IDS,
  catalogEntryFor,
  checkIdsForProfile,
  profileFromEnv,
} from './check-catalog.mjs';
import {
  classifyLayerAOutcomeFor,
  isBackendLaneCheck,
  readLayerASummary,
} from './layer-a-outcome.mjs';
import { parseUndecided } from './undecided.mjs';
import { PATH_OUTCOMES_PATH, consumePublishedPathOutcomes } from './path-outcomes.mjs';
import { readImageRecord } from './image-record.mjs';
import { referenceSummary as suiteParityReferenceSummary } from './checks/suite-parity.filter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The catalog ids as a membership set, built once at module scope. parseCheckId validates a bracketed
// tag against this set: only a real catalog id is accepted as a check id, which is what lets the tag
// be found wherever Jest placed it in the full name without a bracketed non-id phrase being mistaken
// for one.
const CHECK_ID_SET = new Set(CHECK_IDS);

// The artifact path. The CI lane attaches this file; a reader gets the human summary on stdout.
// Overridable through the reporter's options so a negative-control run can write its own.
//
// Exported because run.mjs needs the SAME path for two things it owns: deleting a previous run's
// report at run start, so the file's presence can never be a stale tally from an earlier run, and
// writing the setup-failure report itself when the run never reaches this reporter (stage 11). Both
// would be silently wrong against a second, independently-spelled path, so the writer names it once
// and the runner imports it.
export const RUN_REPORT_PATH = path.join(HERE, 'run-report.json');

// The `kind` a run-level failure carries when the per-path outcomes sidecar was PRESENT and unusable.
// Named here so a test asserts on the tag rather than on prose.
export const PATH_OUTCOMES_UNUSABLE_KIND = 'path-outcomes-unusable';

// The `kind` a run-level failure carries when a check the run's profile does NOT select nevertheless
// ran and went RED. Dropping that result would be a false green (the profile does not account for the
// id, so nothing else would report it), so it is reported as a harness defect instead.
export const UNSELECTED_CHECK_FAILED_KIND = 'unselected-check-failed';

// Which sidecar THIS reporter may consume. The sidecar belongs to the canonical run artifact: the
// publishing check writes it at one fixed path (path-outcomes.mjs names it once so the two processes
// cannot disagree), and the reporter that writes RUN_REPORT_PATH is the one whose report it feeds.
//
// So: an explicit `pathOutcomesPath` wins (a test, or any caller that owns both files); otherwise the
// canonical sidecar is consumed ONLY by a reporter writing the canonical report, and a reporter
// pointed at some other report path consumes NOTHING (null).
//
// That last clause is the defect this function exists to end, and it is a REPORTING defect of exactly
// the kind the sidecar exists to prevent. jest.config.mjs's testMatch runs the harness's own unit tests
// (`**/*.test.mjs`) in the SAME Jest invocation as the live checks (`checks/**/*.spec.mjs`), and Jest
// orders files largest-first, so path-exercise.spec.mjs publishes its twenty-six outcomes and
// run-report-lifecycle.test.mjs runs afterwards. Two of its tests construct a reporter with a temp
// `reportPath` and no `pathOutcomesPath` to assert something entirely unrelated (Layer A's hand-off),
// and `onRunComplete` then consumed — read AND unlinked — the REAL run's sidecar and dropped it on the
// floor, because the check it belonged to had no result in that synthetic aggregate. The run's own
// reporter, minutes later, found nothing: PATH-EXERCISE-25 passed with `observation: null`, no
// `pathOutcomes` key, and five `undecided` Unconfigured_Provider entries invisible in the artifact.
// Keying consumption to the canonical report makes that impossible by construction rather than by every
// future test remembering to pass an override.
export function sidecarPathFor({ reportPath, pathOutcomesPath = null } = {}) {
  if (typeof pathOutcomesPath === 'string' && pathOutcomesPath !== '') {
    return pathOutcomesPath;
  }
  return reportPath === RUN_REPORT_PATH ? PATH_OUTCOMES_PATH : null;
}

// Parse the `[CHECK-ID]` tag from a test's FULL name. Returns the id, or null when the name carries
// no catalog-id tag (not a catalog check). Exported for unit tests.
//
// Jest's per-assertion `fullName` is the describe title(s) joined with the test title, and the Layer B
// specs put the `[CHECK-ID]` tag on the TEST title while the describe title is a bare `` `${CHECK_ID}:
// …` `` with NO brackets. So in the full name the bracketed tag sits AFTER the describe prefix, not at
// position 0 — e.g. `RUN-REPORT-32: the run reports … [RUN-REPORT-32] exit 0 requires …`. An anchored
// `/^\s*\[…\]/` would miss it and record an executed check as an unexecuted skip (a false negative).
//
// So we scan for the first bracketed `[A-Z0-9-]+` token ANYWHERE in the full name and accept it only
// if it is a real catalog id (membership in CHECK_ID_SET). Catalog validation IS the guard the earlier
// "tag must be at the start" comment intended, in a stronger form: a bracketed phrase that is not a
// catalog id — a describe title carrying `[WIP]` or `[pure]`, say — is rejected rather than mistaken
// for a check id, wherever it appears. A tag that looks like an id but is a typo still falls through to
// the serializer's catalog lookup, which fails loudly, as before.
export function parseCheckId(fullName) {
  if (typeof fullName !== 'string') {
    return null;
  }
  for (const match of fullName.matchAll(/\[([A-Z0-9-]+)\]/g)) {
    if (CHECK_ID_SET.has(match[1])) {
      return match[1];
    }
  }
  return null;
}

// Map one Jest test result to a check outcome `{ status, observation? }`. Pure over Jest's per-assertion
// result shape (`{ status, failureMessages, fullName }`), so it is unit-exercisable without a Jest run.
//
//   * 'passed'                      -> { status: 'pass' }
//   * 'failed'                      -> { status: 'fail', observation: joined failure messages }
//   * 'skipped'/'pending'/'todo'    -> { status: 'skip', observation: a reason }
//
// A failed test with no failure message still gets a non-empty observation (Jest always supplies one,
// but the fallback keeps the serializer's "fail requires an observation" invariant satisfied rather
// than throwing on a degenerate result). A skipped test's observation is the reason a spec may encode
// after the tag as `[ID] (skipped: <reason>) …`, or a generic "skipped by the suite" otherwise, and
// it carries skipReason NOT_EXECUTED: a `test.skip` deliberately did not run its check, which is a
// "decided nothing here" skip that blocks exit 0, not a benign enumerated absence (task 15.3).
export function outcomeFromAssertion(assertion) {
  switch (assertion.status) {
    case 'passed':
      return { status: CHECK_STATUS.PASS };
    case 'failed': {
      const observation =
        (assertion.failureMessages ?? []).join('\n').trim() ||
        `Check failed with no message (test: ${assertion.fullName ?? 'unknown'}).`;
      // A check that ran and found its OBSERVATION unusable throws the undecided signal
      // (undecided.mjs) rather than an assertion failure. Jest counts that as a failed test — which is
      // right, the run did not decide the property and must not exit 0 — but the RECORD is a `skip`
      // with the signal's reason, because nothing was falsified. Reporting it as a `fail` would claim
      // the property was violated; reporting it as a pass would claim it holds. Neither is what the
      // check saw. The signal's reasons are outside ENUMERATED_SKIP_REASONS, so the skip blocks exit 0
      // exactly as NOT_EXECUTED does.
      const undecided = parseUndecided(observation);
      if (undecided !== null && Object.values(SKIP_REASON).includes(undecided.reason)) {
        return {
          status: CHECK_STATUS.SKIP,
          observation: undecided.observation,
          skipReason: undecided.reason,
        };
      }
      return { status: CHECK_STATUS.FAIL, observation };
    }
    case 'skipped':
    case 'pending':
    case 'todo': {
      const reasonMatch = /\(skipped:\s*([^)]+)\)/i.exec(assertion.fullName ?? '');
      const observation = reasonMatch ? reasonMatch[1].trim() : 'Skipped by the suite.';
      // A spec that emitted a real `test.skip` did so deliberately but did not execute its check —
      // that is a "decided nothing here" skip, NOT_EXECUTED, which blocks exit 0 rather than reading
      // as a benign absence. The Layer B specs no longer self-skip (task 14.7); this branch remains
      // for a stray suite skip, and it must not be mistaken for an enumerated benign skip.
      return { status: CHECK_STATUS.SKIP, observation, skipReason: SKIP_REASON.NOT_EXECUTED };
    }
    default:
      return {
        status: CHECK_STATUS.FAIL,
        observation: `Unrecognized Jest test status ${JSON.stringify(assertion.status)}.`,
      };
  }
}

// Collect check outcomes keyed by id from a Jest aggregated result. Pure over the aggregate shape
// (`{ testResults: [{ testResults: [assertion, …] }, …] }`), so the whole collection step is
// unit-exercisable with a synthetic aggregate. A test with no `[CHECK-ID]` tag is skipped (not a
// catalog check); a duplicate id across two tests keeps the more severe outcome, because two tests
// claiming one check id both deciding it means the check fails if either does — a pass that hides a
// sibling fail would be a false green.
const SEVERITY = { [CHECK_STATUS.PASS]: 0, [CHECK_STATUS.SKIP]: 1, [CHECK_STATUS.FAIL]: 2 };

export function collectOutcomes(aggregate) {
  const outcomes = {};
  for (const fileResult of aggregate.testResults ?? []) {
    for (const assertion of fileResult.testResults ?? []) {
      const id = parseCheckId(assertion.fullName ?? assertion.title ?? '');
      if (id === null) {
        continue;
      }
      const outcome = outcomeFromAssertion(assertion);
      const existing = outcomes[id];
      if (existing === undefined || SEVERITY[outcome.status] > SEVERITY[existing.status]) {
        outcomes[id] = outcome;
      }
    }
  }
  return outcomes;
}

// The enumerated benign-skip ids: a catalog id that, when it produced no Jest result, is a KNOWN,
// accounted-for absence rather than a "the run decided nothing here" gap. Each maps to the
// machine-readable skip reason runOutcome reads:
//
//   * PATH-GROUPSYNC-26 — decidable only against a real identity provider, which this harness
//     deliberately does not stand up (an IdP stub would be a mock of a subsystem the harness does not
//     own; NG6 applies the same reasoning to the Auth_Gate). So its absence is
//     EXTERNAL_PROVIDER_REQUIRED: an accounted-for absence, not a gap. The check itself is RETAINED —
//     it is a valid instrument lacking an input, and pointing the harness at a real tenant publishes
//     the `groupSync` context its live gate waits for, at which point it executes and this derivation
//     stops firing.
//   * every Layer A id, AND the static NG3 guard COMPOSE-UNCHANGED-12 — the grant/provision suites
//     and `compose-unchanged.spec.js` all live in the api workspace (`api/test/container-split/`) and
//     run at stage 1, not in the Layer B jest aggregate, so none of them ever registers a result here.
//     This DERIVATION is the fallback for those ids and fires only when the reporter was handed no
//     Layer A verdict at all — a bare `npx jest` with no runner, where the honest statement is that
//     the check is decided in the api workspace and this run cannot see the verdict. When the runner
//     drives the run it passes the verdict through HARNESS_LAYER_A_RESULT, and `onRunComplete`
//     classifies those twelve ids from it (layer-a-outcome.mjs) instead of deriving anything: a
//     passing Layer A records twelve `pass`, a self-skip for want of `mongosh` records eleven
//     OPTIONAL_DEPENDENCY_ABSENT skips plus a `pass` for the static guard that needs no `mongosh`.
//     The catalog marks the static guard `layer: 'static'` and the grant/provision suites `layer: 'A'`;
//     both are backend-lane checks for this derivation.
//
// PARITY-SUITE-31 is layer 'recorded' — it is decided by reference. Its spec registers NO
// `[PARITY-SUITE-31]` check (suite-parity.spec.mjs carries only internal well-formedness exercises,
// none tagged with the catalog id), so the id produces NO Jest result and THIS derivation is what
// records it — a `skip` with skipReason DECIDED_BY_REFERENCE, never a `pass`, because a pass would
// claim an observation the run did not make (task 17.6). The skip's observation is the recorded
// reference itself (referenceSummary): the backend lane, its workflow path, its jobs, the
// DISABLE_STARTUP_TASKS-absent criterion, and the additive roots. Every other id with no result is
// NOT_EXECUTED — a check that would
// have run against a live topology but did not this run, which is NOT an enumerated benign skip and
// so blocks exit 0 (design: "Unexecuted is not passed").
function derivedSkipReasonFor(id) {
  if (id === 'PATH-GROUPSYNC-26') {
    return SKIP_REASON.EXTERNAL_PROVIDER_REQUIRED;
  }
  if (id === 'PARITY-SUITE-31') {
    return SKIP_REASON.DECIDED_BY_REFERENCE;
  }
  // A backend-lane check — a Layer A grant/provision suite or the static NG3 guard
  // (COMPOSE-UNCHANGED-12, layer 'static') — runs in the api workspace, never in the Layer B
  // aggregate, so its absence here is a benign OPTIONAL_DEPENDENCY_ABSENT rather than "the run decided
  // nothing": the check IS decided, in the backend lane, whose verdict this Jest run was not given.
  // When it WAS given (the runner's hand-off), onRunComplete never reaches this derivation for these
  // ids and records what Layer A actually decided instead.
  const layer = catalogEntryFor(id).layer;
  if (layer === 'A' || layer === 'static') {
    return SKIP_REASON.OPTIONAL_DEPENDENCY_ABSENT;
  }
  return SKIP_REASON.NOT_EXECUTED;
}

// The human-readable observation matching a derived skip reason. The prose is what a reader scans;
// the tag is what the exit gate reads. Kept beside the reason map so the two never drift.
function derivedSkipObservationFor(reason) {
  switch (reason) {
    case SKIP_REASON.EXTERNAL_PROVIDER_REQUIRED:
      return (
        'requires an external identity provider the harness deliberately does not stand up, so no ' +
        'membership sync happened for this run to assert on. Standing an IdP up would be a mock of a ' +
        'subsystem this harness does not own — the same reasoning NG6 applies to the Auth_Gate — and ' +
        "such a double belongs to the OIDC/Entra integration's own tests, where the provider " +
        'interface is the subject. The check is retained, not removed: point the harness at a real ' +
        'tenant (publish the `groupSync` context) and it decides at full strength. Its absence is ' +
        'accounted for rather than a gap.'
      );
    case SKIP_REASON.DECIDED_BY_REFERENCE:
      // The recorded reference itself is the observation: the backend lane, its workflow path, its
      // jobs, the DISABLE_STARTUP_TASKS-absent criterion, and the additive roots that make the existing
      // suite's counts carry. It states — never asserts — whether the cited lane path resolves (NG10),
      // and carries no transcribed pass/fail count and no claim of a local execution (task 17.6).
      return suiteParityReferenceSummary();
    case SKIP_REASON.OPTIONAL_DEPENDENCY_ABSENT:
      // Deliberately does NOT assert that `mongosh` was missing. This branch is reached only when the
      // reporter was handed no Layer A verdict at all (a bare `npx jest`, no runner), so the honest
      // statement is that the check is decided in the api workspace and this run cannot see the
      // verdict. Claiming an absent dependency here is what made a passing Layer A read as twelve
      // skipped checks for want of a binary that was installed.
      return (
        'decided in the backend lane (api/test/container-split), which this Jest run did not ' +
        'execute and whose verdict was not supplied to it. Run the harness entry command to have ' +
        "Layer A's real outcome recorded here."
      );
    default:
      return (
        'not executed this run — HARNESS_LIVE unset / topology absent, so this check registered no ' +
        'result. This is NOT a benign skip: exit 0 requires this id to have executed against a live ' +
        'topology (task 15).'
      );
  }
}

// The Jest custom reporter. Jest instantiates it with `(globalConfig, options)` and calls
// `onRunComplete(contexts, aggregate)` once every test file has finished — the single point where
// every check's result is known. There the reporter collects outcomes, hands them to buildRecords via
// serializeRun, writes the JSON artifact, and prints the human summary. Because Layer B runs
// `--runInBand`, `onRunComplete` sees one coherent set of results from one shared topology rather than
// a merge across workers.
//
// The reporter reads no live topology and spawns nothing; it only reads Jest's results and writes a
// file. Setup and teardown failures are the runner's (run.mjs) to classify — when run.mjs invokes
// Jest it can pass a pre-recorded setup/teardown failure through the reporter options so the artifact
// carries it, but a plain `jest` invocation (no topology, checks self-skip) simply reports the checks.
export default class ContainerSplitReporter {
  constructor(globalConfig = {}, options = {}) {
    this._globalConfig = globalConfig;
    this._reportPath = options.reportPath ?? RUN_REPORT_PATH;
    // The sidecar a list-covering check publishes its per-path outcomes to (path-outcomes.mjs).
    // Overridable for the same reason `reportPath` is: a test must not consume the real one — and
    // sidecarPathFor makes that hold even for a caller that FORGOT to override it, which is how the
    // real run lost its per-path table (see the comment there). null means "this reporter owns no
    // sidecar", and nothing is consumed.
    this._pathOutcomesPath = sidecarPathFor({
      reportPath: this._reportPath,
      pathOutcomesPath: options.pathOutcomesPath ?? null,
    });
    this._profile = options.profile ?? profileFromEnv(process.env);
    // The ids THIS run accounts for. A profile does not select every catalog check: the collapsed
    // profile runs one container, so the checks whose claim is about the relationship between two
    // containers — or which the collapse satisfies for free — are not its to decide
    // (check-catalog.mjs owns that classification and the reason for each). Resolved once here so the
    // derivation loop, the dropping of unselected results and any future consumer read one set.
    this._selectedIds = checkIdsForProfile(this._profile);
    this._startedAt = new Date().toISOString();
    // A runner (run.mjs) may inject a setup/teardown failure it already classified, so the artifact
    // carries the Property 9 distinction end to end. Absent for a plain `jest` invocation.
    this._setupFailure = options.setupFailure ?? null;
    this._teardownFailure = options.teardownFailure ?? null;
    // Layer A's verdict, as the runner handed it over (HARNESS_LAYER_A_RESULT). Layer A runs at stage 1
    // in its own workspace and never registers a result in this aggregate, so without it the twelve
    // backend-lane ids can only be derived — and the derivation invented a missing `mongosh`. With it
    // they carry what Layer A actually decided. null on a plain `jest` invocation, where no Layer A
    // ran and claiming knowledge of one would be the same false statement in the other direction.
    this._layerA = options.layerA ?? readLayerASummary(process.env);
    // The tested-image record, as the runner handed it over (HARNESS_IMAGE_RECORD). The image is
    // resolved at stage 2 in the runner's process; the record crosses to this Jest run through the
    // environment (image-record.mjs), the same channel Layer A's verdict uses, so the stage-11 report
    // carries the top-level `image` block (Req 5.12). null on a plain `jest` invocation, where no
    // runner resolved an image and claiming one would be a false statement in the artifact.
    this._image = options.image ?? readImageRecord(process.env);
  }

  // A sidecar that was there and could not be used. It is NOT attached — a malformed list throws in
  // buildCheckRecord, which would cost the whole artifact, and an artifact that is missing one table is
  // better than no artifact at all. So the defect is reported instead of the table:
  //
  //   * on stderr immediately, naming the problems and quoting what was written, because the file is
  //     gone by now (consumed, so no later run can inherit it) and this is the only record of it;
  //   * as a run-level setup failure, which serializeRun prints in the summary, writes into the JSON,
  //     and counts in runOutcome — so the run cannot reach exit 0 having silently under-reported a
  //     criterion it decided.
  //
  // A setup failure the RUNNER already classified is the more primary finding and is not overwritten
  // (it explains why the topology never came up, which likely explains this too); the stderr
  // diagnostic still names the sidecar, and the pre-existing failure already blocks exit 0.
  _recordUnusableSidecar(consumed) {
    const message =
      `The per-path outcomes sidecar at ${path.relative(HERE, consumed.filePath)} was PRESENT but ` +
      `unusable, so the publishing check's per-path table is missing from this report — an outcome ` +
      `this run DECIDED and did not report (Req 5.3, 5.4). ${consumed.problems.length} problem(s): ` +
      consumed.problems.join(' ');
    process.stderr.write(
      `${PATH_OUTCOMES_UNUSABLE_KIND}: ${message}\n  sidecar as written: ${consumed.excerpt}\n`,
    );
    if (this._setupFailure === null) {
      this._setupFailure = {
        kind: PATH_OUTCOMES_UNUSABLE_KIND,
        message,
        detail: consumed.excerpt,
      };
    }
  }

  // A check the run's profile does not select, which nevertheless produced a Jest result. Its outcome
  // is DROPPED — the profile does not account for the id, and a record for it would either pad the
  // report with a claim this topology cannot make or, worse, carry a vacuous pass as evidence.
  //
  // What gets dropped in practice is a PASS from a profile-independent static decider: several spec
  // files put a catalog id in a `describe` title for unit tests over pure functions
  // (`[TOPO-ENV-14] matrix parse and partition decider (static)`), and those run under every profile
  // because they touch no topology. Dropping them is what keeps a collapsed run from reporting
  // TOPO-ENV-14 as passed on the strength of a parser test.
  //
  // A dropped FAIL is a different matter and is NOT swallowed: it means a live check this profile does
  // not select was registered anyway and went red — a gating bug in the spec file, and exactly the
  // shape of defect that would otherwise turn into a false green. It is recorded as a run-level failure
  // so it blocks exit 0 and names itself.
  _dropUnselectedOutcomes(outcomes) {
    const selected = new Set(this._selectedIds);
    const dropped = [];
    const failed = [];
    for (const id of Object.keys(outcomes)) {
      if (selected.has(id)) {
        continue;
      }
      if (outcomes[id].status === CHECK_STATUS.FAIL) {
        failed.push(id);
      }
      dropped.push(id);
      delete outcomes[id];
    }
    if (dropped.length > 0) {
      process.stderr.write(
        `[container-split] profile "${this._profile}" does not select ${dropped.length} check(s) ` +
          `that produced a result: ${dropped.join(', ')}. Not accounted for in this run ` +
          '(check-catalog.mjs records why each does not apply).\n',
      );
    }
    if (failed.length > 0 && this._setupFailure === null) {
      this._setupFailure = {
        kind: UNSELECTED_CHECK_FAILED_KIND,
        message:
          `${failed.length} check(s) the "${this._profile}" profile does not select ran anyway and ` +
          `FAILED: ${failed.join(', ')}. That is a harness defect, not a falsified property: the ` +
          'live gate in the spec file must not register a check its profile does not select, and the ' +
          'dropped result would otherwise leave the run green with a red check in it.',
        detail: failed.join('\n'),
      };
    }
  }

  async onRunComplete(_contexts, aggregate) {
    const outcomes = collectOutcomes(aggregate);
    this._dropUnselectedOutcomes(outcomes);

    // Derive a `skip` record for every catalog id that produced no Jest result this run. Since the
    // Layer B spec files now register a live check only when the live gate is satisfied (task 14.7),
    // an id with no result is a check that did not execute — not a pass. Emitting it as a skip keeps
    // the report complete by construction (Req 5.10, design: "Unexecuted is not passed"): every
    // catalog id appears, with the ones that did not run distinctly marked `skip` rather than
    // vanishing from the summary and being misread as "everything passed".
    //
    // Over the ids THIS RUN'S PROFILE SELECTS, which is what task 15.3's gate says ("every catalog id
    // the profile selects carries a record"). An id the profile does not select is not a skip record:
    // the run makes no claim about it at all, and manufacturing a `skip` would say this run failed to
    // decide something it was never asked to.
    for (const id of this._selectedIds) {
      if (outcomes[id] !== undefined) {
        continue;
      }
      // A backend-lane id (Layer A's eleven grant/provision suites and the static NG3 guard) is
      // decided by the stage-1 Layer A spawn, not by this aggregate. When the runner handed that
      // verdict over, record IT — through the same classifier the early-exit report uses, so the two
      // reports cannot disagree about one spawn. Only without a verdict does the reporter fall back to
      // deriving an absence.
      if (this._layerA !== null && isBackendLaneCheck(id)) {
        outcomes[id] = classifyLayerAOutcomeFor(id, this._layerA);
        continue;
      }
      const skipReason = derivedSkipReasonFor(id);
      outcomes[id] = {
        status: CHECK_STATUS.SKIP,
        observation: derivedSkipObservationFor(skipReason),
        skipReason,
      };
    }

    // A list-covering check publishes its per-path outcomes to a sidecar (path-outcomes.mjs), because
    // this reporter runs in the Jest HOST process and sees only each test's status and failure message —
    // and a PASSING check has no message, while its `undecided` entries are precisely what must stay
    // visible. The sidecar is consumed (read and unlinked) so no later run can inherit it, and it is
    // attached ONLY to a check that produced a real Jest result this run: decorating a derived `skip`
    // with a previous run's outcomes would be a false statement in the artifact, which is worse than an
    // absent one.
    //
    // ABSENT and PRESENT-BUT-UNUSABLE are different findings. Absent is legitimate and silent. An
    // unusable sidecar means the outcomes were decided and then lost between the check and the
    // artifact, so the report would carry a green record with no per-path table and no hint that a
    // table was missing — the under-reporting Req 5.3/5.4 forbid. It is recorded as a run-level
    // failure, for the same reason Property 9 keeps a setup failure from reading as a falsified
    // property: nothing about the split was falsified, the HARNESS failed to report what it decided,
    // and that must block the all-clear rather than pass quietly.
    const consumed =
      this._pathOutcomesPath === null
        ? null
        : await consumePublishedPathOutcomes({ filePath: this._pathOutcomesPath });
    if (consumed !== null && consumed.problems.length > 0) {
      this._recordUnusableSidecar(consumed);
    } else if (consumed !== null) {
      const id = consumed.payload.checkId;
      const outcome = outcomes[id];
      if (
        outcome !== undefined &&
        (outcome.status === CHECK_STATUS.PASS || outcome.status === CHECK_STATUS.FAIL)
      ) {
        outcomes[id] = { ...outcome, pathOutcomes: consumed.payload.pathOutcomes };
      }
    }

    const records = Object.entries(outcomes).map(([id, outcome]) => buildCheckRecord(id, outcome));

    const { json, text } = serializeRun(records, {
      profile: this._profile,
      startedAt: this._startedAt,
      setupFailure: this._setupFailure,
      teardownFailure: this._teardownFailure,
      image: this._image,
    });

    await mkdir(path.dirname(this._reportPath), { recursive: true });
    await writeFile(this._reportPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');

    process.stdout.write(`\n${text}\n`);
    process.stdout.write(
      `\nCheck-record artifact written: ${path.relative(HERE, this._reportPath)}\n`,
    );
  }
}
