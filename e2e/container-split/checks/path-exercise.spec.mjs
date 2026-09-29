// checks/path-exercise.spec.mjs — PATH-EXERCISE-25 (task 11.1).
//
// Property 2, bounded-below half: the Auth_Surface's grant is *sufficient*, not merely *narrow*.
// For every path routed to the Auth_Surface, exercising that path through the Front_Proxy ingress
// completes with no authorization error. This is the half of Property 2 that is new — the grant's
// action vocabulary was narrowed to the DocumentDB-portable intersection (`find` on reads;
// `insert, update, remove, createIndex` on writes; `createCollection` granted nowhere), and nothing
// had run the application under that narrowed grant before this harness. Sufficiency was assumed,
// not observed (design.md: "The bounded-below half is the one that is new").
//
// == What "exercise" means here: ONE window scan, four outcomes ==
// Each routed path is one Caddyfile.split allowlist entry that resolves to the auth-surface upstream.
// Exercising it means issuing its recorded `Path_Payload` THROUGH THE INGRESS CLIENT — the sole client
// any path-exercise check may use (run.mjs: makeIngressClient, baked to the Front_Proxy's address,
// reads X-Harness-Upstream for attribution) — with the `Session_Fixture` attached wherever the payload
// table says the mount is session-gated, and then SCANNING THAT EXERCISE'S `Exercise_Log_Window`
// WHATEVER STATUS IT RETURNED. The scan is what decides grant sufficiency; the status only classifies
// the exercise. Three observations are available per exercise — the container the proxy attributed the
// request to, the status, and whether the window recorded an Authorization_Error — and they yield four
// outcomes:
//
//   * `understated`    — an Authorization_Error in the window, AT ANY STATUS. The check fails, naming
//                        the matched log line and the collection in it, with the recompute guidance
//                        (Req 3.4). This is the only outcome that carries that guidance.
//   * `uncorroborated` — a 5xx over a clean window: an `Uncorroborated_Server_Error` carrying the path
//                        and the status. The check fails, and the recompute guidance is WITHHELD —
//                        nothing was refused, so it is not a grant conclusion in either direction
//                        (Req 3.12).
//   * `pass`           — attributed to the Auth_Surface, non-5xx, clean window (Req 3.13).
//   * `undecided`      — an `Unconfigured_Provider` path, naming the provider. Distinct from a pass,
//                        not a failure, and it does not satisfy the "at least one pass" clause
//                        (Req 3.19, 3.20).
//
// Two observations are NOT outcomes. A window that was not scanned is a setup failure, not a verdict
// (Property 9). A session-gated path exercised with no `Session_Fixture` is a fixture failure carrying
// the path and the unattached fixture — never the `pass` that 3.13's non-5xx wording would otherwise
// hand it, because the gate refused the request, the handler queried nothing, and the exercise decided
// nothing about the grant (Req 3.22, Property 6).
//
// == Why the rule is stated as one scan rather than as a better gate order ==
// The shipped implementation applied three gates in sequence — attribution, a non-5xx status
// assertion, then the window scan — and returned at gate 2. Eight of twenty-six paths failed at gate 2
// on the live run and were reported under gate 3's meaning, *the ownership matrix understates this
// path's collection needs*: a claim about the grant drawn from a status code, with the corroborating
// scan never run. Criterion 3.4 had always named the Authorization_Error as the trigger, so the
// criterion was never weak — the gate order put the sound evidence one step past the early return. Any
// SEQUENCE can be re-broken by inserting a cheaper check ahead of the deciding one, and there is no
// ordering of gates in which a 5xx short-circuit is harmless, so path-exercise.filter.mjs splits
// COLLECTION (`observeExercise`, which always requests and always scans and classifies nothing) from
// DECISION (`classifyExercise`, which holds no client and refuses to classify an unscanned window).
// The negative-control tests below are what keep the early return out: a 5xx WITH an authorization
// error must classify `understated`, and the scan must be issued on every exercise whatever the status.
//
// == The check's own status is not "worst outcome wins" ==
// It fails on any `understated` or any `uncorroborated`, and on any exercise that produced no outcome.
// It passes only when every path is `pass` or `undecided` AND at least one path is `pass` — an
// all-`undecided` list is not a pass, for the same reason a run of nothing but `skip` records exits
// non-zero. Every path is reported with its outcome and its reason, in the check record's
// `pathOutcomes` field (path-outcomes.mjs), so `undecided` reads as the narrowed scope it is rather
// than disappearing into an aggregate green. The check-level `status` vocabulary stays
// `pass | fail | skip`, so the catalog-derived report and the exit-0 gate are untouched.
//
// == Why this loads now but exercises at task 15 ==
// The live topology exists only once run.mjs brings it up with Docker (task 15). Until then there is
// no ingress to reach and no Auth_Surface log to read, so the live check is NOT REGISTERED and the
// reporter derives PATH-EXERCISE-25's `skip` record from the catalog (task 14.7) — the file loads, is
// structurally valid, and `jest --listTests` discovers it, without standing anything up. Task 15
// populates the harness context (globalThis.__CONTAINER_SPLIT_HARNESS__: the ingress client whose fetch
// reaches the live proxy, the observation client whose exec reads live logs, the boot-window edges and
// the Seeded_Account) before invoking Jest, at which point the live check runs against the split
// topology. The decision rule, the ordering, the summary and the record shape are all authored and
// exercised here over fakes; only the live fetch and log exec are deferred.
//
// NG1/NG2/NG6 hold: this exercises the existing image through a commodity proxy and reads a proxy-set
// header and container logs. It adds no application code, no route mount and no HTTP path (NG1), edits
// neither container-split script (NG2), and performs no credential validation of any kind — the proxy
// does not emulate the Auth_Gate, so the request reaching the route is all this half decides (NG6).

// Read only by the committed-template tripwire at the bottom of this file (task 11.6), which checks
// the premise the Unconfigured_Provider carve-out rests on: the harness's own env templates configure
// no social provider. The live derivation reads the compose-resolved environment instead.
import { readFile } from 'node:fs/promises';

import { makeIngressClient, makeObservationClient } from '../run.mjs';
// The per-path outcome vocabulary and the channel that carries it onto the check record (task 11.1).
// The four outcomes live here rather than in the check-level `status`, which stays pass|fail|skip.
import {
  PATH_OUTCOME,
  pathOutcomesProblems,
  publishPathOutcomes,
  tallyPathOutcomes,
} from '../path-outcomes.mjs';
// A window that could not be scanned is a SETUP FAILURE, not a verdict (Property 9). The check says so
// through the undecided signal, which the reporter records as a `skip` that blocks exit 0 — the check
// ran, reached for its deciding observation and found it unusable. This is NOT the per-path `undecided`
// outcome, which narrows one path while the others still decide theirs.
import { UndecidedObservation } from '../undecided.mjs';
import { SKIP_REASON } from '../serializer.mjs';
// The exported constants and pure deciders live in path-exercise.filter.mjs (a non-spec sibling) so this
// spec file exports nothing (task 14.6). The spec imports what its checks exercise.
import {
  CHECK_ID,
  AUTH_SURFACE_UPSTREAM,
  AUTH_SURFACE_ROUTED_PATHS,
  DEFERRED_EXERCISE_ORDER,
  EXERCISE_FAILURE,
  WindowNotScannedError,
  classifyExercise,
  collectionFromAuthorizationError,
  exerciseRoutedPath,
  findAuthorizationError,
  isServerError,
  isUpstreamServed,
  observeExercise,
  orderedRoutedPaths,
  summarizePathExercise,
} from './path-exercise.filter.mjs';
// The recorded Path_Payload set — one request per exercised routed path, with its expected status and
// one sentence of why that status is the application's own answer (task 11.4). Also a non-spec
// sibling, for the same reason as the filter module.
import {
  PATH_PAYLOADS,
  SESSION_ATTACHMENT,
  SESSION_GATED_PATHS,
  SESSION_ATTACHED_PATHS,
  PAYLOAD_FINDINGS,
  SEED_PLACEHOLDERS,
  assertPayloadCoverage,
  payloadFor,
  resolveSeedPlaceholders,
  toIngressRequest,
} from './path-exercise.payloads.mjs';
// The Session_Fixture (task 11.5) — the application session minted for the Seeded_Account through the
// ingress and attached to every session-gated exercise, plus the Req 3.22 fixture-failure signal task
// 11.1's rule consumes. A fourth non-spec sibling, for the same reason as the others.
import {
  LOGIN_PATH,
  REFRESH_COOKIE_NAME,
  TOKEN_PROVIDER_COOKIE_NAME,
  SessionFixtureError,
  attachSessionFixture,
  awaitBootWindowClosed,
  cookieHeaderFrom,
  decideSessionAttachment,
  mintSessionFixture,
  msUntilBootWindowClosed,
  parseSetCookieJar,
  sessionHeadersFor,
} from './path-exercise.session.mjs';
// The boot window's 60-second tail — the same number BOOT-NOWRITE-23 counts over, read from its own
// module so the session mint's ordering rule and the check cannot disagree.
import { BOOT_WINDOW_TAIL_MS } from './boot-nowrite.filter.mjs';
// The Unconfigured_Provider derivation (task 11.6) — which `/oauth/<provider>` paths cannot decide
// grant sufficiency, computed from the harness's own RESOLVED provider configuration rather than from
// a hard-coded path list (Req 3.21). A third non-spec sibling, for the same reason as the two above.
import {
  SOCIAL_LOGIN_ENABLEMENT_FLAG,
  deriveProviderConfiguration,
  findStaleProviderPayloads,
  isUndecidedPath,
  providerFromRoutedPath,
  resolveProviderConfiguration,
  socialProviderCandidates,
  undecidedReasonFor,
} from './path-exercise.providers.mjs';

// Read the harness context task 15's runner populates before invoking Jest. It carries the live
// ingress client (fetch reaching the running Front_Proxy), the live observation client (exec reading
// running-container logs), and the exercise window. When it is absent — a plain `jest`/`--listTests`
// invocation with no topology up — the request-issuing checks self-skip with a reason the reporter
// encodes, so the file is structurally valid and discoverable without standing anything up.
function harnessContext() {
  const ctx = globalThis.__CONTAINER_SPLIT_HARNESS__;
  if (!ctx || typeof ctx !== 'object') {
    return null;
  }
  // Accept either ready-made clients or the primitives to build them, so task 15 can hand either.
  const ingress =
    ctx.ingress ??
    (typeof ctx.fetch === 'function' ? makeIngressClient({ fetch: ctx.fetch }) : null);
  const observation =
    ctx.observation ??
    (typeof ctx.exec === 'function'
      ? makeObservationClient({ fetch: ctx.fetch ?? globalThis.fetch, exec: ctx.exec })
      : null);
  if (!ingress || !observation) {
    return null;
  }
  // Forward EVERY field the check body consumes, not just the two clients. The bridge
  // (jest.setup.mjs) and the producer (run.mjs assembleContextPrimitives) publish `seededAccount`
  // and `readyAtMs` at the top level of the context; the check reads `ctx.seededAccount` (to mint the
  // Session_Fixture and to resolve SEED_PLACEHOLDERS) and `ctx.readyAtMs` (to wait out the boot
  // window before the login mint). A projection that returned only ingress/observation/window
  // dropped both — `mintSessionFixture` then threw a SessionFixtureError on the falsy account, so
  // PATH-EXERCISE-25 reported a fixture failure instead of a real per-path verdict.
  //
  // The two MUST travel together. `msUntilBootWindowClosed` treats a non-number `readyAtMs` as zero
  // wait, so forwarding `seededAccount` without `readyAtMs` would let the login mint proceed INSIDE
  // the boot window — putting legitimate Model.createIndexes() writes on
  // sessions/refreshtokenbridges/openidrefreshflights into the window BOOT-NOWRITE-23 asserts is
  // empty, turning a loud fixture failure into a wrong verdict on a currently-passing check.
  return {
    ingress,
    observation,
    window: ctx.window ?? {},
    seededAccount: ctx.seededAccount ?? null,
    readyAtMs: ctx.readyAtMs ?? null,
  };
}

// The left edge of ONE exercise's `Exercise_Log_Window`. Scoped per exercise rather than to the whole
// run, so the line the scan matches belongs to the request that just went out. `docker compose logs
// --since` takes an RFC3339 timestamp and is a lower bound, so the two-second backstop absorbs host and
// daemon clock granularity without widening the window into a neighbouring exercise (the exercises are
// serial — jest.config.mjs pins maxWorkers: 1 for exactly this class of shared-fixture read).
const EXERCISE_WINDOW_BACKSTOP_MS = 2_000;

function exerciseWindow() {
  return { since: new Date(Date.now() - EXERCISE_WINDOW_BACKSTOP_MS).toISOString() };
}

// Register the live path exercise ONLY when the topology is present. Absent it (a plain
// `jest`/`--listTests` invocation), no live `it` is registered — the reporter derives PATH-EXERCISE-25's
// `skip` record from the catalog (task 14.7). A literal `it` callee inside the `if (pathExerciseCtx)`
// guard is what lets eslint's jest plugin recognize the test block.
//
// ONE `it` covers every path, deliberately. The check's status is not "worst outcome wins" — it turns on
// the whole list ("every path is `pass` or `undecided` AND at least one is `pass`"), and an
// all-`undecided` list must not read as green. Per-path `it`s cannot express that: an `undecided` path
// passes its own `it`, so twenty-six green `it`s would hand the check a pass on a list that decided
// nothing. So the list is decided once, and every path is reported — in `pathOutcomes` on the record and
// in the observation prose — rather than in the pass/fail of twenty-six tests.
const pathExerciseCtx = harnessContext();
if (pathExerciseCtx) {
  describe(`${CHECK_ID}: every routed path exercised, its window scanned whatever status returned`, () => {
    const ctx = pathExerciseCtx;

    // The title starts with a LITERAL `[PATH-EXERCISE-25]` tag (not the `${CHECK_ID}` interpolation) so
    // jest/valid-title can read the leading string and reporter.mjs's parseCheckId regex still matches.
    it('[PATH-EXERCISE-25] every routed path is exercised with its Path_Payload and its Exercise_Log_Window is scanned whatever status it returned', async () => {
      // The carve-out, derived from the RESOLVED provider configuration the containers run under, never
      // from a path list (Req 3.21). A provider the harness configures is exercised in full with no
      // second edit here.
      const providers = await resolveProviderConfiguration();
      // One session, minted once and reused across every session-gated exercise — one session is all
      // the decision rule needs. It throws loudly rather than leaving an anonymous client behind.
      const fixture = await mintSessionFixture({
        ingress: ctx.ingress,
        seededAccount: ctx.seededAccount,
        readyAtMs: ctx.readyAtMs,
      });

      const decisions = [];
      for (const entry of orderedRoutedPaths()) {
        decisions.push(
          // Awaited in the loop deliberately: the exercises are serial because each scans its own log
          // window, and a parallel burst would put one exercise's lines inside another's window.
          await exerciseRoutedPath({
            ingress: ctx.ingress,
            observation: ctx.observation,
            entry,
            payload: payloadFor(entry.path),
            fixture,
            undecidedReason: isUndecidedPath(providers, entry.path)
              ? undecidedReasonFor(providers, entry.path)
              : null,
            seededAccount: ctx.seededAccount,
            window: exerciseWindow(),
          }),
        );
      }

      // Recorded findings that narrow what the run means without changing a verdict: the payload
      // findings (F1/F2), a provider whose recorded status went stale, an `/oauth/<p>` path with no
      // recorded gate, and any exercise whose observed status is not the one the payload recorded —
      // the third payload field exists so a status change has to be justified where it is recorded
      // rather than absorbed as a passing diff.
      const notes = [
        ...PAYLOAD_FINDINGS.map((finding) => `${finding.routedPath}: ${finding.finding}`),
        ...findStaleProviderPayloads(providers, PATH_PAYLOADS).map((stale) => stale.detail),
        ...providers.unknown.map((unknown) => unknown.reason),
        ...decisions
          .filter(
            (decision) =>
              decision.observation !== null &&
              decision.observation.httpStatus !== null &&
              decision.observation.httpStatus !== decision.expectedStatus,
          )
          .map(
            (decision) =>
              `${decision.observation.path} answered ${decision.observation.httpStatus}, not the ` +
              `recorded ${decision.expectedStatus}. The recorded status is the application's own ` +
              'answer at the harness env; a difference is a finding to justify where it is recorded ' +
              '(path-exercise.payloads.mjs), not a verdict on the grant.',
          ),
      ];

      const summary = summarizePathExercise(decisions, { notes });

      // The outcomes reach the check record through the sidecar the reporter consumes, on a pass as well
      // as on a fail: a passing check whose provider paths were all `undecided` is exactly the case that
      // must stay legible in the artifact.
      await publishPathOutcomes(CHECK_ID, summary.pathOutcomes);

      if (summary.verdict === 'undecided-observation') {
        // The check RAN and found its deciding observation unusable. Not a pass (nothing was observed)
        // and not a fail (nothing was falsified) — recorded as a skip that blocks exit 0.
        throw new UndecidedObservation(SKIP_REASON.OBSERVATION_UNUSABLE, summary.observation);
      }
      if (summary.verdict === 'fail') {
        throw new Error(summary.observation);
      }
      expect(summary.verdict).toBe('pass');
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Static, no-topology assertions — so this file is not vacuous while the live exercises are deferred
// to task 15. These decide nothing about a running container; they exercise the pure per-path decision
// (attribution, sensible status, clean log window) over synthetic ingress/observation clients and lock
// the invariants the live checks depend on, so a change that would silently break the deferred reads
// fails now instead. They carry no `[CHECK-ID]` tag, so the reporter treats them as helper tests; when
// the live exercises do not run, PATH-EXERCISE-25 is recorded as a derived skip by the reporter.
// ---------------------------------------------------------------------------------------------
describe('routed-path exercise decision rule (pure)', () => {
  // A fake ingress keyed by path -> the result the proxy would produce (upstream + status). A path not
  // mapped resolves to no upstream, which is the attribution-failure case. Every request is recorded so
  // a test can assert what was sent.
  const fakeIngress = (byPath) => {
    const requests = [];
    return {
      requests,
      async request(options) {
        requests.push(options);
        const result = byPath[options.path];
        return result ?? { status: 200, upstream: null, headers: new Map() };
      },
    };
  };
  // A fake observation whose `logs` returns scripted text for the auth-surface container. Every call is
  // recorded, which is what the negative control below asserts on: the scan must be issued on EVERY
  // exercise, whatever status the request returned.
  const fakeObservation = (stdout = '', { status = 0, throws = null } = {}) => {
    const calls = [];
    return {
      calls,
      async logs(container, options) {
        calls.push({ container, options });
        if (throws !== null) {
          throw new Error(throws);
        }
        return { status, stdout, stderr: status === 0 ? '' : 'no such service' };
      },
    };
  };

  const CONFIG = { surface: 'config', path: '/api/config', method: 'GET' };
  const REFUSAL_LINE =
    'error: MongoServerError: not authorized on LibreChat to execute command ' +
    '{ find: "keys", filter: {} }';

  // One observation record, of the shape observeExercise produces, for the pure classification tests.
  const observed = (overrides = {}) =>
    Object.freeze({
      path: '/api/config',
      surface: 'config',
      attributedTo: AUTH_SURFACE_UPSTREAM,
      httpStatus: 200,
      windowScanned: true,
      windowClean: true,
      authorizationError: null,
      transportError: null,
      scanError: null,
      ...overrides,
    });

  const exercise = ({ path = '/api/config', entry = CONFIG, ...rest }) =>
    exerciseRoutedPath({
      entry,
      payload: payloadFor(path),
      seededAccount: {
        email: 'seed@container-split.invalid',
        password: 'HarnessSeededAccount1',
        id: '0123456789abcdef01234567',
      },
      ...rest,
    });

  test('the status classifies and never decides: served is 1xx–4xx, a server error is 5xx', () => {
    expect(isUpstreamServed(200)).toBe(true);
    expect(isUpstreamServed(401)).toBe(true);
    expect(isUpstreamServed(422)).toBe(true);
    expect(isUpstreamServed(500)).toBe(false);
    expect(isServerError(500)).toBe(true);
    expect(isServerError(502)).toBe(true);
    expect(isServerError(504)).toBe(true);
    expect(isServerError(429)).toBe(false);
    // No status at all is neither: a request that did not complete is not an exercise to classify.
    expect(isUpstreamServed(null)).toBe(false);
    expect(isServerError(null)).toBe(false);
  });

  test('findAuthorizationError detects a mongod refusal and a caught code-13, and names the collection', () => {
    expect(findAuthorizationError(REFUSAL_LINE)).toMatch(/not authorized/);
    expect(findAuthorizationError('warn: MongoServerError { code: 13 }')).not.toBeNull();
    expect(findAuthorizationError('info: Server listening on port 3080')).toBeNull();
    expect(findAuthorizationError('')).toBeNull();
    // Criterion 3.4 asks the failure to name the matched line AND the collection in it, because the
    // collection is what a recompute edits.
    expect(collectionFromAuthorizationError(REFUSAL_LINE)).toBe('keys');
    expect(collectionFromAuthorizationError('not authorized on LibreChat')).toBeNull();
  });

  // -----------------------------------------------------------------------------------------------
  // NEGATIVE CONTROL 1 — the gate-2 early return. If a non-5xx status assertion ever stands in front
  // of the window scan again, this test goes red: the shipped implementation returned at gate 2, so a
  // 5xx never reached the scan and was reported under gate 3's meaning.
  // -----------------------------------------------------------------------------------------------
  test('a 5xx WITH an authorization error in the window is `understated`, never `uncorroborated`', async () => {
    const decided = classifyExercise({
      observation: observed({
        httpStatus: 500,
        windowClean: false,
        authorizationError: REFUSAL_LINE,
      }),
    });

    expect(decided.outcome.outcome).toBe(PATH_OUTCOME.UNDERSTATED);
    expect(decided.outcome.httpStatus).toBe(500);
    expect(decided.outcome.windowClean).toBe(false);
    // The matched line, the collection in it, and the recompute guidance (Req 3.4).
    expect(decided.outcome.reason).toContain('keys');
    expect(decided.outcome.reason).toContain('not authorized on LibreChat');
    expect(decided.outcome.reason).toMatch(/Recompute the Container_1_Grant/);
    expect(decided.outcome.reason).not.toMatch(/Uncorroborated_Server_Error/);

    // And end to end, through the orchestrator, with the log read scripted to carry the refusal.
    const observation = fakeObservation(REFUSAL_LINE);
    const end = await exercise({
      ingress: fakeIngress({ '/api/config': { status: 500, upstream: AUTH_SURFACE_UPSTREAM } }),
      observation,
    });
    expect(end.outcome.outcome).toBe(PATH_OUTCOME.UNDERSTATED);
    expect(observation.calls).toHaveLength(1);
  });

  // -----------------------------------------------------------------------------------------------
  // NEGATIVE CONTROL 2 — the scan is issued on EVERY exercise, whatever the status. A cheaper check
  // standing in front of it would show up here as a missing log read.
  // -----------------------------------------------------------------------------------------------
  test('the Exercise_Log_Window is scanned on every exercise, whatever status it returned', async () => {
    const statuses = [200, 302, 401, 403, 429, 500, 502, 504];
    const scans = [];
    for (const status of statuses) {
      const observation = fakeObservation('info: nothing of note');
      // One scripted exercise per status, in order — awaited in the loop on purpose.
      await exercise({
        ingress: fakeIngress({ '/api/config': { status, upstream: AUTH_SURFACE_UPSTREAM } }),
        observation,
        window: { since: '2024-01-01T00:00:00.000Z' },
      });
      scans.push({ status, scans: observation.calls.length });
    }
    // Collected and asserted as one list so a failure names WHICH status skipped the scan.
    expect(scans).toEqual(statuses.map((status) => ({ status, scans: 1 })));
    // And the scan reads the Auth_Surface's logs, scoped to this exercise's window.
    const observation = fakeObservation('');
    await exercise({
      ingress: fakeIngress({ '/api/config': { status: 500, upstream: AUTH_SURFACE_UPSTREAM } }),
      observation,
      window: { since: '2024-01-01T00:00:00.000Z' },
    });
    expect(observation.calls[0].container).toBe(AUTH_SURFACE_UPSTREAM);
    expect(observation.calls[0].options.since).toBe('2024-01-01T00:00:00.000Z');
  });

  // -----------------------------------------------------------------------------------------------
  // NEGATIVE CONTROL 3 — the decider holds no client, so it cannot skip the scan. Asserted against the
  // module's source, the way the Session_Fixture's NG6 guard is: the needles live here rather than in
  // the module, where they would match themselves.
  // -----------------------------------------------------------------------------------------------
  test('classifyExercise collects nothing — no request and no log read inside the decider', async () => {
    const source = await readFile(new URL('./path-exercise.filter.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('export function classifyExercise');
    const end = source.indexOf('export async function exerciseRoutedPath');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const decider = source.slice(start, end);
    // The two calls that must never appear in the deciding function. Their absence is what makes "one
    // scan with classifications" structural rather than a convention: there is no sequence of gates
    // here for a cheaper check to be inserted into.
    expect(
      ['ingress.request', 'observation.logs', 'await '].filter((needle) =>
        decider.includes(needle),
      ),
    ).toEqual([]);
  });

  test('an unscanned window is a setup failure, not any of the four outcomes (Property 9)', () => {
    // The decider REFUSES to classify it. A caller that swallowed this would be reintroducing the early
    // return under a new name, so it is a throw rather than a returned verdict.
    expect(() => classifyExercise({ observation: observed({ windowScanned: false }) })).toThrow(
      WindowNotScannedError,
    );
    expect(() =>
      classifyExercise({
        observation: observed({ windowScanned: false, scanError: 'docker compose logs exited 1' }),
      }),
    ).toThrow(/SETUP FAILURE/);
    // Even with a 200 and an otherwise perfect exercise: no scan, no outcome.
    expect(() =>
      classifyExercise({ observation: observed({ httpStatus: 200, windowScanned: false }) }),
    ).toThrow(/not scanned/);
  });

  test('a log read that fails makes the check undecided, never a pass', async () => {
    const decision = await exercise({
      ingress: fakeIngress({ '/api/config': { status: 200, upstream: AUTH_SURFACE_UPSTREAM } }),
      observation: fakeObservation('', { throws: 'no such service: auth-surface' }),
    });
    // Recorded rather than thrown, so one unscannable window does not abort the remaining exercises.
    expect(decision.outcome).toBeNull();
    expect(decision.unscanned).toMatch(/no such service/);
    // And the check-level verdict is `undecided-observation` — the signal the spec raises as a skip that
    // blocks exit 0, which is neither a pass (nothing observed) nor a fail (nothing falsified).
    const summary = summarizePathExercise([decision]);
    expect(summary.verdict).toBe('undecided-observation');
    expect(summary.pathOutcomes).toEqual([]);
    // A non-zero `docker compose logs` is no window either, not a clean one.
    const nonZero = await exercise({
      ingress: fakeIngress({ '/api/config': { status: 200, upstream: AUTH_SURFACE_UPSTREAM } }),
      observation: fakeObservation('', { status: 1 }),
    });
    expect(nonZero.unscanned).toMatch(/not scanned/);
  });

  test('a 5xx over a CLEAN window is `uncorroborated` and withholds the recompute guidance', async () => {
    const decision = await exercise({
      ingress: fakeIngress({ '/api/config': { status: 503, upstream: AUTH_SURFACE_UPSTREAM } }),
      observation: fakeObservation('info: nothing of note'),
    });

    expect(decision.outcome.outcome).toBe(PATH_OUTCOME.UNCORROBORATED);
    expect(decision.outcome.httpStatus).toBe(503);
    expect(decision.outcome.windowClean).toBe(true);
    expect(decision.outcome.reason).toMatch(/Uncorroborated_Server_Error/);
    expect(decision.outcome.reason).toContain('503');
    // Nothing was refused, so this is not a grant conclusion in either direction (Req 3.12). The
    // guidance's absence is the whole point of the outcome.
    expect(decision.outcome.reason).not.toMatch(/Recompute the Container_1_Grant/);
    expect(decision.outcome.reason).not.toMatch(/UNDERSTATES/);
  });

  test('attributed, non-5xx, clean window is a pass — including a 4xx, which is the route being served', async () => {
    for (const status of [200, 401, 403, 422]) {
      const decided = classifyExercise({ observation: observed({ httpStatus: status }) });
      expect(decided.outcome.outcome).toBe(PATH_OUTCOME.PASS);
      // A pass is the one outcome that may omit its reason: the check id and the property say what held.
      expect(decided.outcome.reason).toBeNull();
      expect(decided.failure).toBeNull();
    }
  });

  test('an Unconfigured_Provider path is `undecided`, and an authorization error on it is still `understated`', () => {
    const reason =
      'Unconfigured_Provider `google`: grant sufficiency is UNDECIDED for /oauth/google.';
    const undecided = classifyExercise({
      observation: observed({ path: '/oauth/google', surface: 'social: google', httpStatus: 500 }),
      undecidedReason: reason,
    });
    // Not a pass and not a failure: the request reaches no collection, so its clean window carries no
    // information about the grant in either direction (Req 3.19, 3.20). Note the 500 does NOT make it
    // `uncorroborated` — the carve-out is what that status means here.
    expect(undecided.outcome.outcome).toBe(PATH_OUTCOME.UNDECIDED);
    expect(undecided.outcome.reason).toContain('google');
    expect(undecided.outcome.reason).not.toMatch(/Recompute the Container_1_Grant/);

    // But the carve-out cannot suppress a real refusal: an Authorization_Error in the window is the one
    // observation that supports the understatement claim, and it outranks every other classification.
    const refused = classifyExercise({
      observation: observed({
        path: '/oauth/google',
        surface: 'social: google',
        httpStatus: 500,
        windowClean: false,
        authorizationError: REFUSAL_LINE,
      }),
      undecidedReason: reason,
    });
    expect(refused.outcome.outcome).toBe(PATH_OUTCOME.UNDERSTATED);
    expect(refused.outcome.reason).toMatch(/Recompute the Container_1_Grant/);
  });

  // -----------------------------------------------------------------------------------------------
  // NEGATIVE CONTROL 4 — the vacuous pass. A session-gated path exercised anonymously answers 401 over
  // a clean window, which is exactly the three observations criterion 3.13 grants a pass on.
  // -----------------------------------------------------------------------------------------------
  test('a session-gated path with no Session_Fixture is a fixture failure, never a pass', async () => {
    const entry = { surface: 'logout', path: '/api/auth/logout', method: 'POST' };
    const decision = await exercise({
      path: '/api/auth/logout',
      entry,
      ingress: fakeIngress({
        '/api/auth/logout': { status: 401, upstream: AUTH_SURFACE_UPSTREAM },
      }),
      observation: fakeObservation('info: nothing of note'),
      fixture: null,
    });

    expect(decision.outcome).toBeNull();
    expect(decision.failure.kind).toBe(EXERCISE_FAILURE.FIXTURE);
    // The signal is CONSUMED from decideSessionAttachment (task 11.5), not re-derived here.
    expect(decision.failure.reason).toMatch(/FIXTURE FAILURE/);
    expect(decision.failure.reason).toContain('3.22');
    expect(decision.failure.reason).toContain('401');
    // No outcome means the check cannot pass, whatever the other paths did.
    expect(summarizePathExercise([decision]).verdict).toBe('fail');

    // Attached, the same exercise decides normally.
    const attached = await exercise({
      path: '/api/auth/logout',
      entry,
      ingress: fakeIngress({
        '/api/auth/logout': { status: 200, upstream: AUTH_SURFACE_UPSTREAM },
      }),
      observation: fakeObservation(''),
      fixture: { token: 'access-token', cookieHeader: 'refreshToken=v' },
    });
    expect(attached.failure).toBeNull();
    expect(attached.outcome.outcome).toBe(PATH_OUTCOME.PASS);
  });

  test('an exercise attributed elsewhere, or to nothing, decided nothing — and carries no guidance', async () => {
    const noHeader = await exercise({
      ingress: fakeIngress({}), // unmapped -> upstream null
      observation: fakeObservation(''),
    });
    expect(noHeader.outcome).toBeNull();
    expect(noHeader.failure.kind).toBe(EXERCISE_FAILURE.ATTRIBUTION);
    expect(noHeader.failure.reason).toMatch(/X-Harness-Upstream/);
    expect(noHeader.failure.reason).not.toMatch(/Recompute the Container_1_Grant/);

    const elsewhere = await exercise({
      ingress: fakeIngress({ '/api/config': { status: 200, upstream: 'api-container' } }),
      observation: fakeObservation(''),
    });
    expect(elsewhere.failure.kind).toBe(EXERCISE_FAILURE.ATTRIBUTION);
    expect(elsewhere.failure.reason).toMatch(/drifted/);
    expect(elsewhere.failure.reason).not.toMatch(/Recompute the Container_1_Grant/);

    // A request that never completed has no status, so there is no exercise to classify — reported in
    // the same family rather than as a verdict about the grant.
    const transport = await exercise({
      ingress: {
        async request() {
          throw new Error('socket hang up');
        },
      },
      observation: fakeObservation(''),
    });
    expect(transport.outcome).toBeNull();
    expect(transport.failure.reason).toMatch(/socket hang up/);
  });

  test('a routed path with no recorded Path_Payload is a fixture defect, not an exercise', async () => {
    const decision = await exerciseRoutedPath({
      entry: { surface: 'invented', path: '/api/invented', method: 'GET' },
      payload: null,
      ingress: fakeIngress({}),
      observation: fakeObservation(''),
    });
    expect(decision.outcome).toBeNull();
    expect(decision.failure.kind).toBe(EXERCISE_FAILURE.FIXTURE);
    expect(decision.failure.reason).toMatch(/no recorded Path_Payload/);
  });

  test("the check's status is not worst-outcome-wins: any failing outcome fails, all-undecided is not a pass", () => {
    const outcome = (over) => ({
      outcome: {
        path: '/api/config',
        attributedTo: AUTH_SURFACE_UPSTREAM,
        httpStatus: 200,
        windowClean: true,
        reason: null,
        ...over,
      },
      failure: null,
    });
    const pass = outcome({ outcome: PATH_OUTCOME.PASS });
    const undecided = outcome({
      path: '/oauth/google',
      outcome: PATH_OUTCOME.UNDECIDED,
      reason: 'Unconfigured_Provider `google`.',
    });
    const understated = outcome({
      outcome: PATH_OUTCOME.UNDERSTATED,
      windowClean: false,
      reason: 'refused',
    });
    const uncorroborated = outcome({
      outcome: PATH_OUTCOME.UNCORROBORATED,
      httpStatus: 500,
      reason: '500 over a clean window',
    });

    // Passes only when every path is `pass` or `undecided` AND at least one is `pass`.
    expect(summarizePathExercise([pass, undecided]).verdict).toBe('pass');
    expect(summarizePathExercise([pass]).verdict).toBe('pass');
    // An all-`undecided` list is not a pass, for the same reason a run of nothing but `skip` records
    // exits non-zero: nothing exercised the bounded-below half anywhere.
    const allUndecided = summarizePathExercise([undecided, undecided]);
    expect(allUndecided.verdict).toBe('fail');
    expect(allUndecided.observation).toMatch(/no exercise passed/);
    // And either failing outcome fails the check, even beside a pile of passes.
    expect(summarizePathExercise([pass, pass, understated]).verdict).toBe('fail');
    expect(summarizePathExercise([pass, pass, uncorroborated]).verdict).toBe('fail');
    // Every path is reported with its outcome and its reason, so `undecided` does not disappear into an
    // aggregate green.
    const green = summarizePathExercise([pass, undecided], { notes: ['a recorded finding'] });
    expect(green.observation).toContain('/oauth/google');
    expect(green.observation).toContain('Unconfigured_Provider');
    expect(green.observation).toContain('a recorded finding');
    expect(tallyPathOutcomes(green.pathOutcomes)).toEqual({
      pass: 1,
      understated: 0,
      uncorroborated: 0,
      undecided: 1,
    });
    // `reason` is required on every outcome but `pass` — enforced where the record is built, so an
    // artifact cannot carry an unexplained non-pass.
    expect(pathOutcomesProblems(green.pathOutcomes)).toEqual([]);
    expect(pathOutcomesProblems([{ ...undecided.outcome, reason: '' }]).join(' ')).toMatch(
      /requires a reason/,
    );
  });

  test('the exercise order defers the two that consume the session, logout last', () => {
    const ordered = orderedRoutedPaths().map((entry) => entry.path);
    // `/api/auth/logout` DELETES the durable session the Session_Fixture names, so every other
    // session-carrying exercise must precede it, and `/api/auth/refresh` reads the same session.
    expect(ordered.slice(-2)).toEqual(DEFERRED_EXERCISE_ORDER);
    expect(ordered).toHaveLength(AUTH_SURFACE_ROUTED_PATHS.length);
    expect([...ordered].sort()).toEqual([...AUTH_SURFACE_ROUTED_PATHS.map((e) => e.path)].sort());
  });

  test('the routed-path list names full paths under the allowlist, never a bare prefix', () => {
    // A drift guard: every entry is a concrete full path (starts with /), and the /api/admin data
    // prefix is never present as a bare entry (only /api/admin/login and /api/admin/oauth are).
    for (const e of AUTH_SURFACE_ROUTED_PATHS) {
      expect(e.path.startsWith('/')).toBe(true);
    }
    const paths = new Set(AUTH_SURFACE_ROUTED_PATHS.map((e) => e.path));
    expect(paths.has('/api/admin')).toBe(false);
    expect(paths.has('/api/admin/login')).toBe(true);
    expect(CHECK_ID).toBe('PATH-EXERCISE-25');
  });

  test('observeExercise records the three observations and classifies none of them', async () => {
    const obs = await observeExercise({
      ingress: fakeIngress({ '/api/config': { status: 500, upstream: AUTH_SURFACE_UPSTREAM } }),
      observation: fakeObservation(REFUSAL_LINE),
      entry: CONFIG,
      request: { path: '/api/config', method: 'GET', headers: {} },
      window: { since: '2024-01-01T00:00:00.000Z' },
    });

    expect(obs.attributedTo).toBe(AUTH_SURFACE_UPSTREAM);
    expect(obs.httpStatus).toBe(500);
    expect(obs.windowScanned).toBe(true);
    expect(obs.windowClean).toBe(false);
    expect(obs.authorizationError).toMatch(/not authorized/);
    // It carries no verdict of any kind: the classification is somebody else's job, which is what makes
    // the scan unskippable.
    expect(obs.outcome).toBeUndefined();
    expect(obs.ok).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// The harness-context projection (harnessContext). Static, no topology: the projection is what turns
// the published globalThis.__CONTAINER_SPLIT_HARNESS__ into the object the check body reads, so it
// must FORWARD every field the check consumes — not only the two clients and the window. The bridge
// (jest.setup.mjs) and the producer (run.mjs assembleContextPrimitives) publish `seededAccount` and
// `readyAtMs` at the top level of the context; the check reads both (`ctx.seededAccount` to mint the
// Session_Fixture and resolve SEED_PLACEHOLDERS, `ctx.readyAtMs` to wait the boot window out before
// the login mint). This closes a seam that neither the producer test (run-sequence.test.mjs) nor the
// literal-fixture consumer tests covered: nothing asserted the projection forwards what the bridge
// published, so a projection that dropped the two fields turned a real per-path verdict into a
// SessionFixtureError while every other test stayed green.
// ---------------------------------------------------------------------------------------------
describe('harness-context projection (harnessContext) forwards what the bridge publishes', () => {
  const priorContext = globalThis.__CONTAINER_SPLIT_HARNESS__;
  // A published context of the shape jest.setup.mjs assembles: ready-made ingress/observation
  // clients, the window, plus the Seeded_Account and the boot-ready timestamp the check consumes.
  const publishedContext = () => ({
    ingress: { async request() {} },
    observation: { async logs() {} },
    window: { since: '2024-01-01T00:00:00.000Z' },
    seededAccount: {
      id: '0123456789abcdef01234567',
      email: 'seed@container-split.invalid',
      password: 'HarnessSeededAccount1',
    },
    readyAtMs: 1_700_000_000_000,
  });

  afterEach(() => {
    // Restore whatever was on globalThis before this block ran (module load may have set it), so the
    // projection tests do not leak a context into the rest of the suite.
    if (priorContext === undefined) {
      delete globalThis.__CONTAINER_SPLIT_HARNESS__;
    } else {
      globalThis.__CONTAINER_SPLIT_HARNESS__ = priorContext;
    }
  });

  test('forwards seededAccount and readyAtMs alongside ingress, observation and window', () => {
    const published = publishedContext();
    globalThis.__CONTAINER_SPLIT_HARNESS__ = published;

    const projected = harnessContext();

    // The two clients and the window still travel, as before.
    expect(projected.ingress).toBe(published.ingress);
    expect(projected.observation).toBe(published.observation);
    expect(projected.window).toEqual({ since: '2024-01-01T00:00:00.000Z' });
    // The regression: both fields the check body reads are forwarded, not dropped by the projection.
    // A projection that returned only ingress/observation/window would leave these undefined and
    // mintSessionFixture would throw a SessionFixtureError on the falsy account.
    expect(projected.seededAccount).toEqual(published.seededAccount);
    expect(projected.readyAtMs).toBe(published.readyAtMs);
    // Enumerated together so a partial forward — seededAccount without readyAtMs, which would make the
    // login mint proceed INSIDE the boot window BOOT-NOWRITE-23 asserts is empty — fails here.
    expect(Object.keys(projected).sort()).toEqual(
      ['ingress', 'observation', 'readyAtMs', 'seededAccount', 'window'].sort(),
    );
  });

  test('fields the bridge omits arrive as null, not undefined, and the null-gate is unchanged', () => {
    // A context with the clients but neither optional field: the projection defaults both to null
    // (ctx.seededAccount ?? null, ctx.readyAtMs ?? null) so the check reads a stable shape.
    globalThis.__CONTAINER_SPLIT_HARNESS__ = {
      ingress: { async request() {} },
      observation: { async logs() {} },
    };
    const projected = harnessContext();
    expect(projected.seededAccount).toBeNull();
    expect(projected.readyAtMs).toBeNull();
    expect(projected.window).toEqual({});

    // The self-skip path is untouched: no context, or a context without a client, still returns null.
    delete globalThis.__CONTAINER_SPLIT_HARNESS__;
    expect(harnessContext()).toBeNull();
    globalThis.__CONTAINER_SPLIT_HARNESS__ = { observation: { async logs() {} } };
    expect(harnessContext()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The `Path_Payload` fixture's own invariants (task 11.4, Req 3.14/3.15). Static, no topology: they
// decide that the recorded request set covers exactly the paths this check exercises, that every
// entry carries its expected status and its one sentence of justification, and that the conversion
// to an ingress request is what the ingress client takes. Untagged, so the reporter treats them as
// helper tests — the fixture is not itself a Check Catalog entry.
//
// Why these live in the spec rather than in a root-level *.test.mjs: they join the fixture to
// AUTH_SURFACE_ROUTED_PATHS, and the routed-path list is this check's. A payload missing for a path
// the list gained would otherwise surface as an exercise sent with nothing, which is the failure the
// fixture exists to end.
// ---------------------------------------------------------------------------------------------
describe('Path_Payload fixture', () => {
  test('covers exactly the routed paths this check exercises — one payload each, none spare', () => {
    const coverage = assertPayloadCoverage(AUTH_SURFACE_ROUTED_PATHS);
    // Named individually so a failure says WHICH path drifted rather than only that one did.
    expect(coverage.missing).toEqual([]);
    expect(coverage.extra).toEqual([]);
    expect(coverage.duplicated).toEqual([]);
    expect(coverage.ok).toBe(true);
    expect(PATH_PAYLOADS).toHaveLength(AUTH_SURFACE_ROUTED_PATHS.length);
  });

  test('every entry carries the three recorded fields, and the third is real prose', () => {
    for (const entry of PATH_PAYLOADS) {
      // 1. The request itself.
      expect(typeof entry.request.method).toBe('string');
      expect(entry.request.path.startsWith('/')).toBe(true);
      // 2. The expected status — a real HTTP status, never a placeholder.
      expect(Number.isInteger(entry.expectedStatus)).toBe(true);
      expect(entry.expectedStatus).toBeGreaterThanOrEqual(100);
      expect(entry.expectedStatus).toBeLessThan(600);
      // 3. The load-bearing one: one sentence of why the status is the application's own answer.
      // Length is a weak proxy for "justified", but a one-word `why` is the failure mode worth
      // catching — an expected status changed without its reason rewritten.
      expect(entry.why.length).toBeGreaterThan(60);
      expect(entry.why).toMatch(/\d{3}/);
      // Every entry's surface matches the routed list's, so a report reads without a join and the
      // two tables cannot drift into disagreeing labels for one path.
      const routed = AUTH_SURFACE_ROUTED_PATHS.find((e) => e.path === entry.routedPath);
      expect(entry.surface).toBe(routed.surface);
      expect(entry.request.method).toBe(routed.method);
    }
  });

  test('no anonymous POST is sent with an absent body — the malformed-input case this fixture ends', () => {
    // An absent body does not test a handler on neutral input; it tests it on malformed input, which
    // is usually an unhandled throw and therefore a 5xx that says nothing about the grant (Req 3.14).
    // Two POSTs here legitimately carry no body — /api/auth/logout and /api/auth/refresh read their
    // credential from the session and the refresh cookie, not from a body — so the invariant is
    // stated as "a POST that arrives ANONYMOUS records a body". An anonymous bodyless POST is exactly
    // the absent-body hazard; a bodyless POST that carries a credential is carrying its payload.
    // Partitioned rather than branched inside the loop, so a failure NAMES the offending path (and so
    // jest/no-conditional-expect holds).
    const anonymousBodylessPosts = PATH_PAYLOADS.filter(
      (entry) =>
        entry.request.method === 'POST' &&
        entry.session === SESSION_ATTACHMENT.NONE &&
        entry.request.body === undefined,
    );
    // A GET carries no body, and `fetch` rejects one that does.
    const getsCarryingBody = PATH_PAYLOADS.filter(
      (entry) => entry.request.method !== 'POST' && entry.request.body !== undefined,
    );
    expect(anonymousBodylessPosts.map((entry) => entry.routedPath)).toEqual([]);
    expect(getsCarryingBody.map((entry) => entry.routedPath)).toEqual([]);
    expect(payloadFor('/api/auth/logout').request.body).toBeUndefined();
    expect(payloadFor('/api/auth/refresh').request.body).toBeUndefined();
  });

  test('the session table names the requireJwtAuth mounts', () => {
    for (const entry of PATH_PAYLOADS) {
      expect(Object.values(SESSION_ATTACHMENT)).toContain(entry.session);
    }
    // The four 2FA mounts and /api/auth/logout are the routes behind middleware.requireJwtAuth in
    // api/server/routes/auth.js — derived from the route file at implementation time (NG4), not
    // re-derived from the split.
    expect([...SESSION_GATED_PATHS].sort()).toEqual(
      [
        '/api/auth/2fa/backup/regenerate',
        '/api/auth/2fa/disable',
        '/api/auth/2fa/enable',
        '/api/auth/2fa/verify',
        '/api/auth/logout',
      ].sort(),
    );
    // /api/auth/refresh needs the fixture attached without being gated by it: its handler reads the
    // refresh cookie and returns early with a 200 that queried nothing when the cookie is absent.
    expect(SESSION_ATTACHED_PATHS).toContain('/api/auth/refresh');
    expect(SESSION_GATED_PATHS).not.toContain('/api/auth/refresh');
  });

  test('the findings are recorded on the entries, not left in prose', () => {
    // F1 and F2: three routed entries whose well-formed request cannot be expressed as the routed
    // path names it. Asserting they are carried in PAYLOAD_FINDINGS is what stops a future edit from
    // quietly dropping the report and leaving a 404 reading as a pass.
    const flagged = PAYLOAD_FINDINGS.map((finding) => finding.routedPath).sort();
    expect(flagged).toEqual(['/api/admin/login', '/api/admin/oauth', '/api/auth/ldap'].sort());
    // The two admin entries reach a real mount underneath the routed prefix; the LDAP entry does not,
    // because no LDAP mount exists at any path.
    expect(payloadFor('/api/admin/login').request.path).toBe('/api/admin/login/local');
    expect(payloadFor('/api/admin/oauth').request.path).toBe('/api/admin/oauth/openid');
    expect(payloadFor('/api/auth/ldap').expectedStatus).toBe(404);
  });

  test('a recorded payload converts to the request the ingress client takes', () => {
    const seededAccount = {
      email: 'seed@container-split.invalid',
      password: 'HarnessSeededAccount1',
      id: '0123456789abcdef01234567',
    };
    const request = toIngressRequest(payloadFor('/api/user/verify'), { seededAccount });

    expect(request.path).toBe('/api/user/verify');
    expect(request.method).toBe('POST');
    // Without the content-type, express.json() does not parse the body and the handler sees `{}` —
    // the absent-body case wearing a payload's clothes.
    expect(request.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request.body)).toEqual({
      email: seededAccount.email,
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // A GET converts with no body at all.
    expect(toIngressRequest(payloadFor('/api/config')).body).toBeUndefined();
  });

  test('an unresolved Seeded_Account placeholder throws rather than reaching a handler', () => {
    // Sending the literal placeholder would land as a 400 that reads like the application's own
    // validation answer — the precise misreading this fixture exists to prevent.
    expect(() => resolveSeedPlaceholders({ email: SEED_PLACEHOLDERS.EMAIL }, {})).toThrow(
      /Seeded_Account/,
    );
    expect(
      resolveSeedPlaceholders({ email: SEED_PLACEHOLDERS.EMAIL }, { email: 'a@b.invalid' }),
    ).toEqual({ email: 'a@b.invalid' });
  });
});

// ---------------------------------------------------------------------------------------------
// The `Unconfigured_Provider` derivation (task 11.6, Req 3.19/3.20/3.21). Static, no topology: these
// decide that the carve-out set is a FUNCTION of the resolved provider configuration rather than a
// list — that the harness's own configuration leaves all six provider paths undecided with the
// provider named, that configuring one moves its path out of the carve-out with no edit to the
// derivation, and that a provider path nothing recognizes is reported as a fixture bug instead of
// defaulting into the carve-out. Untagged, so the reporter treats them as helper tests; the derivation
// is a fixture for PATH-EXERCISE-25, not a Check Catalog entry of its own.
//
// They live in this spec rather than a root-level *.test.mjs for the same reason the Path_Payload
// block does: they join the derivation to AUTH_SURFACE_ROUTED_PATHS and to the recorded payloads, and
// both of those tables are this check's.
// ---------------------------------------------------------------------------------------------
describe('Unconfigured_Provider derivation', () => {
  // The harness's own shape: no enablement flag, no client credential (env/common.env.example and
  // env/auth-surface.env.example carry neither — asserted against the templates themselves below).
  const HARNESS_ENV = Object.freeze({ CREDS_KEY: 'k', JWT_SECRET: 'j', USE_REDIS: 'true' });

  // A fully configured google, and a fully configured openid as a PUBLIC client (PKCE instead of a
  // client secret) — the two shapes a "CLIENT_ID + CLIENT_SECRET" assumption would get wrong.
  const CONFIGURED_ENV = Object.freeze({
    ...HARNESS_ENV,
    [SOCIAL_LOGIN_ENABLEMENT_FLAG]: 'true',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    APPLE_CLIENT_ID: 'apple-client',
    APPLE_PRIVATE_KEY_PATH: '/run/secrets/apple.p8',
    OPENID_CLIENT_ID: 'openid-client',
    OPENID_USE_PKCE: 'true',
    OPENID_ISSUER: 'https://issuer.invalid',
    OPENID_SCOPE: 'openid profile email',
    OPENID_SESSION_SECRET: 'openid-session',
  });

  const routedProviderPaths = () =>
    socialProviderCandidates(AUTH_SURFACE_ROUTED_PATHS).map((entry) => entry.routedPath);

  test('the harness configuration leaves every routed provider path undecided, naming its provider', () => {
    const derived = deriveProviderConfiguration(HARNESS_ENV, AUTH_SURFACE_ROUTED_PATHS);

    // The set IS the routed list's provider paths — no more (a path nothing routes) and no fewer.
    expect(derived.undecidedPaths).toEqual(routedProviderPaths());
    expect(derived.configuredPaths).toEqual([]);
    // Every provider path in the routed list has a recorded gate; an unrecognized one would be a
    // fixture bug rather than a silent member of the carve-out.
    expect(derived.unknown).toEqual([]);
    // Req 3.20: the reason NAMES the unconfigured provider and the configuration it is missing, and
    // says what the clean window does not decide.
    for (const decision of derived.undecided) {
      expect(decision.reason).toContain(decision.provider);
      expect(decision.reason).toContain(decision.routedPath);
      expect(decision.reason).toContain(SOCIAL_LOGIN_ENABLEMENT_FLAG);
      expect(decision.reason).toMatch(/UNDECIDED/);
      expect(decision.missing.length).toBeGreaterThan(1);
    }
  });

  test('the candidate set is read off the routed-path list, never a list in the derivation', () => {
    // Drop google from the routed list and it leaves the carve-out; add a provider path the routed
    // list did not have and it joins. Neither is expressible if the set were hard-coded (Req 3.21).
    const withoutGoogle = AUTH_SURFACE_ROUTED_PATHS.filter((e) => e.path !== '/oauth/google');
    expect(deriveProviderConfiguration(HARNESS_ENV, withoutGoogle).undecidedPaths).not.toContain(
      '/oauth/google',
    );
    const narrow = deriveProviderConfiguration(HARNESS_ENV, ['/api/config', '/oauth/github']);
    expect(narrow.undecidedPaths).toEqual(['/oauth/github']);
    // A non-provider path is not a candidate at all — including the admin oauth mount, which is a
    // configured-feature absence in the same family but not an Unconfigured_Provider path.
    expect(providerFromRoutedPath('/api/admin/oauth')).toBeNull();
    expect(providerFromRoutedPath('/api/config')).toBeNull();
    expect(isUndecidedPath(deriveProviderConfiguration(HARNESS_ENV), '/api/admin/oauth')).toBe(
      false,
    );
  });

  test('both halves are required: the enablement flag alone and the credential alone are insufficient', () => {
    const flagOnly = deriveProviderConfiguration({ [SOCIAL_LOGIN_ENABLEMENT_FLAG]: 'true' }, [
      '/oauth/google',
    ]);
    const credentialOnly = deriveProviderConfiguration(
      { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
      ['/oauth/google'],
    );
    expect(flagOnly.undecidedPaths).toEqual(['/oauth/google']);
    expect(flagOnly.undecided[0].missing).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(credentialOnly.undecidedPaths).toEqual(['/oauth/google']);
    expect(credentialOnly.undecided[0].missing).toEqual([`${SOCIAL_LOGIN_ENABLEMENT_FLAG}=true`]);
    // `isEnabled`'s semantics, not mere presence: ALLOW_SOCIAL_LOGIN=false is not enabled.
    const flagFalse = deriveProviderConfiguration(
      { ...CONFIGURED_ENV, [SOCIAL_LOGIN_ENABLEMENT_FLAG]: 'false' },
      ['/oauth/google'],
    );
    expect(flagFalse.undecidedPaths).toEqual(['/oauth/google']);
  });

  test('configuring a provider moves its path into full exercise, with apple and PKCE openid as themselves', () => {
    const derived = deriveProviderConfiguration(CONFIGURED_ENV, AUTH_SURFACE_ROUTED_PATHS);

    // google (id + secret), apple (id + PRIVATE KEY PATH) and openid (five values, PKCE standing in
    // for the secret) are configured; the three the env says nothing about are not.
    expect([...derived.configuredPaths].sort()).toEqual(
      ['/oauth/apple', '/oauth/google', '/oauth/openid'].sort(),
    );
    expect([...derived.undecidedPaths].sort()).toEqual(
      ['/oauth/discord', '/oauth/facebook', '/oauth/github'].sort(),
    );
    // A configured provider has no reason to report, which is what keeps `undecided` from outliving
    // the absence that justifies it (Req 3.21).
    expect(undecidedReasonFor(derived, '/oauth/google')).toBeNull();
    expect(undecidedReasonFor(derived, '/oauth/github')).toContain('github');
    expect(isUndecidedPath(derived, '/oauth/google')).toBe(false);
    expect(isUndecidedPath(derived, '/oauth/github')).toBe(true);
    // An openid CONFIDENTIAL client (secret, no PKCE) is configured on the same gate.
    const confidential = deriveProviderConfiguration(
      { ...CONFIGURED_ENV, OPENID_USE_PKCE: '', OPENID_CLIENT_SECRET: 'openid-secret' },
      ['/oauth/openid'],
    );
    expect(confidential.configuredPaths).toEqual(['/oauth/openid']);
  });

  test('present-and-empty is absent, the way docker env_file produces it', () => {
    // `KEY=` in an env file becomes an empty STRING in the container, and the application tests
    // truthiness — so an empty credential is not a credential, and the path stays undecided.
    const blank = deriveProviderConfiguration(
      {
        [SOCIAL_LOGIN_ENABLEMENT_FLAG]: 'true',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: '   ',
      },
      ['/oauth/google'],
    );
    expect(blank.undecidedPaths).toEqual(['/oauth/google']);
    expect(blank.undecided[0].missing).toEqual(['GOOGLE_CLIENT_SECRET']);
  });

  test('a routed /oauth path with no recorded gate is a fixture bug, not a silent undecided', () => {
    const derived = deriveProviderConfiguration(HARNESS_ENV, ['/oauth/saml']);

    expect(derived.undecidedPaths).toEqual([]);
    expect(derived.unknown.map((entry) => entry.provider)).toEqual(['saml']);
    expect(derived.unknown[0].reason).toMatch(/FIXTURE BUG/);
    // Not folded into either verdict: an unrecognized provider must not dodge the grant-sufficiency
    // exercise, and nothing derived its expected status either.
    expect(isUndecidedPath(derived, '/oauth/saml')).toBe(false);
    expect(undecidedReasonFor(derived, '/oauth/saml')).toBeNull();
  });

  test('each undecided path still carries its recorded payload, and a configured one flags a stale payload', () => {
    const derived = deriveProviderConfiguration(HARNESS_ENV, AUTH_SURFACE_ROUTED_PATHS);

    // The carve-out withholds a VERDICT, not the exercise: every one of these paths is still
    // exercised with its recorded request and still attributed (Req 3.19).
    for (const routedPath of derived.undecidedPaths) {
      expect(payloadFor(routedPath)).not.toBeNull();
      expect(payloadFor(routedPath).expectedStatus).toBe(500);
    }
    // Under the harness configuration nothing is stale — no provider is configured.
    expect(findStaleProviderPayloads(derived, PATH_PAYLOADS)).toEqual([]);
    // Configure one and the recorded 500 (the answer for an UNREGISTERED strategy) no longer holds:
    // reported as a fixture bug, which is the other half of "a configured provider whose path still
    // reports `undecided` is a fixture bug" (Req 3.21).
    const stale = findStaleProviderPayloads(
      deriveProviderConfiguration(CONFIGURED_ENV, AUTH_SURFACE_ROUTED_PATHS),
      PATH_PAYLOADS,
    );
    expect(stale.map((entry) => entry.routedPath).sort()).toEqual(
      ['/oauth/apple', '/oauth/google', '/oauth/openid'].sort(),
    );
    expect(stale[0].detail).toMatch(/FIXTURE BUG/);
  });

  test('the derivation reads the resolved container environment through an injected compose config', async () => {
    // The same seam TOPO-ENV-14 reads: `docker compose config --format json`, whose `environment` map
    // is env_file ∪ the inline block ∪ the interpolation — the environment the container receives.
    const fakeConfig = JSON.stringify({
      services: {
        'auth-surface': {
          environment: {
            CREDS_KEY: 'k',
            ALLOW_SOCIAL_LOGIN: 'true',
            GITHUB_CLIENT_ID: 'gh-id',
            GITHUB_CLIENT_SECRET: 'gh-secret',
          },
        },
      },
    });
    const derived = await resolveProviderConfiguration({ exec: async () => fakeConfig });

    expect(derived.configuredPaths).toEqual(['/oauth/github']);
    expect(derived.undecidedPaths).not.toContain('/oauth/github');
    expect(derived.undecidedPaths).toHaveLength(routedProviderPaths().length - 1);
  });

  test('a resolved config without the provider-serving service throws rather than widening the carve-out', async () => {
    // An empty env map would read as "no provider configured" and withhold six verdicts for the wrong
    // reason, so the absent service is an error rather than a wide carve-out.
    await expect(
      resolveProviderConfiguration({ exec: async () => JSON.stringify({ services: {} }) }),
    ).rejects.toThrow(/absent from the resolved configuration/);
  });

  test('the committed env templates configure no social provider — the premise the carve-out rests on', async () => {
    // The carve-out's justification is a fact about the harness's configuration, so it is checked
    // against the committed templates rather than asserted in prose. The Auth_Surface loads
    // common.env then auth-surface.env; collapsed.env is the overlay run.mjs applies for the
    // collapsed profile. If a provider is ever configured in one of them, this test fails and the
    // derivation — not this list — is what decides the consequence.
    const texts = await Promise.all(
      ['common.env.example', 'auth-surface.env.example', 'collapsed.env.example'].map((name) =>
        readFile(new URL(`../env/${name}`, import.meta.url), 'utf8'),
      ),
    );
    // Parse `KEY=value` assignments only: a comment sets nothing, and these templates discuss absent
    // keys in prose.
    const resolved = {};
    for (const line of texts.join('\n').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
      if (match !== null) {
        resolved[match[1]] = match[2];
      }
    }

    const derived = deriveProviderConfiguration(resolved, AUTH_SURFACE_ROUTED_PATHS);
    expect(derived.configuredPaths).toEqual([]);
    expect(derived.undecidedPaths).toEqual(routedProviderPaths());
    expect(resolved[SOCIAL_LOGIN_ENABLEMENT_FLAG]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// The `Session_Fixture` (task 11.5, Req 3.16/3.17/3.18/3.22). Static, no topology: these exercise the
// mint against a FAKE ingress and a fake clock, and they decide the three things the fixture is for —
// that a login which does not yield a usable credential fails LOUDLY rather than leaving an anonymous
// client behind, that both credentials are carried the way a browser carries them, and that a
// session-gated exercise with nothing attached produces the fixture-failure signal rather than the pass
// criterion 3.13's wording would hand it.
//
// Untagged, so the reporter treats them as helper tests: the fixture is a fixture for PATH-EXERCISE-25,
// not a Check Catalog entry. They live in this spec for the same reason the Path_Payload block does —
// they join the fixture to the recorded session table, which is this check's.
//
// The live mint is NOT wired into the exercises here. Task 11.1 owns the decision rule that consumes
// the fixture — the four per-path outcomes, and the reporting of a fixture failure; this task supplies
// the fixture and the signal in the shape that rule takes.
// ---------------------------------------------------------------------------------------------
describe('Session_Fixture', () => {
  const SEEDED_ACCOUNT = Object.freeze({
    id: '0123456789abcdef01234567',
    email: 'harness-seed-0123456789ab@container-split.invalid',
    password: 'a'.repeat(48),
  });

  // A fake ingress client in the shape makeIngressClient returns: `request()` resolving
  // `{ status, upstream, headers, body }`, where `body` is a minimal Response-like with `json()`.
  // Every request is recorded so a test can assert WHAT was posted and WHEN.
  const fakeIngress = ({ status = 200, json = { token: 'access-token' }, setCookie = [] } = {}) => {
    const requests = [];
    return {
      baseUrl: 'http://127.0.0.1:8080',
      requests,
      async request(options) {
        requests.push(options);
        return {
          status,
          upstream: 'auth-surface',
          headers: { getSetCookie: () => setCookie },
          body: {
            async json() {
              if (json === null) {
                throw new Error('not json');
              }
              return json;
            },
          },
        };
      },
    };
  };

  const LOGIN_COOKIES = Object.freeze([
    `${REFRESH_COOKIE_NAME}=refresh-value; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`,
    `${TOKEN_PROVIDER_COOKIE_NAME}=librechat; Path=/; HttpOnly; SameSite=Strict`,
  ]);

  // A fixture of the shape mintSessionFixture returns, for the pure attachment tests.
  const FIXTURE = Object.freeze({
    token: 'access-token',
    cookieHeader: `${REFRESH_COOKIE_NAME}=refresh-value; ${TOKEN_PROVIDER_COOKIE_NAME}=librechat`,
  });

  test('a successful login yields both credentials, read out of the response and nothing else', async () => {
    const ingress = fakeIngress({ setCookie: [...LOGIN_COOKIES] });
    const fixture = await mintSessionFixture({
      ingress,
      seededAccount: SEEDED_ACCOUNT,
      readyAtMs: 0,
      now: () => 10 * BOOT_WINDOW_TAIL_MS,
    });

    // The mint posts the Seeded_Account's credentials to the application's own login mount, through the
    // ingress, as JSON — and nothing else is sent.
    expect(ingress.requests).toHaveLength(1);
    expect(ingress.requests[0].path).toBe(LOGIN_PATH);
    expect(ingress.requests[0].method).toBe('POST');
    expect(JSON.parse(ingress.requests[0].body)).toEqual({
      email: SEEDED_ACCOUNT.email,
      password: SEEDED_ACCOUNT.password,
    });
    // No Origin / Sec-Fetch-Site: `requireSameOrigin` admits a request carrying neither, while a
    // foreign Origin would make its 403 the observed answer instead of the login handler's.
    expect(ingress.requests[0].headers.origin).toBeUndefined();

    // The access token comes from the body, the refresh cookie from `set-cookie` — carried verbatim.
    expect(fixture.token).toBe('access-token');
    expect(fixture.cookies[REFRESH_COOKIE_NAME]).toBe('refresh-value');
    expect(fixture.cookies[TOKEN_PROVIDER_COOKIE_NAME]).toBe('librechat');
    expect(fixture.cookieHeader).toContain(`${REFRESH_COOKIE_NAME}=refresh-value`);
    // The jar is scoped to the ingress origin, which the client bakes in and no check can re-point.
    expect(fixture.origin).toBe('http://127.0.0.1:8080');
    // Identity travels for the report; the password does not travel with the fixture.
    expect(fixture.account).toEqual({ id: SEEDED_ACCOUNT.id, email: SEEDED_ACCOUNT.email });
    expect(JSON.stringify(fixture)).not.toContain(SEEDED_ACCOUNT.password);
  });

  test('the mint waits for the boot window to close before issuing any ingress request', async () => {
    // Login triggers the memoized Model.createIndexes() on `sessions`, `refreshtokenbridges` and
    // `openidrefreshflights`, and BOOT-NOWRITE-23 counts writes attributed to the Auth_Surface inside
    // [bootStart, readyAt + 60s]. The wait is a property of the FIXTURE rather than of Jest's file
    // order, because Jest picks its own order and a mint that depended on running after
    // boot-nowrite.spec.mjs would be correct only by luck.
    const readyAtMs = 1_000;
    const ingress = fakeIngress({ setCookie: [...LOGIN_COOKIES] });
    const slept = [];
    let clock = readyAtMs + 5_000; // inside the window
    // How many requests the ingress had seen when the wait began — recorded rather than asserted inside
    // the callback, so the assertion reads in the test body.
    const requestsWhenSleepBegan = [];

    await mintSessionFixture({
      ingress,
      seededAccount: SEEDED_ACCOUNT,
      readyAtMs,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        requestsWhenSleepBegan.push(ingress.requests.length);
        clock += ms;
      },
    });

    expect(slept).toEqual([BOOT_WINDOW_TAIL_MS - 5_000]);
    // Nothing had been requested through the ingress when the wait began: the login is issued after the
    // window closes, not before.
    expect(requestsWhenSleepBegan).toEqual([0]);
    expect(ingress.requests).toHaveLength(1);

    // And the wait computation itself: remaining time inside the window, zero once it has closed, zero
    // when no right edge was recorded (an absent edge is an incomplete context, not a reason to guess).
    expect(msUntilBootWindowClosed(readyAtMs, { now: () => readyAtMs })).toBe(BOOT_WINDOW_TAIL_MS);
    expect(
      msUntilBootWindowClosed(readyAtMs, { now: () => readyAtMs + BOOT_WINDOW_TAIL_MS + 1 }),
    ).toBe(0);
    expect(msUntilBootWindowClosed(null, { now: () => 0 })).toBe(0);
    expect((await awaitBootWindowClosed(readyAtMs, { now: () => 1e12 })).waitedMs).toBe(0);
  });

  test('a login that does not yield a usable credential fails loudly, never anonymously', async () => {
    // Every branch below would otherwise leave the caller with an anonymous client, and an anonymous
    // exercise of a session-gated path is a 401 over a clean window — read as grant sufficiency.
    const cases = [
      { label: 'non-200', options: { status: 401 } },
      { label: 'no token in the body', options: { json: {}, setCookie: [...LOGIN_COOKIES] } },
      { label: 'unparseable body', options: { json: null, setCookie: [...LOGIN_COOKIES] } },
      { label: 'no refresh cookie', options: { setCookie: [] } },
      { label: 'two-factor pending', options: { json: { twoFAPending: true, tempToken: 't' } } },
    ];

    const outcomes = [];
    for (const { label, options } of cases) {
      const rejection = await mintSessionFixture({
        ingress: fakeIngress(options),
        seededAccount: SEEDED_ACCOUNT,
        readyAtMs: 0,
        now: () => 10 * BOOT_WINDOW_TAIL_MS,
      }).then(
        () => null,
        (error) => error,
      );
      // Collected per case and asserted as one list, so a failure names WHICH branch let an anonymous
      // client through rather than only that one did.
      outcomes.push({ label, threw: rejection instanceof SessionFixtureError });
    }
    expect(outcomes).toEqual(cases.map(({ label }) => ({ label, threw: true })));

    // A missing ingress client or a missing Seeded_Account is the same class of failure: the mint must
    // go through the Front_Proxy, and it needs the account the runner seeded under the Root_Credential.
    await expect(mintSessionFixture({ seededAccount: SEEDED_ACCOUNT })).rejects.toThrow(
      /INGRESS client/,
    );
    await expect(
      mintSessionFixture({ ingress: fakeIngress(), seededAccount: { email: 'a@b.invalid' } }),
    ).rejects.toThrow(/Seeded_Account/);
  });

  test('the cookie jar reads multiple Set-Cookie values and ignores the attributes', async () => {
    // `Headers.getSetCookie()` is the only API that returns multiple values separately — a folded
    // `get('set-cookie')` string cannot be split unambiguously, because an `Expires` attribute contains
    // a comma. Both shapes are accepted; `Secure` is deliberately NOT honored, because the harness
    // ingress is plain http on loopback and dropping the cookie would fail every session-gated exercise
    // for a transport reason that says nothing about the grant.
    const fromArray = parseSetCookieJar({ getSetCookie: () => [...LOGIN_COOKIES] });
    expect(fromArray).toEqual({
      [REFRESH_COOKIE_NAME]: 'refresh-value',
      [TOKEN_PROVIDER_COOKIE_NAME]: 'librechat',
    });
    const folded = parseSetCookieJar({
      get: () =>
        `${REFRESH_COOKIE_NAME}=refresh-value; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT, ` +
        `${TOKEN_PROVIDER_COOKIE_NAME}=librechat; Path=/`,
    });
    expect(folded[REFRESH_COOKIE_NAME]).toBe('refresh-value');
    expect(folded[TOKEN_PROVIDER_COOKIE_NAME]).toBe('librechat');
    expect(parseSetCookieJar(null)).toEqual({});
    expect(cookieHeaderFrom({})).toBeNull();
    expect(cookieHeaderFrom({ a: '1', b: '2' })).toBe('a=1; b=2');
  });

  test('each attachment carries what its mount reads, and nothing it does not', () => {
    // GATED: both credentials, the way a browser holds them — the bearer for `requireJwtAuth`, and the
    // cookie for a handler that also reads it (logout deletes the session the refresh token names).
    expect(sessionHeadersFor(SESSION_ATTACHMENT.GATED, FIXTURE)).toEqual({
      authorization: `Bearer ${FIXTURE.token}`,
      cookie: FIXTURE.cookieHeader,
    });
    // REFRESH_COOKIE: the cookie only. `/api/auth/refresh` reads the cookie, not the bearer, and
    // sending the bearer would misstate what the exercise depends on.
    expect(sessionHeadersFor(SESSION_ATTACHMENT.REFRESH_COOKIE, FIXTURE)).toEqual({
      cookie: FIXTURE.cookieHeader,
    });
    // NONE: nothing. The mount sits ahead of every authentication middleware.
    expect(sessionHeadersFor(SESSION_ATTACHMENT.NONE, FIXTURE)).toEqual({});
    expect(sessionHeadersFor(SESSION_ATTACHMENT.GATED, null)).toEqual({});
  });

  test('attaching merges into the recorded request without producing a second spelling of a header', () => {
    const entry = payloadFor('/api/auth/logout');
    const attached = attachSessionFixture(toIngressRequest(entry), { entry, fixture: FIXTURE });

    expect(attached.attached).toBe(true);
    expect(attached.fixtureFailure).toBeNull();
    expect(attached.request.path).toBe('/api/auth/logout');
    expect(attached.request.headers.authorization).toBe(`Bearer ${FIXTURE.token}`);
    expect(attached.request.headers.cookie).toBe(FIXTURE.cookieHeader);
    // One spelling per header name: the recorded headers are lowercased before the merge, so an
    // upper-case recorded `Cookie` cannot survive beside the fixture's.
    const merged = attachSessionFixture(
      {
        path: '/x',
        method: 'POST',
        headers: { Cookie: 'stale=1', 'Content-Type': 'application/json' },
      },
      { entry, fixture: FIXTURE },
    );
    expect(Object.keys(merged.request.headers).sort()).toEqual([
      'authorization',
      'content-type',
      'cookie',
    ]);
    expect(merged.request.headers.cookie).toBe(FIXTURE.cookieHeader);
    // A non-session path is left exactly as recorded.
    const anonymous = payloadFor('/api/config');
    const untouched = attachSessionFixture(toIngressRequest(anonymous), {
      entry: anonymous,
      fixture: FIXTURE,
    });
    expect(untouched.request.headers).toEqual({});
    expect(untouched.required).toBe(false);
  });

  test('a session-gated path exercised with nothing attached is a fixture failure, never a pass', () => {
    // Req 3.22 / Property 6: the gate refuses an anonymous request ahead of the handler, so the handler
    // queries no collection — a non-5xx status over a clean window, which is exactly the three
    // observations criterion 3.13 grants a pass on, over evidence identical to what a grant of zero
    // collections would produce. NC8 (task 13.3) is the control that proves this cannot pass.
    for (const routedPath of SESSION_GATED_PATHS) {
      const entry = payloadFor(routedPath);
      const decision = decideSessionAttachment({ entry, fixture: null });
      expect(decision.required).toBe(true);
      expect(decision.attached).toBe(false);
      expect(decision.fixtureFailure.routedPath).toBe(routedPath);
      expect(decision.fixtureFailure.reason).toMatch(/FIXTURE FAILURE/);
      expect(decision.fixtureFailure.reason).toContain('3.22');
      // Attached, the same path carries both credentials and reports no failure.
      expect(decideSessionAttachment({ entry, fixture: FIXTURE }).attached).toBe(true);
      expect(decideSessionAttachment({ entry, fixture: FIXTURE }).fixtureFailure).toBeNull();
    }
    // A half-credential does not count as attached: a gated mount needs the bearer, and a fixture
    // carrying only a cookie would be refused by `requireJwtAuth` exactly as an anonymous one is.
    const gated = payloadFor(SESSION_GATED_PATHS[0]);
    expect(
      decideSessionAttachment({ entry: gated, fixture: { cookieHeader: 'refreshToken=v' } })
        .fixtureFailure,
    ).not.toBeNull();
    // `/api/auth/refresh` needs the cookie but is NOT gated: without it the handler answers 200 having
    // queried nothing, which weakens that exercise's evidence but is not the vacuous pass 3.22 names —
    // so it reports `attached: false` and leaves the classification to task 11.1's rule.
    const refresh = payloadFor('/api/auth/refresh');
    const refreshDecision = decideSessionAttachment({ entry: refresh, fixture: null });
    expect(refreshDecision.required).toBe(true);
    expect(refreshDecision.attached).toBe(false);
    expect(refreshDecision.fixtureFailure).toBeNull();
    // A path that needs nothing reports nothing missing.
    expect(
      decideSessionAttachment({ entry: payloadFor('/api/banner'), fixture: null }).fixtureFailure,
    ).toBeNull();
  });

  test('every path the recorded table says needs the session can be handed one', () => {
    // The table is the join point: one list says per path what is attached to it (task 11.4), and this
    // asserts the fixture satisfies every entry on it — so a path that gains a session requirement
    // cannot end up exercised anonymously because the attachment logic did not know about it.
    for (const routedPath of SESSION_ATTACHED_PATHS) {
      const entry = payloadFor(routedPath);
      const attached = attachSessionFixture(toIngressRequest(entry), { entry, fixture: FIXTURE });
      expect(attached.required).toBe(true);
      expect(attached.attached).toBe(true);
      expect(attached.request.headers.cookie).toBe(FIXTURE.cookieHeader);
    }
    expect(SESSION_ATTACHED_PATHS.length).toBeGreaterThan(SESSION_GATED_PATHS.length);
  });

  test('the fixture module mints, decodes and re-signs nothing — NG6 asserted against its source', async () => {
    // The fixture is an APPLICATION session obtained through the application's own login handler and
    // carried verbatim. The moment the harness reads a token's claims it has begun emulating the
    // Auth_Gate, which the harness does not stand up — and the same property (no signing key, no
    // crypto at the edge) is what makes a commodity reverse proxy an adequate Front_Proxy here. The
    // needles live in this test rather than in the module, where they would match themselves.
    const source = await readFile(new URL('./path-exercise.session.mjs', import.meta.url), 'utf8');
    const forbidden = [
      'jsonwebtoken',
      'jwt.sign',
      'jwt.verify',
      'jwt.decode',
      'createHmac',
      'createSign',
      'JWT_SECRET',
      'JWT_REFRESH_SECRET',
    ];
    expect(forbidden.filter((needle) => source.includes(needle))).toEqual([]);
  });
});
