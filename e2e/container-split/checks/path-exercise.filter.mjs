// path-exercise.filter.mjs — the pure decision logic and constants behind this check's Layer B spec (task 14.6).
//
// The exported deciders and constants this check's spec relies on live here, in a non-spec sibling
// module, so the spec file (path-exercise.spec.mjs) can import them and export NOTHING itself. jest.config.mjs's
// testMatch collects only `*.spec.mjs` / `*.test.mjs`, so a `.filter.mjs` is never collected as a
// test — the same shape boot-nowrite.filter.mjs establishes.
//
// == THE RULE: one window scan, four classifications. Never a sequence of gates. ==
// This module previously applied three gates in sequence — attribution, then a non-5xx status
// assertion, then the `Exercise_Log_Window` scan — and RETURNED AT GATE 2. On the live run eight of
// twenty-six paths failed at gate 2 and were reported under gate 3's meaning, *the ownership matrix
// understates this path's collection needs*: a claim about the grant drawn from a status code, with the
// corroborating scan never run. Criterion 3.4 had always named the Authorization_Error as the trigger,
// so the criterion was never weak — the gate order put the sound evidence one step past the early
// return, and the evidence was already there and was unreachable.
//
// The replacement is not a better ordering, and the code is shaped so that it cannot become one:
//
//   * `observeExercise` COLLECTS. It issues the request and scans the window, unconditionally, in that
//     order, with no branch between them and no classification logic of any kind. It cannot short-
//     circuit on a status because it never asks what the status means.
//   * `classifyExercise` DECIDES. It is pure over an already-collected observation record and holds no
//     client, so it cannot skip the scan — there is nothing left to skip. It REFUSES to classify an
//     observation whose window was not scanned (throwing `WindowNotScannedError`), so an unscanned
//     window can never be absorbed as a verdict (Property 9).
//
// That split is the structural guarantee. Any *sequence* of gates can be re-broken by inserting a
// cheaper check ahead of the deciding one, and there is no ordering of gates in which a 5xx
// short-circuit is harmless — so there is no sequence here to insert one into. The status only
// CLASSIFIES an exercise; the scan is what decides grant sufficiency.
//
// NG1/NG2 hold: this decides over the harness's own artifacts and touches no application code and
// neither container-split script.

import { HARNESS_UPSTREAM_HEADER } from '../run.mjs';
import { FAILING_PATH_OUTCOMES, PATH_OUTCOME, tallyPathOutcomes } from '../path-outcomes.mjs';

import { SESSION_ATTACHMENT, toIngressRequest } from './path-exercise.payloads.mjs';
import { attachSessionFixture } from './path-exercise.session.mjs';

// NOTE on module direction: path-exercise.providers.mjs imports AUTH_SURFACE_ROUTED_PATHS FROM this
// module, so this module deliberately does not import it back. The `Unconfigured_Provider` reason is
// therefore passed IN to the decision rule (`undecidedReason`) rather than looked up here — which also
// keeps the rule decidable with a synthetic reason string and no resolved provider configuration.

// The check id this spec decides. The reporter parses it from each `it` title's leading
// `[CHECK-ID]` tag and the serializer looks it up in the Check Catalog for layer/requirements/
// property, so the id is named once here and prefixed onto every title (reporter.mjs: parseCheckId).
export const CHECK_ID = 'PATH-EXERCISE-25';

// The upstream this check's paths must be attributed to. It is the Caddyfile.split X-Harness-Upstream
// value for the allowlist handle block (`header X-Harness-Upstream "auth-surface"`). Named here so
// the attribution assertion and the routed-path list read one source.
export const AUTH_SURFACE_UPSTREAM = 'auth-surface';

// Every path routed to the Auth_Surface, drawn from the Caddyfile.split Auth_Surface_Allowlist and
// the design's PATH-EXERCISE-25 row (both listing: local login, LDAP, each social provider,
// registration, 2FA enroll/verify/disable/backup-codes, password reset request and submit, email
// verification and resend, admin login, admin oauth, /api/config, /api/banner, SPA load).
//
// Each entry names the surface it exercises, the concrete path a request lands on (a full path the
// allowlist routes to auth-surface, never a bare-prefix), and the HTTP method the surface answers.
// What each exercise SENDS is the recorded `Path_Payload` (path-exercise.payloads.mjs, task 11.4) and,
// on a session-gated path, the `Session_Fixture` (path-exercise.session.mjs, task 11.5): a request
// chosen to reach the handler, because an absent body tests a handler on MALFORMED input and an
// unhandled throw is a 5xx that says nothing about the grant.
//
// The paths are transcribed from the allowlist without re-derivation (NG4): moving a path between the
// two routed sets is a Container_1_Grant recompute (Req 2.11), not an edit here. A path added to the
// allowlist that this list omits would go un-exercised — so this list is kept in lockstep with the
// allowlist. There is no digest tripwire: a moved path surfaces against the current allowlist and
// grant — misattributed it fails ROUTE-ALLOW-27/ROUTE-DEFAULT-28, and routed to the Auth_Surface with
// needs outside the grant PATH-EXERCISE-25 reports it `understated`.
export const AUTH_SURFACE_ROUTED_PATHS = Object.freeze([
  // Local authentication.
  { surface: 'local login', path: '/api/auth/login', method: 'POST' },
  { surface: 'logout', path: '/api/auth/logout', method: 'POST' },
  { surface: 'refresh', path: '/api/auth/refresh', method: 'POST' },
  // LDAP login shares the local login mount under /api/auth.
  { surface: 'LDAP login', path: '/api/auth/ldap', method: 'POST' },
  // Registration.
  { surface: 'registration', path: '/api/auth/register', method: 'POST' },
  // Social providers — each initiates its OAuth handshake under /oauth/<provider>.
  { surface: 'social: google', path: '/oauth/google', method: 'GET' },
  { surface: 'social: github', path: '/oauth/github', method: 'GET' },
  { surface: 'social: discord', path: '/oauth/discord', method: 'GET' },
  { surface: 'social: facebook', path: '/oauth/facebook', method: 'GET' },
  { surface: 'social: openid', path: '/oauth/openid', method: 'GET' },
  { surface: 'social: apple', path: '/oauth/apple', method: 'GET' },
  // 2FA (TOTP) enroll / verify / disable / backup codes — all under /api/auth/2fa.
  { surface: '2FA enroll', path: '/api/auth/2fa/enable', method: 'POST' },
  { surface: '2FA verify', path: '/api/auth/2fa/verify', method: 'POST' },
  { surface: '2FA disable', path: '/api/auth/2fa/disable', method: 'POST' },
  { surface: '2FA backup codes', path: '/api/auth/2fa/backup/regenerate', method: 'POST' },
  // Password reset — request and submit.
  { surface: 'password reset request', path: '/api/auth/requestPasswordReset', method: 'POST' },
  { surface: 'password reset submit', path: '/api/auth/resetPassword', method: 'POST' },
  // Email verification and resend.
  { surface: 'email verification', path: '/api/user/verify', method: 'POST' },
  { surface: 'email verification resend', path: '/api/user/verify/resend', method: 'POST' },
  // Admin login and admin oauth (full-path matchers, never the /api/admin data prefix).
  { surface: 'admin login', path: '/api/admin/login', method: 'POST' },
  { surface: 'admin oauth', path: '/api/admin/oauth', method: 'GET' },
  // Public config and banner reads the Auth_Surface serves.
  { surface: 'config', path: '/api/config', method: 'GET' },
  { surface: 'banner', path: '/api/banner', method: 'GET' },
  // SPA document load. The allowlist enumerates the SPA document routes explicitly; `/login` is one.
  // Note in the observation: an SPA load is not evidence of routing direction (both containers serve
  // the same index.html from the same image), so this exercise leans on X-Harness-Upstream for
  // attribution exactly as every other entry does.
  { surface: 'SPA load', path: '/login', method: 'GET' },
]);

// The exercises that must run LAST, in this order, and why. `/api/auth/logout` deletes the durable
// session the `Session_Fixture` names (path-exercise.payloads.mjs records the hazard on the entry), so
// every other session-carrying exercise has to precede it; `/api/auth/refresh` reads the same session,
// so it precedes logout too. Ordering the plan here rather than relying on the routed list's order
// keeps the hazard beside the reason for it — and a reordering of the routed list cannot silently
// invalidate every session-gated exercise.
export const DEFERRED_EXERCISE_ORDER = Object.freeze(['/api/auth/refresh', '/api/auth/logout']);

// The routed paths in the order they must be exercised. Pure over the list, so the ordering is
// assertable without a topology.
export function orderedRoutedPaths(routedPaths = AUTH_SURFACE_ROUTED_PATHS) {
  const deferred = [];
  const first = [];
  for (const entry of routedPaths) {
    if (DEFERRED_EXERCISE_ORDER.includes(entry.path)) {
      deferred.push(entry);
      continue;
    }
    first.push(entry);
  }
  deferred.sort(
    (a, b) => DEFERRED_EXERCISE_ORDER.indexOf(a.path) - DEFERRED_EXERCISE_ORDER.indexOf(b.path),
  );
  return Object.freeze([...first, ...deferred]);
}

// The statuses that mean the upstream ANSWERED the request rather than failing inside it. A 5xx is the
// shape an unhandled grant-insufficiency fault takes AND the shape an absent feature takes AND the
// shape a proxy that could not reach its upstream takes — which is exactly why it cannot decide the
// grant on its own. 4xx is served: an anonymous request to a real auth route legitimately returns 4xx
// (the application enforcing its own auth), which is the route being served, not a grant refusal.
export function isUpstreamServed(status) {
  return typeof status === 'number' && status >= 100 && status < 500;
}

// Is this a server error? The classification input for `uncorroborated` — and nothing more than a
// classification: a 5xx over a clean window says something about the application or the harness
// configuration and NOTHING about the grant in either direction (Req 3.12).
export function isServerError(status) {
  return typeof status === 'number' && status >= 500 && status < 600;
}

// The authorization-error signature in an Auth_Surface log line. mongod phrases a refused operation
// as "not authorized on <db> to execute command" / "Unauthorized"; the application may log it as a
// caught MongoServerError with code 13 (the MongoDB Unauthorized code) even when it swallows the
// error and still answers the request. The matcher is deliberately broad across those phrasings so a
// swallowed refusal cannot slip through on wording. It is anchored to authorization specifically so an
// unrelated 500 log line (a bug that is not a grant fault) does not read as one — the recompute
// guidance is only correct for an actual authorization refusal.
const AUTH_ERROR_PATTERNS = Object.freeze([
  /not\s+authorized/i,
  /unauthorized/i,
  /requires\s+authentication/i,
  /\bcode\s*[:=]?\s*13\b/, // MongoDB Unauthorized error code.
  /MongoServerError.*(auth|unauthor)/i,
]);

// Scan a captured Auth_Surface log window for an authorization error. Pure over the log text, so the
// detection is unit-exercisable without a live container. Returns the first matched line (for the
// observation) or null when the window is clean.
export function findAuthorizationError(logText) {
  if (typeof logText !== 'string' || logText.trim() === '') {
    return null;
  }
  for (const line of logText.split('\n')) {
    if (AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(line))) {
      return line.trim();
    }
  }
  return null;
}

// The collection named in an authorization-error line, or null when the line names none. Criterion 3.4
// asks the failure to name the matched log line AND the collection in it, because the collection is
// what a recompute edits — "not authorized on LibreChat to execute command { find: { find: "keys" …"
// is the shape mongod logs, and `keys` is the actionable half of it. Best-effort by construction: the
// line is reported verbatim either way, so a phrasing this does not recognize costs a convenience,
// never the evidence.
const COLLECTION_PATTERNS = Object.freeze([
  // `{ find: "keys"` / `{ insert: "sessions"` — the command document's first field names the collection.
  /\b(?:find|insert|update|delete|remove|aggregate|count|distinct|findAndModify|createIndexes)\s*[:=]\s*["']([A-Za-z0-9_.]+)["']/,
  // `on collection keys` / `collection: "keys"`.
  /\bcollection\s*[:=]?\s*["']?([A-Za-z0-9_.]+)["']?/i,
  // `LibreChat.keys` — a namespace.
  /\b[A-Za-z0-9_]+\.([A-Za-z0-9_]+)\b(?=[^A-Za-z0-9_]*(?:to execute|denied|unauthorized))/i,
]);

export function collectionFromAuthorizationError(logLine) {
  if (typeof logLine !== 'string') {
    return null;
  }
  for (const pattern of COLLECTION_PATTERNS) {
    const match = pattern.exec(logLine);
    if (match !== null && match[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}

// The recompute guidance, and it is CONFINED TO `understated` (Req 3.12: "SHALL confine the
// grant-recompute guidance to an exercise whose Exercise_Log_Window records an Authorization_Error").
// Nothing else may carry it: a 5xx over a clean window refused nothing, so telling a reader to
// recompute the grant from that path's collection needs is advice drawn from a status code, which is
// the defect this check was reopened to remove. Re-running the provisioning script unchanged is
// explicitly NOT the fix and the message says so, because it is the obvious wrong move.
export function recomputeGuidance(
  surface,
  pathText,
  { matchedLine = null, collection = null } = {},
) {
  const named =
    matchedLine === null
      ? ''
      : ` The Auth_Surface logged: ${JSON.stringify(matchedLine)}${
          collection === null
            ? ' (no collection name is parseable from the line — read the line itself).'
            : `, which names the collection \`${collection}\`.`
        }`;
  return (
    `PATH-EXERCISE-25: routed path ${JSON.stringify(pathText)} (${surface}) recorded an ` +
    'Authorization_Error in its Exercise_Log_Window. This is evidence that the ownership matrix ' +
    `UNDERSTATES this path's collection needs (Req 3.4).${named} Recompute the Container_1_Grant ` +
    "from this path's actual collection needs per the provisioning script's guidance — edit the two " +
    'collection lists and provision again. Do not widen the grant blindly, and do not re-run the ' +
    'provisioning script unchanged: re-running re-asserts the same twelve collections and proves ' +
    'nothing about this path.'
  );
}

// The signature of the recompute guidance in a reported reason, expressed on the two load-bearing
// phrases of the text above — the UNDERSTATEMENT CLAIM and the RECOMPUTE INSTRUCTION — rather than on
// the whole string, so a rewording of the surrounding advice does not break a caller asking "did this
// reason carry a grant conclusion?".
//
// It lives here, beside the producer, because the question it answers is a question about THIS rule:
// criterion 3.12 confines the guidance to an exercise whose `Exercise_Log_Window` records an
// Authorization_Error, and the matcher is how a reader (or a test) checks that an `uncorroborated`
// path was not handed one. path-exercise-rule.test.mjs pins it in both directions against
// `recomputeGuidance`'s real output, so a rewording that slipped past the patterns fails there rather
// than quietly making the matcher blind.
const RECOMPUTE_GUIDANCE_PATTERNS = Object.freeze([
  /understates this path's collection needs/i,
  /recompute the Container_1_Grant/i,
]);

// Does this reported reason carry the grant-recompute guidance? Pure over the text, and null-safe: a
// path with no reason (a `pass` may omit one) carries no guidance.
export function carriesRecomputeGuidance(reason) {
  if (typeof reason !== 'string' || reason === '') {
    return false;
  }
  return RECOMPUTE_GUIDANCE_PATTERNS.some((pattern) => pattern.test(reason));
}

// == The two observations that are NOT outcomes, plus the one that is not an exercise ==
//
// The design names two: a window that was not scanned is a SETUP FAILURE, not a verdict (Property 9),
// and a session-gated path exercised with no `Session_Fixture` attached is a FIXTURE FAILURE, never
// the `pass` that 3.13's non-5xx wording would otherwise hand it (Req 3.22, Property 6).
//
// ATTRIBUTION belongs to the same family and is recorded here as a third member for one reason: 3.13
// requires attribution to the Auth_Surface for a pass, and an exercise the proxy attributed elsewhere
// (or to no upstream at all) never reached the container whose grant is under test. Like an unscanned
// window, that is a failed PRECONDITION of the exercise rather than a verdict about the grant — so it
// carries no recompute guidance, and it is reported as the allowlist/routed-list drift it is. It is
// deliberately not folded into `uncorroborated` (which means one specific thing: a 5xx over a clean
// window) and not into `understated` (which requires an Authorization_Error).
export const EXERCISE_FAILURE = Object.freeze({
  WINDOW_NOT_SCANNED: 'window-not-scanned',
  FIXTURE: 'fixture-failure',
  ATTRIBUTION: 'attribution-failure',
});

// Thrown by `classifyExercise` when handed an observation whose window was not scanned. A hard error
// rather than a returned outcome, because the whole defect this module was rewritten to remove is a
// verdict reached without the scan: if the scan did not happen there is nothing to classify, and a
// caller that swallowed this would be reintroducing the early return under a new name. The caller
// reports it as a setup failure — the check could not decide, which is not the same as the property
// being false (Property 9).
export class WindowNotScannedError extends Error {
  constructor(pathText, detail) {
    super(
      `PATH-EXERCISE-25: the Exercise_Log_Window for ${JSON.stringify(pathText)} was not scanned, ` +
        'so this exercise has no outcome. The window scan is what decides grant sufficiency — a ' +
        'status code decides nothing about the grant — so an unscanned window is a SETUP FAILURE, ' +
        `not a verdict (Property 9). ${detail}`,
    );
    this.name = 'WindowNotScannedError';
    this.isWindowNotScanned = true;
    this.path = pathText;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------------------------
// COLLECT. Issue the exercise and scan its window — unconditionally, both, every time.
//
// This function contains NO classification: it never compares a status, never consults the provider
// carve-out, and never decides anything. That is what makes the scan unskippable — there is no branch
// here that a status could take, and a future edit that wanted to skip the scan on a 5xx would have to
// add one, in a function whose whole documented purpose is that it does not have one.
//
// `ingress` is a makeIngressClient instance (the sole client a path-exercise check may use);
// `observation` is a makeObservationClient instance (the only client permitted to read a container's
// logs). `request` is the already-built ingress request — the recorded `Path_Payload` converted by
// `toIngressRequest` with the `Session_Fixture` attached by `attachSessionFixture`. `window` carries
// `{ since }`, the exercise's left edge, so the log read is scoped to this exercise rather than to the
// whole run.
//
// Returns the observation record every classification reads:
//   `{ path, surface, attributedTo, httpStatus, windowScanned, windowClean, authorizationError,
//      transportError, scanError }`
// ---------------------------------------------------------------------------------------------
export async function observeExercise({ ingress, observation, entry, request, window = {} }) {
  const { surface, path: pathText } = entry;

  let result = null;
  let transportError = null;
  try {
    result = await ingress.request(request);
  } catch (error) {
    // The request never completed. The window is STILL scanned below: a request that threw after the
    // handler ran (a socket closed on a long response, say) can perfectly well have left an
    // authorization error behind, and that evidence is what decides the grant.
    transportError = error?.message ?? String(error);
  }

  // The scan. Unconditional, no branch above it that can reach past it, and the only thing between it
  // and the request is the request's own failure being RECORDED rather than acted on.
  let logText = null;
  let scanError = null;
  try {
    const logResult = await observation.logs(AUTH_SURFACE_UPSTREAM, { since: window.since });
    logText = typeof logResult?.stdout === 'string' ? logResult.stdout : '';
    if (typeof logResult?.status === 'number' && logResult.status !== 0) {
      // A non-zero `docker compose logs` is not a clean window; it is no window at all.
      scanError =
        `docker compose logs exited ${logResult.status}: ` +
        `${(logResult.stderr ?? '').trim() || 'no stderr'}`;
      logText = null;
    }
  } catch (error) {
    scanError = error?.message ?? String(error);
  }

  const authorizationError = logText === null ? null : findAuthorizationError(logText);

  return Object.freeze({
    path: pathText,
    surface,
    attributedTo: result?.upstream ?? null,
    httpStatus: typeof result?.status === 'number' ? result.status : null,
    // The one field a classification may not proceed without.
    windowScanned: logText !== null,
    windowClean: logText !== null && authorizationError === null,
    authorizationError,
    transportError,
    scanError,
  });
}

// ---------------------------------------------------------------------------------------------
// DECIDE. Pure over an already-collected observation record.
//
// It holds no ingress client and no observation client, so there is nothing here that could issue a
// request or read a log — which means there is nothing here that could DECLINE to. The four outcomes
// and the two-plus-one non-outcomes are decided in one pass over the three observations, in the
// precedence the design fixes:
//
//   1. `understated` — an Authorization_Error in the window, AT ANY STATUS and whatever else is also
//      true of the exercise. It is the one positive observation in the set: something was actually
//      refused. It takes precedence over every other classification precisely so that no carve-out,
//      missing fixture or attribution anomaly can suppress a real refusal — each of those is
//      additionally named in the reason when it applies.
//   2. attribution failure — the proxy named no upstream, or named another one. The exercise never
//      reached the container under test, so it decided nothing (and 3.13 requires attribution).
//   3. fixture failure — a session-gated path with no `Session_Fixture`. The gate refused the request
//      ahead of the handler, so nothing was queried (Req 3.22, Property 6).
//   3b. fixture failure — a path NOT recorded as session-gated, exercised anonymously, that answers 401
//      over a clean window. The gate now refuses it, so the harness's session table has fallen behind
//      the application; the same clean-401 that 3.13 would pass, withheld and named (Req 3.23,
//      Property 6). 403 is excluded — it is the application's own configuration refusal, not the gate.
//   4. `undecided` — an `Unconfigured_Provider` path over a clean window. No strategy is registered, so
//      the request reaches no collection and the clean window carries no information (Req 3.19, 3.20).
//   5. `uncorroborated` — a 5xx over a clean window (Req 3.12).
//   6. `pass` — attributed, non-5xx, clean window (Req 3.13).
//
// Returns either `{ outcome: <the six recorded fields>, failure: null }` or
// `{ outcome: null, failure: { kind, path, reason } }`. THROWS `WindowNotScannedError` when the window
// was not scanned.
// ---------------------------------------------------------------------------------------------
export function classifyExercise({
  observation: obs,
  undecidedReason = null,
  fixtureFailure = null,
  // Whether the caller treats this path as session-gated under criterion 3.16 — i.e. its recorded
  // attachment is GATED and it belongs on SESSION_GATED_PATHS. It DEFAULTS TO TRUE on purpose: the
  // 3.23 case below is the only reader, and defaulting to `true` keeps that case from firing unless a
  // caller has positively established the path is NOT gated. So an observation classified with no
  // `sessionGated` argument decides exactly as it did before 3.23 (a clean 401 on such a path is the
  // route being served — a `pass`), and only `exerciseRoutedPath`, which knows the recorded
  // attachment, passes `sessionGated: false` to arm the 3.23 detection.
  sessionGated = true,
}) {
  if (obs === null || typeof obs !== 'object') {
    throw new TypeError(
      'classifyExercise requires the observation record observeExercise produced. It classifies an ' +
        'already-scanned exercise and deliberately cannot collect one itself.',
    );
  }
  if (obs.windowScanned !== true) {
    throw new WindowNotScannedError(
      obs.path,
      obs.scanError === null || obs.scanError === undefined
        ? 'No log window was supplied for this exercise.'
        : `The Auth_Surface log read failed: ${obs.scanError}`,
    );
  }

  const base = {
    path: obs.path,
    attributedTo: obs.attributedTo,
    // A transport failure leaves no status. Recorded as 0 rather than null so the artifact's
    // `httpStatus` stays an integer; the reason carries what actually happened.
    httpStatus: obs.httpStatus ?? 0,
    windowClean: obs.windowClean,
  };
  const misattributed = obs.attributedTo !== AUTH_SURFACE_UPSTREAM;

  // 1. An Authorization_Error in the window. At any status, and ahead of everything else.
  if (obs.authorizationError !== null) {
    const collection = collectionFromAuthorizationError(obs.authorizationError);
    const aside = [
      obs.httpStatus === null
        ? `The request itself did not complete (${obs.transportError}), which does not weaken the ` +
          'window: the refusal is recorded either way.'
        : `The status was ${obs.httpStatus}; a swallowed refusal that still answers is exactly the ` +
          'failure a status check alone would miss.',
      misattributed
        ? `The proxy attributed this request to ${JSON.stringify(obs.attributedTo)} rather than ` +
          `${AUTH_SURFACE_UPSTREAM}, which is a separate finding (see the attribution failure ` +
          'wording) — the refusal in the Auth_Surface window is reported regardless, because it is ' +
          'the one observation that supports the understatement claim.'
        : null,
      fixtureFailure === null
        ? null
        : 'This exercise ALSO carried no Session_Fixture on a session-gated path, so the reach it ' +
          'achieved is shallower than intended; the recorded refusal still stands.',
    ]
      .filter((part) => part !== null)
      .join(' ');
    return {
      outcome: {
        ...base,
        outcome: PATH_OUTCOME.UNDERSTATED,
        reason: `${recomputeGuidance(obs.surface, obs.path, {
          matchedLine: obs.authorizationError,
          collection,
        })} ${aside}`,
      },
      failure: null,
    };
  }

  // 2. Attribution. The exercise never reached the container whose grant is under test.
  if (misattributed) {
    const reason =
      obs.attributedTo === null
        ? `PATH-EXERCISE-25: ${obs.path} (${obs.surface}) came back with no ` +
          `${HARNESS_UPSTREAM_HEADER} response header, so the proxy attributed it to no upstream. ` +
          'That is an attribution failure, not evidence about either container: the exercise never ' +
          'reached the Auth_Surface, so it decided nothing about the Container_1_Grant and carries ' +
          `no recompute guidance. The window was scanned and was clean${
            obs.httpStatus === null ? `; the request did not complete (${obs.transportError})` : ''
          }.`
        : `PATH-EXERCISE-25: ${obs.path} (${obs.surface}) was attributed to ` +
          `${JSON.stringify(obs.attributedTo)}, not ${AUTH_SURFACE_UPSTREAM}. This path is routed ` +
          'elsewhere, so it is outside this check — the Auth_Surface_Allowlist and this routed-path ' +
          'list have drifted (Req 2.11: moving a path between the two routed sets is a ' +
          'Container_1_Grant recompute, which is not the same as this path understating its needs). ' +
          'No recompute guidance: nothing was refused.';
    return {
      outcome: null,
      failure: { kind: EXERCISE_FAILURE.ATTRIBUTION, path: obs.path, reason },
    };
  }

  // 3. The fixture failure (Req 3.22). Consumed from `decideSessionAttachment`, never re-derived here.
  if (fixtureFailure !== null) {
    return {
      outcome: null,
      failure: {
        kind: EXERCISE_FAILURE.FIXTURE,
        path: obs.path,
        reason:
          `${fixtureFailure.reason} The exercise returned ${obs.httpStatus ?? 'no status'} over a ` +
          'clean window, which is precisely the three observations criterion 3.13 would hand a pass ' +
          'to — and it is withheld, because the gate refused the request, the handler queried ' +
          'nothing, and the exercise decided nothing about the grant.',
      },
    };
  }

  // 3b. The 3.23 fixture failure. A path the recorded session table does NOT mark session-gated,
  //     exercised with no `Session_Fixture`, that answers 401 over a CLEAN window. That is the same
  //     three observations criterion 3.13 would hand a `pass` (attributed, non-5xx, clean) — but the
  //     401 is the gate refusing an anonymous request, so the handler queried nothing and the exercise
  //     decided nothing about the grant (Req 3.23, Property 6). The likely cause is named: the path now
  //     sits behind the authentication middleware and the harness's session table has not caught up.
  //
  //     It sits AFTER the Authorization_Error case (a refusal in the window is `understated` first,
  //     even at 401 — guaranteed here because `windowClean` implies none was found), AFTER the
  //     attribution case, and AFTER 3.22's `fixtureFailure` — a listed-but-unattached gated path is
  //     3.22's, so this only fires when `fixtureFailure` is null AND the caller established the path is
  //     not gated (`sessionGated === false`). 403 is deliberately excluded: among the exercised paths a
  //     403 is the application's own configuration refusal (registration/password reset disabled), not
  //     the auth gate. Only a 401 over a clean window arms it.
  if (
    fixtureFailure === null &&
    sessionGated === false &&
    obs.httpStatus === 401 &&
    obs.windowClean === true
  ) {
    return {
      outcome: null,
      failure: {
        kind: EXERCISE_FAILURE.FIXTURE,
        path: obs.path,
        reason:
          `FIXTURE FAILURE: ${obs.path} (${obs.surface}) is NOT recorded as session-gated, was ` +
          'exercised without a Session_Fixture, and returned 401 over a clean Exercise_Log_Window. ' +
          `The likely cause: the application now requires authentication on ${obs.path} — the path ` +
          'now sits behind the authentication middleware and the Harness\u2019s session table has ' +
          'not caught up, so the anonymous request was refused at the gate ahead of the handler and ' +
          'the handler queried no collection. That is the three observations criterion 3.13 grants a ' +
          'pass on (attributed, non-5xx, clean window) reached by an exercise that decided NOTHING ' +
          'about the Container_1_Grant, so the pass is WITHHELD (Req 3.23, Property 6). The cause is ' +
          '"likely" because a 401 alone cannot prove the gate answered — read the Auth_Surface log ' +
          'for this exercise. Record the Session_Fixture attachment for this path in ' +
          'path-exercise.payloads.mjs (mark it session-gated) so it is exercised with a session, or, ' +
          'if 401 is genuinely this anonymous path\u2019s expected answer, record it as such.',
      },
    };
  }

  // 4. The `Unconfigured_Provider` carve-out. Clean window by construction: no strategy is registered,
  //    so the request reaches no collection. Distinct from a pass and not a failure.
  if (typeof undecidedReason === 'string' && undecidedReason !== '') {
    return {
      outcome: {
        ...base,
        outcome: PATH_OUTCOME.UNDECIDED,
        reason:
          `${undecidedReason} The exercise returned ${obs.httpStatus ?? 'no status'} and its window ` +
          'was scanned and clean; neither observation decides grant sufficiency for this path, so no ' +
          'verdict is recorded in either direction.',
      },
      failure: null,
    };
  }

  // 5. A 5xx over a clean window — the `Uncorroborated_Server_Error`. NO recompute guidance.
  if (isServerError(obs.httpStatus)) {
    return {
      outcome: {
        ...base,
        outcome: PATH_OUTCOME.UNCORROBORATED,
        reason:
          `Uncorroborated_Server_Error: ${obs.path} (${obs.surface}) returned ${obs.httpStatus} and ` +
          'its Exercise_Log_Window records NO Authorization_Error. The check fails on it, and it is ' +
          'deliberately not a grant conclusion in either direction: nothing was refused, so the ' +
          'recompute guidance is withheld (Req 3.12). This is a real finding about the application ' +
          'or the harness configuration — read the Auth_Surface log for this exercise, compare the ' +
          "recorded Path_Payload's expected status, and note that a 502/503/504 additionally " +
          'implicates the proxy→upstream hop.',
      },
      failure: null,
    };
  }

  // 6. A status that is neither served nor a 5xx: no status at all. The request did not complete, so
  //    there is no exercise to classify — reported in the attribution family rather than as a verdict.
  if (!isUpstreamServed(obs.httpStatus)) {
    return {
      outcome: null,
      failure: {
        kind: EXERCISE_FAILURE.ATTRIBUTION,
        path: obs.path,
        reason:
          `PATH-EXERCISE-25: the request for ${obs.path} (${obs.surface}) returned no HTTP status ` +
          `at all (${obs.transportError ?? 'no transport error was recorded'}). The window was ` +
          'scanned and was clean, so nothing was refused; a request that never completed decided ' +
          'nothing about the grant and carries no recompute guidance.',
      },
    };
  }

  // 7. Attributed to the Auth_Surface, non-5xx, clean window (Req 3.13).
  return { outcome: { ...base, outcome: PATH_OUTCOME.PASS, reason: null }, failure: null };
}

// ---------------------------------------------------------------------------------------------
// Exercise one routed path end to end: build the request from its recorded payload, attach the
// `Session_Fixture` where the payload's table says to, collect the observation, and classify it.
//
// Everything is injected — the ingress client, the observation client, the payload entry, the fixture,
// the provider derivation — so the whole per-path decision is exercisable with fakes and no topology,
// and the live run (task 15) passes the real ones.
// ---------------------------------------------------------------------------------------------
// A `WindowNotScannedError` is CAUGHT here and returned as a recorded non-outcome, so one unscannable
// window does not abort the remaining exercises — the throw is the structural guard inside
// `classifyExercise`, and this is the one place permitted to convert it into a report. It is recorded
// as `unscanned`, which `summarizePathExercise` turns into the check-level `undecided-observation`
// verdict; it never becomes an outcome.
export async function exerciseRoutedPath({
  ingress,
  observation,
  entry,
  payload,
  fixture = null,
  undecidedReason = null,
  seededAccount = null,
  window = {},
  toRequest = toIngressRequest,
}) {
  if (payload === null || payload === undefined) {
    // A path exercised with nothing is the failure the `Path_Payload` fixture exists to end (Req 3.14).
    // It is a fixture defect rather than an outcome, so it is reported, never classified.
    return {
      observation: null,
      outcome: null,
      failure: {
        kind: EXERCISE_FAILURE.FIXTURE,
        path: entry.path,
        reason:
          `PATH-EXERCISE-25: ${entry.path} (${entry.surface}) has no recorded Path_Payload, so the ` +
          'exercise would be issued with nothing — an absent body tests a handler on MALFORMED ' +
          'input, and the unhandled throw that usually follows is a 5xx that says nothing about the ' +
          'grant (Req 3.14). Record a payload in path-exercise.payloads.mjs.',
      },
    };
  }

  const recorded = toRequest(payload, { seededAccount });
  const attached = attachSessionFixture(recorded, { entry: payload, fixture });
  const obs = await observeExercise({
    ingress,
    observation,
    entry,
    request: attached.request,
    window,
  });

  let decided;
  try {
    decided = classifyExercise({
      observation: obs,
      undecidedReason,
      fixtureFailure: attached.fixtureFailure,
      // "Session-gated under 3.16" is exactly the recorded GATED attachment (SESSION_GATED_PATHS
      // filters on it), so a path whose attachment is NONE (or the REFRESH_COOKIE early-return mount)
      // is NOT gated — which is what arms the 3.23 clean-401 detection. A GATED path unattached is
      // already 3.22's `fixtureFailure`, handled ahead of 3.23; a GATED path that WAS attached and
      // still 401s is left to the existing outcomes.
      sessionGated: attached.attachment === SESSION_ATTACHMENT.GATED,
    });
  } catch (error) {
    if (error?.isWindowNotScanned !== true) {
      throw error;
    }
    return {
      observation: obs,
      outcome: null,
      failure: null,
      unscanned: error.message,
      attachment: attached.attachment,
      expectedStatus: payload.expectedStatus,
    };
  }

  return {
    observation: obs,
    outcome: decided.outcome,
    failure: decided.failure,
    attachment: attached.attachment,
    expectedStatus: payload.expectedStatus,
  };
}

// ---------------------------------------------------------------------------------------------
// The check's own status, which is NOT "worst outcome wins".
//
// It fails on any `understated` or any `uncorroborated`, and on any exercise that produced no outcome
// at all (an attribution failure, a fixture failure). It passes only when every path is `pass` or
// `undecided` AND AT LEAST ONE PATH IS `pass` — an all-`undecided` list is not a pass, for the same
// reason a run of nothing but `skip` records exits non-zero (serializer.mjs: the `nothingExecuted`
// clause).
//
// A third verdict, `undecided-observation`, is returned when any window could not be scanned. The
// caller raises it through undecided.mjs's signal so the record is a `skip` that BLOCKS exit 0: the
// check ran, reached for its deciding observation and found it unusable, which is neither a pass
// (nothing was observed) nor a fail (nothing was falsified) — Property 9 at check level. That is a
// different thing from a per-path `undecided`, which narrows ONE path while the others still decide
// theirs and which must never be reported through that signal (path-exercise.providers.mjs: "This
// `undecided` is not undecided.mjs's").
// ---------------------------------------------------------------------------------------------
export function summarizePathExercise(decisions, { notes = [] } = {}) {
  const pathOutcomes = decisions
    .map((decision) => decision.outcome)
    .filter((outcome) => outcome !== null && outcome !== undefined);
  const failures = decisions
    .map((decision) => decision.failure)
    .filter((failure) => failure !== null && failure !== undefined);
  const unscanned = decisions.filter((decision) => decision.unscanned !== undefined);
  const tally = tallyPathOutcomes(pathOutcomes);

  const failingOutcomes = pathOutcomes.filter((outcome) =>
    FAILING_PATH_OUTCOMES.includes(outcome.outcome),
  );
  const decided = pathOutcomes.length + failures.length + unscanned.length;

  const verdict = (() => {
    if (unscanned.length > 0) {
      return 'undecided-observation';
    }
    if (failingOutcomes.length > 0 || failures.length > 0) {
      return 'fail';
    }
    if (tally[PATH_OUTCOME.PASS] === 0) {
      return 'fail';
    }
    return 'pass';
  })();

  const lines = [];
  if (verdict === 'undecided-observation') {
    lines.push(
      `PATH-EXERCISE-25 could not decide: ${unscanned.length} of ${decided} exercises had no ` +
        'Exercise_Log_Window to scan. The scan is what decides grant sufficiency, so an unscanned ' +
        'window is a setup failure rather than a verdict (Property 9).',
    );
    for (const entry of unscanned) {
      lines.push(`  - ${entry.unscanned}`);
    }
  } else if (verdict === 'fail') {
    if (failingOutcomes.length === 0 && failures.length === 0) {
      lines.push(
        `PATH-EXERCISE-25 fails: no exercise passed. ${tally[PATH_OUTCOME.UNDECIDED]} of ` +
          `${pathOutcomes.length} paths came back \`undecided\` and none came back \`pass\`, so the ` +
          'bounded-below half of Property 2 was not exercised anywhere. An all-`undecided` list is ' +
          'not a pass, for the same reason a run of nothing but `skip` records exits non-zero — ' +
          'configure at least one provider, or fix whatever narrowed every path.',
      );
    } else {
      lines.push(
        `PATH-EXERCISE-25 fails: ${tally[PATH_OUTCOME.UNDERSTATED]} understated, ` +
          `${tally[PATH_OUTCOME.UNCORROBORATED]} uncorroborated, ${failures.length} exercise(s) ` +
          `with no outcome, ${tally[PATH_OUTCOME.PASS]} pass, ${tally[PATH_OUTCOME.UNDECIDED]} ` +
          'undecided.',
      );
    }
  } else {
    lines.push(
      `PATH-EXERCISE-25 passes: ${tally[PATH_OUTCOME.PASS]} of ${pathOutcomes.length} routed paths ` +
        `completed over a clean Exercise_Log_Window, and ${tally[PATH_OUTCOME.UNDECIDED]} are ` +
        '`undecided` (an Unconfigured_Provider reaches no collection, so its clean window decides ' +
        'nothing about the grant in either direction).',
    );
  }

  // Every path, with its outcome and its reason, so `undecided` reads as the narrowed scope it is
  // rather than disappearing into an aggregate green.
  for (const outcome of pathOutcomes) {
    lines.push(
      `  ${outcome.outcome.padEnd(14)} ${outcome.path} (status ${outcome.httpStatus}; window ` +
        `${outcome.windowClean ? 'clean' : 'AUTHORIZATION ERROR'})`,
    );
    if (outcome.reason !== null && outcome.reason !== undefined) {
      lines.push(`      ${outcome.reason}`);
    }
  }
  for (const failure of failures) {
    lines.push(`  ${failure.kind.padEnd(14)} ${failure.path}`);
    lines.push(`      ${failure.reason}`);
  }
  for (const note of notes) {
    lines.push(`  note: ${note}`);
  }

  return Object.freeze({
    verdict,
    pathOutcomes: Object.freeze(pathOutcomes),
    failures: Object.freeze(failures),
    tally,
    observation: lines.join('\n'),
  });
}
