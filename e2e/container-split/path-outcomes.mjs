// path-outcomes.mjs — the per-path outcome vocabulary, and the channel that carries it from the check
// that decided it to the record the reporter writes (task 11.1).
//
// `PATH-EXERCISE-25` covers a LIST of paths, and Requirements 3.12, 3.13, 3.19 and 3.20 each ask for a
// reported outcome that is distinct from a pass. Those outcomes live in a SECOND FIELD on that check's
// record — `pathOutcomes` — and never in the check-level `status` vocabulary, which stays
// `pass | fail | skip` so the catalog-derived report and the exit-0 gate are untouched (design.md: "The
// per-path outcome, which sits below the check status").
//
//   pathOutcomes: Array<{
//     path: string,
//     attributedTo: 'auth-surface' | 'api-container' | null,
//     httpStatus: number,
//     windowClean: boolean,
//     outcome: 'pass' | 'understated' | 'uncorroborated' | 'undecided',
//     reason: string   // required on every outcome but `pass`
//   }>
//
// This module owns three things and nothing else: the four outcome tags, the shape validation, and the
// cross-process channel described below. The DECISION RULE that produces an outcome lives in
// checks/path-exercise.filter.mjs; the record it lands on is built by serializer.mjs.
//
// == Why a file is the channel ==
// reporter.mjs is a Jest custom reporter: it runs in the Jest HOST process and sees only each test's
// `{ status, failureMessages, fullName }`. The check runs inside a jest-environment-node sandbox with
// its own `globalThis`, so a `globalThis.__…__` hand-off cannot reach the reporter (this is the same
// process boundary jest.setup.mjs exists to cross from the other direction, and the same reason
// undecided.mjs signals through a thrown MESSAGE). A message-encoded payload is not enough here,
// because a PASSING check has no message and its `undecided` entries are exactly what must stay
// visible — "so `undecided` reads as the narrowed scope it is rather than disappearing into an
// aggregate green". So the check publishes the outcomes to a small sidecar file beside the run report
// and the reporter consumes it, which is the one channel both processes share.
//
// == Absent is not the same as unusable ==
// A sidecar that is not there is the ordinary case — no live path exercise ran — and is reported as
// nothing at all. A sidecar that IS there and cannot be used is a harness defect: the outcomes were
// decided, written, and then lost on the way to the artifact, which is the under-reporting Req 5.3/5.4
// forbid. `consumePublishedPathOutcomes` therefore returns null only for the first and a `problems`
// list for the second, and reporter.mjs makes the second loud. Collapsing the two into one null is what
// let a written-then-rejected sidecar leave a passing check with no per-path table and no diagnostic.
//
// == Staleness, and why it cannot mislead ==
// `consumePublishedPathOutcomes` UNLINKS the sidecar as it reads, so a second Jest invocation cannot
// inherit the first's outcomes. reporter.mjs additionally attaches the payload only to a check that
// produced a real Jest result this run — never to a derived `skip` — so even a sidecar left behind by a
// crashed run cannot decorate a check that did not execute. A report that attached a previous run's
// per-path outcomes to a check that never ran would be a false statement in the artifact, which is
// worse than an absent one (reporter.mjs makes the same argument about Layer A's verdict).
//
// NG1/NG2 hold: this is the harness's own reporting vocabulary. It touches no application code and
// neither container-split script.

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The four per-path outcomes, and the requirement each one answers. This is a CLOSED set: an
// observation that is not one of these four is not an outcome at all (see EXERCISE_FAILURE in
// checks/path-exercise.filter.mjs — an unscanned window and an unattached Session_Fixture are the two
// the design names, and neither is a verdict).
//
//   PASS           — attributed to the Auth_Surface, non-5xx, clean window (Req 3.13).
//   UNDERSTATED    — an Authorization_Error in the window, AT ANY STATUS. The one observation that
//                    supports the claim that the ownership matrix understates this path's collection
//                    needs, and the only outcome that carries the recompute guidance (Req 3.4).
//   UNCORROBORATED — a 5xx over a clean window. An `Uncorroborated_Server_Error`: a real finding about
//                    the application or the harness configuration, and NOT a grant conclusion in
//                    either direction, so it carries no recompute guidance (Req 3.12).
//   UNDECIDED      — an `Unconfigured_Provider` path, naming the provider. Distinct from a pass, not a
//                    failure, and it does not satisfy the "at least one pass" clause (Req 3.19, 3.20).
export const PATH_OUTCOME = Object.freeze({
  PASS: 'pass',
  UNDERSTATED: 'understated',
  UNCORROBORATED: 'uncorroborated',
  UNDECIDED: 'undecided',
});

export const ALL_PATH_OUTCOMES = Object.freeze(Object.values(PATH_OUTCOME));

// The outcomes that FAIL the check. Named as a set rather than as a severity ordering, because the
// check's status is deliberately not "worst outcome wins": `undecided` is not a failure, and an
// all-`undecided` list is not a pass either (see summarizePathExercise in
// checks/path-exercise.filter.mjs).
export const FAILING_PATH_OUTCOMES = Object.freeze([
  PATH_OUTCOME.UNDERSTATED,
  PATH_OUTCOME.UNCORROBORATED,
]);

// The one outcome that may omit `reason`. Every other outcome must say why it landed where it did —
// `understated` names the matched log line and the collection in it, `uncorroborated` names the path
// and the status, `undecided` names the unconfigured provider.
const REASON_OPTIONAL_OUTCOME = PATH_OUTCOME.PASS;

// The sidecar the check publishes and the reporter consumes. Beside the run report, gitignored, and
// named here once so the two processes cannot disagree about where it is.
export const PATH_OUTCOMES_PATH = path.join(HERE, 'path-outcomes.json');

// Validate one per-path outcome against the recorded data model. Returns an array of problems (empty
// when the entry is well formed), so a caller can report every defect in one pass rather than throwing
// on the first. Pure over the entry.
export function pathOutcomeProblems(entry, index = 0) {
  const at = `pathOutcomes[${index}]`;
  const problems = [];
  if (entry === null || typeof entry !== 'object') {
    return [`${at} must be an object, got ${entry === null ? 'null' : typeof entry}.`];
  }
  if (typeof entry.path !== 'string' || !entry.path.startsWith('/')) {
    problems.push(`${at}.path must be the exercised path, got ${JSON.stringify(entry.path)}.`);
  }
  if (!ALL_PATH_OUTCOMES.includes(entry.outcome)) {
    problems.push(
      `${at}.outcome ${JSON.stringify(entry.outcome)} is not one of ${ALL_PATH_OUTCOMES.join(', ')}.`,
    );
  }
  if (entry.attributedTo !== null && typeof entry.attributedTo !== 'string') {
    problems.push(
      `${at}.attributedTo must be the upstream the proxy named, or null when it named none, got ` +
        `${JSON.stringify(entry.attributedTo)}.`,
    );
  }
  if (!Number.isInteger(entry.httpStatus)) {
    problems.push(`${at}.httpStatus must be the returned status, got ${entry.httpStatus}.`);
  }
  if (typeof entry.windowClean !== 'boolean') {
    // `windowClean` records the ONE observation that decides grant sufficiency, so it is required on
    // every outcome. An entry with no `windowClean` is an entry whose window was not scanned, which is
    // not an outcome at all (Property 9).
    problems.push(
      `${at}.windowClean must be a boolean: the Exercise_Log_Window scan is what decides grant ` +
        'sufficiency, so an outcome cannot be recorded without it (Req 3.4).',
    );
  }
  if (entry.outcome !== REASON_OPTIONAL_OUTCOME) {
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      problems.push(
        `${at} is "${entry.outcome}" and therefore requires a reason; only "pass" may omit one.`,
      );
    }
  }
  return problems;
}

// Validate a whole list. Returns the problems across every entry, prefixed with its index.
export function pathOutcomesProblems(outcomes) {
  if (!Array.isArray(outcomes)) {
    return [`pathOutcomes must be an array, got ${typeof outcomes}.`];
  }
  return outcomes.flatMap((entry, index) => pathOutcomeProblems(entry, index));
}

// Normalize one outcome to exactly the six recorded fields, dropping anything a producer carried
// alongside them. The record's shape is the design's; a producer's working fields (the surface label,
// the log read, the expected status) belong in the check's observation prose, not in the artifact's
// data model.
export function normalizePathOutcome(entry) {
  return Object.freeze({
    path: entry.path,
    attributedTo: entry.attributedTo ?? null,
    httpStatus: entry.httpStatus,
    windowClean: entry.windowClean,
    outcome: entry.outcome,
    reason: entry.outcome === REASON_OPTIONAL_OUTCOME ? (entry.reason ?? null) : entry.reason,
  });
}

// Publish the outcomes for one check id. Writes the sidecar `consumePublishedPathOutcomes` reads.
// Throws on a malformed list rather than publishing it: an artifact carrying an outcome with no reason
// is the under-reporting Req 5.3 forbids, and it is cheaper to fail where the list was built.
export async function publishPathOutcomes(
  checkId,
  outcomes,
  { filePath = PATH_OUTCOMES_PATH } = {},
) {
  const problems = pathOutcomesProblems(outcomes);
  if (problems.length > 0) {
    throw new Error(
      `${checkId}: cannot publish per-path outcomes — ${problems.length} problem(s): ` +
        problems.join(' '),
    );
  }
  const payload = {
    schema: 'container-split-path-outcomes/1',
    checkId,
    publishedAt: new Date().toISOString(),
    pathOutcomes: outcomes.map(normalizePathOutcome),
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

// How much of an unusable sidecar's text the diagnostic quotes. Enough to recognize what was written
// without pasting a twenty-six-entry payload into the run summary.
const SIDECAR_EXCERPT_LIMIT = 400;

// Read the sidecar and DELETE it, so no later run can inherit these outcomes.
//
// ABSENT and UNUSABLE are two different findings and this returns them differently:
//
//   * null — the file is absent (or unreadable). The ordinary case: no live path exercise ran. A
//     missing sidecar is not an error, it is the absence of a live exercise, and the reporter still
//     records the check from the catalog exactly as it does for any id that produced no result.
//   * `{ payload, problems: [], filePath, excerpt }` — a well-formed payload, ready to attach.
//   * `{ payload: null, problems: [...], filePath, excerpt }` — the sidecar was PRESENT and could not
//     be used: unparseable, or a list that fails the recorded data model. That is a harness defect, not
//     an absent exercise, and it must never read as the latter. An earlier revision returned null for
//     all three, so a written-then-rejected sidecar produced exactly the symptom a silent drop
//     produces: the file gone, nothing attached, and no diagnostic anywhere — a passing
//     PATH-EXERCISE-25 whose `undecided` entries had vanished into an aggregate green (Req 5.3, 5.4).
//     The caller (reporter.mjs) turns a non-empty `problems` into a loud run-level failure.
//
// The unlink happens AFTER the payload has been parsed and validated rather than before, so the
// problems and the `excerpt` a diagnostic needs are produced from a file that still existed when it was
// read — and it happens on EVERY path out, including the unusable one, so the anti-staleness guarantee
// is unchanged: no later run can inherit these outcomes, well formed or not. (`raw` is in memory either
// way; what moved is only the point at which the file stops existing, so nothing can be reported about
// a sidecar this function silently removed.)
export async function consumePublishedPathOutcomes({ filePath = PATH_OUTCOMES_PATH } = {}) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const excerpt =
    raw.length > SIDECAR_EXCERPT_LIMIT ? `${raw.slice(0, SIDECAR_EXCERPT_LIMIT)}…` : raw;
  try {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      return {
        payload: null,
        problems: [`the sidecar is not valid JSON: ${error.message}.`],
        filePath,
        excerpt,
      };
    }
    const problems = pathOutcomesProblems(payload?.pathOutcomes);
    if (problems.length > 0) {
      return { payload: null, problems, filePath, excerpt };
    }
    return { payload, problems: [], filePath, excerpt };
  } finally {
    // Unconditional, on every path out: read once, then gone.
    await unlink(filePath).catch(() => {});
  }
}

// Render the outcomes for the human-readable report: one line per path with its outcome and its
// reason, plus a leading tally, so every path is reported and `undecided` reads as the narrowed scope
// it is rather than disappearing into an aggregate green. Pure over the list.
export function renderPathOutcomes(outcomes, { indent = '      ' } = {}) {
  const tally = tallyPathOutcomes(outcomes);
  const lines = [
    `${indent}pathOutcomes: ${ALL_PATH_OUTCOMES.map((outcome) => `${tally[outcome]} ${outcome}`).join(', ')}`,
  ];
  for (const entry of outcomes) {
    const attribution = entry.attributedTo ?? 'no upstream header';
    lines.push(
      `${indent}  ${entry.outcome.padEnd(14)} ${entry.path}  ` +
        `(status ${entry.httpStatus}; window ${entry.windowClean ? 'clean' : 'AUTHORIZATION ERROR'}; ` +
        `attributed to ${attribution})`,
    );
    if (entry.reason) {
      lines.push(`${indent}    reason: ${entry.reason}`);
    }
  }
  return lines;
}

// Count the outcomes by tag, with every tag present (zero where none), so a consumer reads a fixed
// shape.
export function tallyPathOutcomes(outcomes) {
  const tally = Object.fromEntries(ALL_PATH_OUTCOMES.map((outcome) => [outcome, 0]));
  for (const entry of outcomes ?? []) {
    if (Object.hasOwn(tally, entry?.outcome)) {
      tally[entry.outcome] += 1;
    }
  }
  return tally;
}
