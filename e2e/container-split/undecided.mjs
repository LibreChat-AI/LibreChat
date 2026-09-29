// undecided.mjs — how a Layer B check says "I could not observe my property".
//
// Three outcomes were expressible before this module: pass, fail, and an absence the REPORTER derived
// from the catalog (a check that registered no Jest result at all). A fourth case has no home in that
// set: a check that ran, reached for its observation, and found the observation itself unusable —
// BOOT-NOWRITE-23 against a `system.profile` that rolled past the boot window's left edge. It may not
// report `pass` (nothing was observed) and it is not honestly a `fail` (nothing was falsified either —
// Property 9's distinction, arriving at check level rather than run level). PARITY-COLLAPSE-29 was a
// second instance until Req 4.2 became a structural read of the committed artifacts (design NG9), which
// left it nothing to be undecided about.
//
// So a check that cannot decide THROWS an error whose message carries this signal:
//
//     HARNESS-UNDECIDED[<skip-reason-tag>]: <prose naming what was missing>
//
// reporter.mjs recognizes the signal on a failed assertion and records the check as a `skip` with that
// machine-readable reason, carrying the prose as the observation. Two consequences, both deliberate:
//
//   * Jest still counts the test as FAILED, so the Layer B exit status is non-zero. That is correct:
//     the run did not decide the property, and a run with an undecided check is not a clean run.
//   * The RECORD says `skip`, not `fail`, so the artifact does not claim the property was falsified.
//     The reasons this signal carries are deliberately OUTSIDE serializer.mjs's
//     ENUMERATED_SKIP_REASONS, so the skip blocks exit 0 exactly as NOT_EXECUTED does — an undecided
//     check is never a benign, accounted-for absence.
//
// Why a thrown signal rather than `test.skip`: the undecidability is discovered AT RUN TIME (the
// profile read happens inside the test), and a
// definition-time `test.skip` also reports under the NOT_EXECUTED reason with no way to name which
// observation was missing. A throw carries the reason tag and the diagnostic prose in one place, from
// the exact point the check learned it could not decide.
//
// NG1/NG2 hold: this is the harness's own reporting vocabulary. It touches no application code and
// neither container-split script.

// The signal's prefix and its parse. `[A-Z-]+` is the reason tag; reporter.mjs validates the captured
// tag against serializer.mjs's SKIP_REASON values, so a typo'd tag is not silently honored.
export const UNDECIDED_SIGNAL = 'HARNESS-UNDECIDED';
const SIGNAL_PATTERN = /HARNESS-UNDECIDED\[([a-z-]+)\]:\s*([\s\S]*)$/;

// Format the signal. `reason` is a serializer.mjs SKIP_REASON tag; `observation` is the prose a reader
// scans. Kept as its own function so the producing check and the parsing reporter share one spelling.
export function formatUndecided(reason, observation) {
  return `${UNDECIDED_SIGNAL}[${reason}]: ${observation}`;
}

// The Error a check throws when it cannot decide. An ordinary Error subclass so Jest reports it the
// way it reports any assertion failure — the message is what crosses into the reporter.
export class UndecidedObservation extends Error {
  constructor(reason, observation) {
    super(formatUndecided(reason, observation));
    this.name = 'UndecidedObservation';
    this.reason = reason;
    this.observation = observation;
  }
}

// Parse a failure message for the signal. Returns `{ reason, observation }` when the message carries
// one, null otherwise. Pure over the text, so both the reporter and a unit test read one parse. The
// observation keeps everything after the tag — Jest appends its stack to the message, which is
// diagnostic context a reader of a non-pass record wants anyway.
export function parseUndecided(message) {
  if (typeof message !== 'string') {
    return null;
  }
  const match = SIGNAL_PATTERN.exec(message);
  if (match === null) {
    return null;
  }
  return { reason: match[1], observation: match[2].trim() };
}
