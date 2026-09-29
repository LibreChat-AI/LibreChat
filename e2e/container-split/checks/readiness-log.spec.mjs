// readiness-log.spec.mjs — BOOT-CLEAN-21, the boot-log authorization-error check (task 10.2).
//
// This file owns the log-scan half of Property 3 ("Both containers boot clean under their own grant",
// parent P6). readiness.spec.mjs (task 10.1) decides the readiness READS — /health, /livez, /readyz
// answer 200 within 60s — and explicitly LEFT the boot-log authorization-error scan to this file, so
// the two decide disjoint parts of the same property rather than restating each other:
//
//   * BOOT-CLEAN-21 (Req 3.2, 2.10): NO authorization error appears anywhere in the Auth_Surface's
//     boot log window, caught-and-logged failures included. The Auth_Surface boots under the
//     Container_1_Grant; a clean boot log is the evidence that it never exceeded that grant while
//     coming up.
//
// == Why the log scan, and not just readiness ==
// Property 3's STRONG FORM counts a *caught-and-logged* authorization failure as a violation, not
// only a fatal one. A container that swallows a refusal and STILL reaches /readyz has exceeded its
// grant — and that swallowed case is exactly the one a readiness check (task 10.1) misses, because
// the container answers 200 regardless. mongod records a refused operation as an authorization
// error, and the application logs it even when it catches it; so scanning the boot log window is the
// load-bearing observation for the strong form, and a green readiness result alone is insufficient.
//
// == The boot window ==
// The window opens at the Auth_Surface's process-start timestamp (captureBootStart's left edge, which
// the runner records before `docker compose up auth-surface`, task 7.2) and is read through the
// observation client's `logs(container, { since })` — `docker compose logs auth-surface --since
// <bootStart>` — so the scan is scoped to the boot rather than the whole run. Req 2.10 orders this
// check BEFORE any request-level check (the runner issues no ingress request until the boot-window
// checks have closed, and the compose depends_on chain enforces the same ordering structurally), so
// the window this check reads carries the boot and not a later login's request-path activity.
//
// == On failure ==
// Report the matched log line AND the collection named in it. The correct response is to RECOMPUTE
// the Container_1_Grant from the offending path's collection needs, or to extend the startup-task
// gate's coverage — NOT to widen the grant to silence the line (design.md: "Authorization error
// during Auth_Surface boot"; this is the intended loud failure of the write-restricted credential,
// most often a startup-task gate coverage gap rather than the grant itself).
//
// == What runs now vs. against the live topology (task 15) ==
// The pure decision — classifying a log line as a mongod authorization error and naming the
// collection it implicates — lives here as exported deciders (classifyBootLogAuthorizationError /
// findBootLogAuthorizationError), on the shape of path-exercise.spec.mjs's findAuthorizationError and
// boot-nowrite.filter.mjs's pure predicates, and is exercised now against synthetic log lines: a
// mongod "not authorized" line is detected; an unrelated line is not. The live log read of the
// Auth_Surface boot window is supplied by the live topology (HARNESS_LIVE=1, task 15); absent it, the
// live check self-skips with a reason the reporter surfaces, so a plain `jest` run reports a skip
// rather than a failure. The bracketed [BOOT-CLEAN-21] tag stays on the title so the reporter records
// the check id either way.
//
// NG1/NG2 hold: this reads the harness's own boot log window through the observation client and
// touches no application code and neither container-split script.

import { makeObservationClient } from '../run.mjs';
// The exported constants and pure deciders live in readiness-log.filter.mjs (a non-spec sibling) so this
// spec file exports nothing (task 14.6). The spec imports what its checks exercise.
import {
  CHECK_ID,
  collectionNamedIn,
  classifyBootLogAuthorizationError,
  findBootLogAuthorizationError,
  scanBootLog,
} from './readiness-log.filter.mjs';

// ---------------------------------------------------------------------------------------------
// The live-topology harness context (task 15).
//
// Task 15 brings the topology up and attaches a context to globalThis before invoking Jest: the
// observation client (whose `exec` reads live `docker compose logs`) and the boot window's left edge
// (captureBootStart's `{ epochMs, iso }`). Absent it — a plain `jest`/`--listTests` invocation with no
// topology — the live check self-skips. Accept either a ready-made observation client or the `exec`
// primitive to build one, so task 15 can hand either (matching path-exercise.spec.mjs).
// ---------------------------------------------------------------------------------------------
function harnessContext() {
  const ctx = globalThis.__CONTAINER_SPLIT_HARNESS__;
  if (!ctx || typeof ctx !== 'object') {
    return null;
  }
  const observation =
    ctx.observation ??
    (typeof ctx.exec === 'function'
      ? makeObservationClient({ fetch: ctx.fetch ?? globalThis.fetch, exec: ctx.exec })
      : null);
  if (!observation) {
    return null;
  }
  // The boot window's left edge: captureBootStart's ISO timestamp, used as `docker compose logs
  // --since`. Fall back to the whole run's logs when the runner did not record it (the scan is still
  // correct, only wider) so a context without a boot-start does not disable the check.
  const since = ctx.bootStart?.iso ?? ctx.window?.since ?? null;
  return { observation, window: { since } };
}

// Live gate. HARNESS_LIVE=1 is the signal run.mjs sets against a live topology (the same signal the
// sibling live checks use: mongo.spec.mjs, topology.spec.mjs, routing.spec.mjs); the context must
// also be present. Absent the gate the check is simply not registered (task 14.7) and the reporter
// derives its skip record from the catalog; registration happens inside an `if (LIVE)` guard with a
// literal test callee.
const CTX = harnessContext();
const LIVE = process.env.HARNESS_LIVE === '1' && CTX !== null;

if (!LIVE) {
  // Written straight to process.stderr, not console.warn: Jest's default reporter discards the
  // console buffer of a file whose every test skipped, so the reason would otherwise vanish.
  process.stderr.write(
    '[container-split] readiness-log.spec.mjs: no live topology (HARNESS_LIVE!=1 or ' +
      'globalThis.__CONTAINER_SPLIT_HARNESS__ absent). BOOT-CLEAN-21 scans the Auth_Surface boot ' +
      'log window through the observation client, which only reads logs once run.mjs brings the ' +
      'topology up (task 15). Skipping the live scan; the authorization-error decider is still ' +
      'exercised statically.\n',
  );
}

// Register the live boot-log scan ONLY when a live topology is present. Absent it, nothing is
// registered and the reporter derives BOOT-CLEAN-21's `skip` record from the catalog (task 14.7); the
// stderr notice above keeps the run log honest. A literal `test` callee inside the `if (LIVE)` guard
// is what lets eslint's jest plugin recognize the test block.
if (LIVE) {
  describe(`${CHECK_ID}: no authorization error in the Auth_Surface boot log window`, () => {
    test(`[${CHECK_ID}] the Auth_Surface boot log window carries no authorization error (caught-and-logged included)`, async () => {
      const { ok, observation } = await scanBootLog({
        observation: CTX.observation,
        window: CTX.window,
      });
      if (!ok) {
        throw new Error(observation);
      }
      expect(ok).toBe(true);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Static unit exercises for the pure deciders — they run NOW (no topology, no HARNESS_LIVE gate), so
// the authorization-error classification is exercised on every run rather than only once task 15
// stands the topology up. Each asserts both a detected case and a not-detected case so no branch is
// vacuous (Property 6 corollary: the check must not pass vacuously). They carry no [CHECK-ID] tag, so
// the reporter treats them as helper tests rather than catalog checks.
// ---------------------------------------------------------------------------------------------
describe('boot-log authorization-error decider (pure)', () => {
  describe('classifyBootLogAuthorizationError', () => {
    test('a mongod "not authorized" line is detected', () => {
      const line =
        '{"t":{"$date":"2024-01-01T00:00:01Z"},"s":"I","c":"ACCESS","msg":"not authorized on ' +
        'LibreChat to execute command { insert: \\"conversations\\", documents: [ … ] }"}';
      const result = classifyBootLogAuthorizationError(line);
      expect(result.isAuthorizationError).toBe(true);
    });

    test('an "Unauthorized" line is detected', () => {
      expect(
        classifyBootLogAuthorizationError('MongoServerError: Unauthorized').isAuthorizationError,
      ).toBe(true);
    });

    test('a caught MongoServerError with code 13 is detected (the swallowed case)', () => {
      const line =
        'warn: startup task swallowed MongoServerError { code: 13, codeName: Unauthorized }';
      expect(classifyBootLogAuthorizationError(line).isAuthorizationError).toBe(true);
    });

    test('an unrelated boot line is not detected', () => {
      expect(
        classifyBootLogAuthorizationError('info: Server listening on port 3080')
          .isAuthorizationError,
      ).toBe(false);
    });

    test('an unrelated 500 (a bug that is not a grant fault) is not an authorization error', () => {
      expect(
        classifyBootLogAuthorizationError('error: TypeError: cannot read property of undefined')
          .isAuthorizationError,
      ).toBe(false);
    });

    test('a blank or non-string line is not an authorization error', () => {
      expect(classifyBootLogAuthorizationError('').isAuthorizationError).toBe(false);
      expect(classifyBootLogAuthorizationError('   ').isAuthorizationError).toBe(false);
      expect(classifyBootLogAuthorizationError(null).isAuthorizationError).toBe(false);
    });
  });

  describe('collectionNamedIn — the collection the failure observation names (Req 3.2)', () => {
    test('names the collection from a quoted command target', () => {
      expect(
        collectionNamedIn(
          'not authorized on LibreChat to execute command { insert: "conversations" }',
        ),
      ).toBe('conversations');
    });

    test('names the collection from an unquoted command target', () => {
      expect(collectionNamedIn('command find: messages requires authorization')).toBe('messages');
    });

    test('returns null when the line names no collection', () => {
      expect(collectionNamedIn('MongoServerError: Unauthorized')).toBeNull();
    });
  });

  describe('findBootLogAuthorizationError', () => {
    test('returns the first matched line and its collection from a multi-line window', () => {
      const logText = [
        'info: MongoDB connected',
        'info: Server listening on port 3080',
        'error: not authorized on LibreChat to execute command { update: "keys" }',
        'error: not authorized on LibreChat to execute command { insert: "tokens" }',
      ].join('\n');
      const matched = findBootLogAuthorizationError(logText);
      expect(matched).not.toBeNull();
      expect(matched.collection).toBe('keys');
      expect(matched.line).toContain('not authorized');
    });

    test('a clean boot log window returns null', () => {
      const logText = [
        'info: MongoDB connected',
        'info: startup tasks skipped (DISABLE_STARTUP_TASKS)',
        'info: Server listening on port 3080',
        'info: /readyz 200',
      ].join('\n');
      expect(findBootLogAuthorizationError(logText)).toBeNull();
    });

    test('an empty window returns null (never a spurious match)', () => {
      expect(findBootLogAuthorizationError('')).toBeNull();
      expect(findBootLogAuthorizationError('   \n  ')).toBeNull();
    });
  });

  describe('scanBootLog — decides BOOT-CLEAN-21 over an injected observation client', () => {
    // A fake observation client whose `logs` returns scripted text, so the whole decision is
    // exercisable without Docker. It mirrors makeObservationClient's `logs` return shape
    // (`{ status, stdout, stderr }`).
    const fakeObservation = (stdout) => ({
      logs: async () => ({ status: 0, stdout, stderr: '' }),
    });

    test('a clean boot log window passes', async () => {
      const result = await scanBootLog({
        observation: fakeObservation('info: Server listening on port 3080\ninfo: /readyz 200'),
        window: { since: '2024-01-01T00:00:00.000Z' },
      });
      expect(result.ok).toBe(true);
    });

    test('a boot log window with a refusal fails and names the matched line and collection', async () => {
      const result = await scanBootLog({
        observation: fakeObservation(
          'error: not authorized on LibreChat to execute command { insert: "files" }',
        ),
        window: { since: '2024-01-01T00:00:00.000Z' },
      });
      expect(result.ok).toBe(false);
      expect(result.observation).toContain('BOOT-CLEAN-21');
      expect(result.observation).toContain('files');
      expect(result.observation).toContain('Do NOT widen the grant');
    });

    test('reads the boot window scoped to the recorded left edge (since)', async () => {
      let sawSince = null;
      const observation = {
        logs: async (container, opts) => {
          sawSince = opts?.since ?? null;
          return { status: 0, stdout: '', stderr: '' };
        },
      };
      await scanBootLog({ observation, window: { since: '2024-06-01T12:00:00.000Z' } });
      expect(sawSince).toBe('2024-06-01T12:00:00.000Z');
    });
  });
});
