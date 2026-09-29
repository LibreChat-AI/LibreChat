// serializer.mjs — the check-record serializer (task 7.5).
//
// Every Layer B check, when it runs, produces one record in the design's shape (design.md:
// "The check record"):
//
//   { id, layer, requirements, property, status, observation }
//
// This module turns a check's raw outcome into that record and folds the per-check records into one
// run report keyed by check id. It is the reporting half of RUN-REPORT-32: the report is what the CI
// lane attaches as an artifact, and the human-readable summary is what an engineer reads.
//
// Two layers, both here and both pure:
//
//   1. buildCheckRecord — takes a check id and a raw outcome, looks the id up in the Check Catalog
//      (check-catalog.mjs) to fill `layer`, `requirements` and `property`, and returns the frozen
//      record. This is the piece the design specifies: the per-check record the run report is built
//      from, keyed by check id, distinguishing pass / fail / skip / setup-failure.
//
//   2. serializeRun — folds an array of records (plus any run-level setup/teardown failure) into the
//      JSON summary the CI lane consumes and the human-readable text a reader scans. Emitting both
//      from one function keeps the two views in agreement — they are the same records rendered twice.
//
// A Jest custom reporter (reporter.mjs) is the adapter that feeds this from a live `jest --runInBand`
// run; this module has no Jest dependency so it is unit-exercisable with synthetic outcomes (pass,
// fail, setup-failure) and reused by any non-Jest caller (the runner's own early-exit report, a
// `--validate` dry run) without dragging the runner in.
//
// NG1/NG2 hold: this serializes the harness's own check outcomes. It touches no application code and
// neither container-split script.

import { catalogEntryFor } from './check-catalog.mjs';
import {
  normalizePathOutcome,
  pathOutcomesProblems,
  renderPathOutcomes,
} from './path-outcomes.mjs';

// The statuses a check record may carry. `pass` and `fail` are ordinary check outcomes; `skip` is an
// environment-gated check that did not run (PATH-GROUPSYNC-26 needs an identity provider the harness
// deliberately does not stand up, and the Layer A suites self-skip without `mongosh`);
// `setup-failure` is the Property 9 classification — the
// topology never came up, so the check falsified nothing and must be reported distinctly from a
// `fail`. Conflating a setup failure with a check failure would let an infrastructure flake read as a
// falsified split property, which is the exact confusion run.mjs's SetupFailure class exists to
// prevent at the runner boundary and which the report must preserve here.
export const CHECK_STATUS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  SKIP: 'skip',
  SETUP_FAILURE: 'setup-failure',
});

const ALL_STATUSES = Object.freeze(Object.values(CHECK_STATUS));

// The machine-readable reason a `skip` record carries, so runOutcome can decide whether the skip is
// benign by MEMBERSHIP rather than by string-matching the human-readable observation prose (task
// 15.3). A skip's `skipReason` is one of these tags; `observation` still carries the prose a reader
// scans, but the exit gate reads this tag.
//
//   * EXTERNAL_PROVIDER_REQUIRED — the check is decidable only against a THIRD-PARTY SERVICE the
//                             harness deliberately does not stand up: an identity provider, a
//                             directory, any external system whose emulation would be a mock of a
//                             subsystem this harness does not own. Named generally, not per check.
//                             PATH-GROUPSYNC-26 is the current member (it asserts on the `groups`
//                             documents an Entra membership sync leaves behind). The check is RETAINED,
//                             not removed: it is a valid instrument lacking an input, and it becomes
//                             decidable the moment the harness is pointed at a real tenant.
//   * DECIDED_BY_REFERENCE  — a check decided elsewhere and recorded by reference (PARITY-SUITE-31,
//                             the existing-suite parity record; layer 'recorded').
//   * OPTIONAL_DEPENDENCY_ABSENT — an optional dependency was absent (mongosh for the Layer A suites).
//   * NOT_EXECUTED          — the check produced no result and no enumerated reason applies: a stage
//                             that failed, a spec that would not load, a context never published. This
//                             is NOT a benign skip — runOutcome treats it as "the run decided nothing
//                             here" and blocks exit 0 (design: "Unexecuted is not passed").
//   * OBSERVATION_UNUSABLE  — the check RAN, reached for its observation, and found the observation
//                             itself unusable: a `system.profile` that rolled past the boot window's
//                             left edge, so BOOT-NOWRITE-23 has no record of the window it must count
//                             over. Distinct from NOT_EXECUTED because the check did execute, and
//                             distinct from `fail` because nothing was falsified — a check that
//                             cannot see its property must not report a verdict it did not earn.
//
// NOT_EXECUTED and OBSERVATION_UNUSABLE are machine-readable TAGS on the same closed list as the
// others, but they are deliberately NOT in ENUMERATED_SKIP_REASONS below: an undecided check must block
// exit 0 exactly as NOT_EXECUTED does. Naming them buys a precise artifact, not a licence to go green.
//
// Two tags are REMOVED, on one reasoning: a vocabulary nothing emits only invites a future caller to
// reach for it.
//
//   * COLLAPSED_RUN_ABSENT named PARITY-COLLAPSE-29's absent collapsed run back when that check
//     compared two runs' image digests. Req 4.2 is now decided structurally from the committed
//     artifacts (design NG9), so no code path can produce the tag.
//   * OPT_IN_VARIANT named the read-only-credential boot variant, BOOT-NOWRITE-RO-24, which was the
//     only producer it ever had. That check is removed (design: it was not a definite test — a boot
//     write refused with code 13 may be SWALLOWED, leaving `/readyz` 200 and the "zero authorization
//     errors" half resting on the application having logged it, which is the very dependency
//     BOOT-CLEAN-21 already carries; BOOT-NOWRITE-23 reads `system.profile`, the database's own record
//     of issued commands, and is strictly better for the same claim). With it gone nothing produces
//     OPT_IN_VARIANT, so the tag goes with it.
export const SKIP_REASON = Object.freeze({
  EXTERNAL_PROVIDER_REQUIRED: 'external-provider-required',
  DECIDED_BY_REFERENCE: 'decided-by-reference',
  OPTIONAL_DEPENDENCY_ABSENT: 'optional-dependency-absent',
  NOT_EXECUTED: 'not-executed',
  OBSERVATION_UNUSABLE: 'observation-unusable',
});

// The CLOSED, ENUMERATED set of skip reasons a run may carry and still reach exit 0 (design: "Honest
// exit status", the third exit-0 clause). A `skip` whose reason is in this set is a benign,
// accounted-for absence; a `skip` with any other reason — NOT_EXECUTED, OBSERVATION_UNUSABLE, or an
// unrecognized tag — is a setup failure in disguise and blocks exit 0.
// Membership, not prose, is what runOutcome checks.
//
// Adding a member here is how a check stops being required, which is a DESIGN decision rather than a
// reporting one, and nothing is added merely by naming a new tag above. The set carries three, and the
// third is such a decision, taken and recorded:
//
//   * DECIDED_BY_REFERENCE — a check decided elsewhere by reference.
//   * OPTIONAL_DEPENDENCY_ABSENT — an absent optional dependency (`mongosh` for Layer A).
//   * EXTERNAL_PROVIDER_REQUIRED — a check decidable only against a third-party service the harness
//     deliberately does not stand up. Admitted for PATH-GROUPSYNC-26: deciding it needs an identity
//     provider, standing one up would be a mock (CLAUDE.md calls heavy mocking a last resort and no
//     such double exists in this repository), and an IdP double would belong to the OIDC/Entra
//     integration's own tests, where the provider interface IS the subject. This harness's subject is
//     the split-vs-single-container topology; owning identity-provider emulation to serve one check
//     would make it own a subsystem it has no business owning — the same reasoning NG6 already applies
//     to Auth_Gate emulation. The check is retained and permanently skipped absent a real tenant, so
//     its absence is ACCOUNTED FOR rather than a gap.
//
// It replaces OPT_IN_VARIANT, which left with its only producer (BOOT-NOWRITE-RO-24); the set's size
// is a coincidence, not an invariant.
export const ENUMERATED_SKIP_REASONS = Object.freeze([
  SKIP_REASON.EXTERNAL_PROVIDER_REQUIRED,
  SKIP_REASON.DECIDED_BY_REFERENCE,
  SKIP_REASON.OPTIONAL_DEPENDENCY_ABSENT,
]);

const ALL_SKIP_REASONS = Object.freeze(Object.values(SKIP_REASON));

// The statuses that MUST carry an observation. The design says `observation` is "present on fail and
// skip"; a setup-failure carries one too, because a run report that says a check did not run without
// saying why is exactly the opaque outcome Req 5.3 forbids. A `pass` needs no observation — the check
// id and its catalog property already say what held.
const OBSERVATION_REQUIRED = Object.freeze([
  CHECK_STATUS.FAIL,
  CHECK_STATUS.SKIP,
  CHECK_STATUS.SETUP_FAILURE,
]);

// Build one check record from a check id and its raw outcome. The id is looked up in the Check
// Catalog, which fills `layer`, `requirements` and `property` — so those fields equal the catalog's
// rather than being restated by the calling spec (task 7.5: the record is "keyed by check id").
//
// `outcome` is `{ status, observation? }`. `status` must be one of CHECK_STATUS. `observation` is the
// string that decided the outcome; it is required for fail/skip/setup-failure and rejected (as
// meaningless) on a pass — a pass is decided by the check id and its property, not by prose.
//
// Where the catalog records that a check decides only part of a property (the routed-path partition's
// load-balancer half), the record carries a `scope` naming that partial coverage, so the report does
// not overclaim that ROUTE-ALLOW-27 decided all of P2 (task 7.5: "the record says so rather than
// overclaiming"). The record is frozen so a downstream reader cannot mutate a field the catalog owns.
export function buildCheckRecord(id, outcome) {
  const entry = catalogEntryFor(id);

  if (outcome === null || typeof outcome !== 'object') {
    throw new TypeError(
      `Check ${id}: outcome must be an object { status, observation? }, got ${typeof outcome}.`,
    );
  }
  const { status, observation = null, skipReason = null, pathOutcomes = null } = outcome;

  if (!ALL_STATUSES.includes(status)) {
    throw new Error(
      `Check ${id}: status ${JSON.stringify(status)} is not a valid check status. ` +
        `Valid: ${ALL_STATUSES.join(', ')}.`,
    );
  }

  // A `skip` record carries a machine-readable `skipReason` so runOutcome decides benign-vs-blocking
  // by membership rather than by parsing the observation prose (task 15.3). It is required on a skip
  // and rejected on any other status — a pass/fail/setup-failure has no skip reason to name. An
  // unrecognized tag is rejected here rather than silently treated as blocking, because a typo'd
  // reason should fail loudly at emit time like a typo'd status does.
  if (status === CHECK_STATUS.SKIP) {
    if (!ALL_SKIP_REASONS.includes(skipReason)) {
      throw new Error(
        `Check ${id}: a "skip" record requires a skipReason from ${ALL_SKIP_REASONS.join(', ')}, ` +
          `got ${JSON.stringify(skipReason)}. The exit gate reads this tag to tell a benign, ` +
          'enumerated skip from a "decided nothing / stage failed" skip (task 15.3).',
      );
    }
  } else if (skipReason !== null) {
    throw new Error(
      `Check ${id}: a "${status}" record must not carry a skipReason (got ` +
        `${JSON.stringify(skipReason)}). Only a skip names why it did not run.`,
    );
  }

  if (OBSERVATION_REQUIRED.includes(status)) {
    if (typeof observation !== 'string' || observation.trim() === '') {
      throw new Error(
        `Check ${id}: status "${status}" requires a non-empty observation stating what decided ` +
          'it. A fail, skip or setup-failure without a deciding observation is the opaque outcome ' +
          'Req 5.3 forbids.',
      );
    }
  } else if (observation !== null) {
    // A pass carries no observation: the check id and its property already say what held, and a
    // pass "observation" would be prose the report does not read. Reject it so the shape is uniform.
    throw new Error(
      `Check ${id}: a "pass" record must not carry an observation (got ${JSON.stringify(
        observation,
      )}). Pass is decided by the check id and its property, not by prose.`,
    );
  }

  // The per-path outcomes a list-covering check carries below its own status (design.md: "The per-path
  // outcome, which sits below the check status"). PATH-EXERCISE-25 is the one check that has them: it
  // covers twenty-six paths, and Requirements 3.12, 3.13, 3.19 and 3.20 each ask for an outcome
  // distinct from a pass. They land in a SECOND FIELD rather than in `status`, which keeps the
  // check-level vocabulary at pass/fail/skip so the catalog-derived report and the exit-0 gate are
  // untouched. Validated here, at emit time, for the same reason a typo'd skip reason fails here: an
  // artifact carrying an outcome with no reason is the under-reporting Req 5.3 forbids, and `reason` is
  // required on every outcome but `pass`.
  if (pathOutcomes !== null) {
    const problems = pathOutcomesProblems(pathOutcomes);
    if (problems.length > 0) {
      throw new Error(
        `Check ${id}: pathOutcomes is malformed — ${problems.length} problem(s): ` +
          problems.join(' '),
      );
    }
  }

  const record = {
    id,
    layer: entry.layer,
    // Copy the array so a caller cannot mutate the catalog's frozen entry through the record.
    requirements: [...entry.requirements],
    property: entry.property,
    status,
    // Uniform key presence: `observation` is always on the record, null on a pass. A stable shape is
    // easier for the CI artifact consumer than a key that appears and disappears.
    observation: OBSERVATION_REQUIRED.includes(status) ? observation : null,
    // `skipReason` is always on the record too — the enumerated tag on a skip, null otherwise — so the
    // exit gate reads a uniform field and the artifact records why each skip did not run.
    skipReason: status === CHECK_STATUS.SKIP ? skipReason : null,
  };

  // Only when the catalog marks this check as deciding part of a property, and only then, does the
  // record carry the scope — an absent `scope` means the check decides its whole property.
  if (entry.partial) {
    record.scope = entry.partial;
  }

  // Only a check that reported per-path outcomes carries the field, so every other record keeps the
  // exact shape it had. Normalized to the six recorded fields, so a producer's working fields do not
  // leak into the artifact's data model.
  if (pathOutcomes !== null) {
    record.pathOutcomes = Object.freeze(pathOutcomes.map(normalizePathOutcome));
  }

  return Object.freeze(record);
}

// Fold an array of raw check outcomes, keyed by id, into a records array. `outcomes` is an object
// `{ [checkId]: { status, observation? } }` — the natural shape for a caller that collects one
// outcome per check id — and the result is the records in catalog-independent input order. Kept
// separate from serializeRun so a caller can inspect the records before rendering them.
export function buildRecords(outcomes) {
  return Object.entries(outcomes).map(([id, outcome]) => buildCheckRecord(id, outcome));
}

// Count records by status, so the summary can lead with a one-line tally and the exit code can be
// decided without re-scanning. Returns a plain object with every status present (zero where none),
// so a consumer reads a fixed shape.
export function tallyByStatus(records) {
  const tally = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
  for (const record of records) {
    tally[record.status] += 1;
  }
  return tally;
}

// The overall run outcome. Exit 0 is the HONEST all-clear (design: "Honest exit status", Req 5.9):
// every check the profile selected carries a record, none is a fail, no setup or teardown failure was
// recorded, every skip names an ENUMERATED reason, AND at least one check actually executed. Anything
// else is a non-zero run (RUN-REPORT-32).
//
// The two clauses task 15.3 adds over the earlier "no fail, no setup/teardown failure" gate:
//
//   * A skip whose reason is NOT enumerated — NOT_EXECUTED, or an unrecognized tag — is a setup
//     failure in disguise: a stage that failed, a spec that would not load, a context never
//     published. It contributes to hasSetupFailure and blocks exit 0, so it is never mistaken for a
//     benign, accounted-for absence (design: "A `skip` from any other cause … is a setup failure").
//
//   * A run in which NOTHING executed — every record is a skip, even if every skip is enumerated —
//     decided nothing, so it exits non-zero (the `nothingExecuted` clause). This is the one that
//     catches "exit 0 having brought nothing up": a live run whose live checks all self-skipped for an
//     absent topology carries no pass and no fail, and must not read as a clean all-pass.
//
// A setup-failure record, a run-level setupFailure, or a teardown-failure each forces non-zero on its
// own even when no check failed — a topology that never came up decided nothing and a leaked resource
// is not a clean run. The three outcome classes stay distinct in the returned flags so the report can
// name what happened rather than collapsing everything into "some check failed".
export function runOutcome(records, { setupFailure = null, teardownFailure = null } = {}) {
  const tally = tallyByStatus(records);
  const hasCheckFailure = tally[CHECK_STATUS.FAIL] > 0;

  // A skip whose reason is not in the enumerated set is a masquerading setup failure: the check did
  // not run because a stage failed, a spec would not load, or a context was never published, not
  // because it was a benign by-reference / optional-dependency / external-provider absence.
  const nonEnumeratedSkips = records.filter(
    (record) =>
      record.status === CHECK_STATUS.SKIP && !ENUMERATED_SKIP_REASONS.includes(record.skipReason),
  );
  const hasNonEnumeratedSkip = nonEnumeratedSkips.length > 0;

  const hasSetupFailure =
    tally[CHECK_STATUS.SETUP_FAILURE] > 0 || setupFailure !== null || hasNonEnumeratedSkip;

  // At least one check must have actually executed — a real pass or fail, not a skip. A run of only
  // skips (even all-enumerated) decided nothing and cannot be the all-clear.
  const executedCount = tally[CHECK_STATUS.PASS] + tally[CHECK_STATUS.FAIL];
  const nothingExecuted = executedCount === 0;

  const hasTeardownFailure = teardownFailure !== null;
  const ok = !hasCheckFailure && !hasSetupFailure && !hasTeardownFailure && !nothingExecuted;

  return {
    ok,
    exitCode: ok ? 0 : 1,
    tally,
    executedCount,
    hasCheckFailure,
    hasSetupFailure,
    hasTeardownFailure,
    nothingExecuted,
    // The ids of the skips that blocked exit 0 by being non-enumerated, so the report can name them
    // rather than leaving a reader to diff the tally.
    nonEnumeratedSkipIds: nonEnumeratedSkips.map((record) => record.id),
  };
}

// Normalize a run.mjs SetupFailure / TeardownFailure (or a plain shape) into the summary's failure
// section. Reads the fields run.mjs's classes expose (`kind`, `service`, `remaining`, `detail`) so
// the report names what run.mjs already classified rather than re-deriving it. Returns null for a
// null input, so the caller can pass through "no setup failure" unchanged.
function normalizeRunFailure(failure) {
  if (failure === null || failure === undefined) {
    return null;
  }
  return {
    kind: failure.kind ?? null,
    message: failure.message ?? String(failure),
    service: failure.service ?? null,
    remaining: failure.remaining ?? null,
    detail: failure.detail ?? null,
  };
}

// Normalize the tested-image record into the report's top-level `image` block (task 17.5, Req 5.12).
// Returns null for a null/absent record (a run that ended before image resolution), or the four
// reported fields otherwise — `reference`, `id`, `createdAt`, `provenance` — with `id`/`createdAt`
// null when the inspect produced no usable value, reported as null rather than fabricated. Reads only
// those four fields, so a caller handing a richer object does not leak working fields into the
// artifact.
function normalizeImageBlock(image) {
  if (image === null || image === undefined || typeof image !== 'object') {
    return null;
  }
  return {
    reference: image.reference ?? null,
    id: image.id ?? null,
    createdAt: image.createdAt ?? null,
    provenance: image.provenance ?? null,
  };
}

// Serialize a whole run into the JSON summary the CI lane attaches and the human-readable text a
// reader scans — the two views of the same records, produced together so they cannot disagree
// (RUN-REPORT-32, reporting half). `records` is the array from buildRecords; `setupFailure` and
// `teardownFailure` are the run.mjs failures if either occurred (each null otherwise). `profile` and
// `startedAt` annotate the run so an attached artifact says which profile produced it and when.
//
// Returns `{ json, text, outcome }`: `json` is the object to write as the machine artifact, `text` is
// the human summary, `outcome` is runOutcome's verdict (including the exit code the runner uses).
//
// `image` is the tested-image identity record (task 17.5, Req 5.12): `{ reference, id, createdAt,
// provenance }`, the image both containers started from. When supplied it is written as a top-level
// `image` block beside `profile` and `startedAt`, and its four fields are rendered in the human text.
// When ABSENT — a run that ended before image resolution (a setup failure in `prepareSetup`, before
// stage 2) — the `image` key is set to NULL rather than omitted: the artifact shape stays uniform, and
// `image === null` reads unambiguously as "no image was resolved this run" rather than as a key a
// consumer forgot to write. (Chosen over omission so every report carries the key.)
export function serializeRun(
  records,
  {
    profile = 'split',
    startedAt = null,
    setupFailure = null,
    teardownFailure = null,
    image = null,
  } = {},
) {
  const outcome = runOutcome(records, { setupFailure, teardownFailure });

  const json = {
    // A schema tag so a future record-shape change is a visible version bump rather than a silent
    // reinterpretation of an old artifact.
    schema: 'container-split-run-report/1',
    profile,
    startedAt,
    // The tested image, beside profile and startedAt (design: "The tested image, at the top of the
    // report"). null when the run ended before image resolution (Req 5.12 distinction), a four-field
    // block otherwise.
    image: normalizeImageBlock(image),
    generatedAt: new Date().toISOString(),
    outcome: {
      ok: outcome.ok,
      exitCode: outcome.exitCode,
      tally: outcome.tally,
      executedCount: outcome.executedCount,
      nothingExecuted: outcome.nothingExecuted,
      nonEnumeratedSkipIds: outcome.nonEnumeratedSkipIds,
    },
    setupFailure: normalizeRunFailure(setupFailure),
    teardownFailure: normalizeRunFailure(teardownFailure),
    // The per-check records, keyed by check id — the shape the design specifies for the artifact.
    checks: Object.fromEntries(records.map((record) => [record.id, record])),
  };

  return { json, text: renderText(json, records), outcome };
}

// Render the human-readable summary from the same JSON the artifact carries, so the text a reader
// scans and the artifact CI attaches are two renderings of one source. Leads with the tally, then one
// line per check (fail and skip and setup-failure carry their observation; a pass does not), then the
// setup/teardown failure sections if either occurred.
function renderText(json, records) {
  const lines = [];
  const { tally } = json.outcome;
  lines.push(
    `Container-split run report (profile: ${json.profile}) — ` +
      `${tally[CHECK_STATUS.PASS]} pass, ${tally[CHECK_STATUS.FAIL]} fail, ` +
      `${tally[CHECK_STATUS.SKIP]} skip, ${tally[CHECK_STATUS.SETUP_FAILURE]} setup-failure`,
  );
  lines.push(
    `Outcome: ${json.outcome.ok ? 'PASS (exit 0)' : `FAIL (exit ${json.outcome.exitCode})`}`,
  );
  // Name why a non-zero run that had no check fail and no setup/teardown failure still could not reach
  // exit 0: either nothing executed (a run of only skips decided nothing) or a skip was non-enumerated
  // (a masquerading setup failure). Without this a reader sees "0 fail" and a non-zero exit and cannot
  // tell why.
  if (!json.outcome.ok && json.outcome.nothingExecuted) {
    lines.push(
      '  reason: no check executed — every record is a skip, so this run decided nothing ' +
        '(exit 0 requires at least one real pass or fail).',
    );
  }
  if (!json.outcome.ok && (json.outcome.nonEnumeratedSkipIds ?? []).length > 0) {
    lines.push(
      `  reason: ${json.outcome.nonEnumeratedSkipIds.length} skip(s) with a non-enumerated reason ` +
        `(treated as setup failure): ${json.outcome.nonEnumeratedSkipIds.join(', ')}.`,
    );
  }
  // The tested image, printed as its four fields (Req 5.12) — the same values the JSON `image` block
  // carries. Absent when the run ended before image resolution, in which case there is nothing tested
  // to name and the line is omitted.
  if (json.image) {
    lines.push(
      `Image: ${json.image.reference ?? '(unknown)'} (${json.image.provenance ?? 'unknown'})`,
    );
    lines.push(`  id: ${json.image.id ?? '(unknown)'}`);
    lines.push(`  created: ${json.image.createdAt ?? '(unknown)'}`);
  }
  lines.push('');

  for (const record of records) {
    const reqs = record.requirements.join(', ');
    const prop = record.property ?? '—';
    const scope = record.scope ? ` [${record.scope}]` : '';
    const head = `  ${record.status.toUpperCase().padEnd(14)} ${record.id}  (req ${reqs}; ${prop})${scope}`;
    lines.push(head);
    if (record.skipReason) {
      lines.push(`      skipReason: ${record.skipReason}`);
    }
    if (record.observation) {
      lines.push(`      observation: ${record.observation}`);
    }
    // Every path with its outcome and its reason, so `undecided` reads as the narrowed scope it is
    // rather than disappearing into an aggregate green (task 11.1). Printed on a pass as well as on a
    // fail: a passing PATH-EXERCISE-25 whose provider paths were all `undecided` is exactly the case
    // that must stay legible.
    if (record.pathOutcomes) {
      lines.push(...renderPathOutcomes(record.pathOutcomes));
    }
  }

  if (json.setupFailure) {
    lines.push('');
    lines.push(
      `SETUP FAILURE [${json.setupFailure.kind ?? 'unknown'}]: ${json.setupFailure.message}`,
    );
    if (json.setupFailure.service) {
      lines.push(`  service: ${json.setupFailure.service}`);
    }
    // `detail` carried what the failure was ABOUT and, until now, only ever reached the JSON. A reader
    // scanning the text summary is the one who has to act on it — and for an unusable per-path sidecar
    // it is the only surviving copy of what was written (the file is consumed on read), so a detail
    // that exists is a detail worth printing.
    if (json.setupFailure.detail) {
      lines.push(`  detail: ${json.setupFailure.detail}`);
    }
  }
  if (json.teardownFailure) {
    lines.push('');
    lines.push(
      `TEARDOWN FAILURE [${json.teardownFailure.kind ?? 'unknown'}]: ${json.teardownFailure.message}`,
    );
    for (const remaining of json.teardownFailure.remaining ?? []) {
      lines.push(`  remained: ${remaining.type ?? 'resource'} ${remaining.name ?? '(unnamed)'}`);
    }
  }

  return lines.join('\n');
}
