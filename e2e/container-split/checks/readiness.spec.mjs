// readiness.spec.mjs — the two boot-window readiness checks (task 10.1).
//
// Decides `BOOT-READY-20` and `BOOT-API-22`, the readiness half of Property 3 ("Both containers
// boot clean under their own grant", parent P6):
//
//   * BOOT-READY-20 (Req 3.1): the Auth_Surface, booted under the Container_1_Grant, answers
//     `/health`, `/livez` AND `/readyz` with HTTP 200 within 60 seconds.
//   * BOOT-API-22 (Req 3.3): the API_Container, booted under the Container_2_Grant, answers
//     `/livez` AND `/readyz` with HTTP 200 within 60 seconds.
//
// The design (design.md, Property 3) states the property in two halves — the readiness reads here
// and the boot-log authorization-error scan (`BOOT-CLEAN-21` / `BOOT-API-22`'s log clause) in
// readiness-log.spec.mjs, task 10.2. This file owns ONLY the readiness reads; it makes no claim
// about the boot log, so the two files decide disjoint parts of the same property rather than
// restating each other. The catalog carries each id's requirement criteria and property, so the
// titles here name the id and the assertions state the readiness semantics only.
//
// == How this reaches the endpoints ==
// Every read goes through the OBSERVATION client from run.mjs (makeObservationClient). The client
// is baked to the two containers' loopback-published observation addresses by construction — it
// takes no base-address argument and serves only /health, /livez, /readyz — so a readiness check
// physically cannot reach the endpoints any other way, and cannot be turned into an ingress that
// bypasses the Front_Proxy (Req 1.10, Property 11). Each container is named by its compose service
// name, the same key the client is keyed on: `auth-surface` and `api-container`.
//
// Each container boots under its OWN grant and no other — the Auth_Surface under the
// Container_1_Grant, the API_Container under the Container_2_Grant. That is a property of the
// compose file's per-service MONGO_URI (task 6.1), observed here only through the fact that each
// container reaches its readiness endpoints; this file asserts the readiness, not the credential
// wiring (MONGO-URI-19 / MONGO-AUTH-18 own that).
//
// == Live topology is task 15 ==
// The readiness endpoints answer only once run.mjs brings the topology up with Docker and supplies
// the observation client its real `fetch` (task 15). Until then this file must LOAD and be
// STRUCTURALLY VALID under the Layer B Jest config: it imports the observation client, builds the
// poll-until-ready logic, and is discovered by `jest --listTests`. The harness context that hands
// this file a live observation client is the task-15 wiring; absent it, the readiness describe
// blocks self-skip with the reason written to process.stderr (Jest's default reporter discards the
// console buffer of a file whose every test skipped), exactly as the Layer A suites self-skip
// without `mongosh`. The pure polling predicate is exercised inline so this file is not vacuous.
//
// NG1/NG2 hold: this observes the existing image's readiness endpoints through harness-local
// machinery. It adds no application code, no route mount and no HTTP path, and edits neither
// container-split script.

import { makeObservationClient, OBSERVATION_ALLOWED_PATHS } from '../run.mjs';
// The exported constants and pure deciders live in readiness.filter.mjs (a non-spec sibling) so this
// spec file exports nothing (task 14.6). The spec imports what its checks exercise.
import {
  AUTH_SURFACE_READINESS_PATHS,
  API_CONTAINER_READINESS_PATHS,
  READINESS_WINDOW_MS,
  READINESS_POLL_INTERVAL_MS,
  isServing,
  pollUntilServing,
  pollContainerReadiness,
} from './readiness.filter.mjs';
// The profile dimension of the Check Catalog: which checks THIS run's profile selects.
import { checkAppliesToProfile, profileFromEnv } from '../check-catalog.mjs';

// ---------------------------------------------------------------------------------------------
// The live-topology harness context (task 15).
//
// Task 15 brings the topology up and hands this file an observation client wired to real `fetch`.
// The convention it uses is a global the runner sets before invoking Jest; until it lands, the
// global is absent and the readiness describe block is not registered (task 14.7) — the reporter
// derives BOOT-READY-20 / BOOT-API-22's `skip` records from the catalog. The stderr notice below
// keeps a deferred run a LOUD skip in the run log (the same discipline the Layer A suites use for a
// missing `mongosh`, writing the reason to process.stderr) rather than a false pass or a hang against
// an address nothing serves. Kept in the spec (not the filter) because it reads live globalThis
// wiring; the spec exports nothing.
// ---------------------------------------------------------------------------------------------
function liveObservationClient() {
  // Task 15 sets globalThis.__CONTAINER_SPLIT_HARNESS__ = { observation } after bring-up. If a
  // harness context exposes an observation client, use it; otherwise there is no live topology.
  const harness = globalThis.__CONTAINER_SPLIT_HARNESS__;
  if (harness && typeof harness.observation === 'object' && harness.observation !== null) {
    return harness.observation;
  }
  return null;
}

const observation = liveObservationClient();

const LIVE = observation !== null;

// The two checks in this file are classified differently (check-catalog.mjs):
//
//   * BOOT-READY-20 applies to both profiles — the `auth-surface` service IS the single container the
//     collapsed profile runs, and its readiness is a real claim there.
//   * BOOT-API-22 is SPLIT-ONLY. Req 3.3 is about the API_CONTAINER reaching a serving state under the
//     Container_2_Grant, and the collapsed profile runs no such container; polling it would only report
//     that a service the profile deliberately omits does not answer. Reading it as "the single
//     container answers /livez" would restate BOOT-READY-20's observation under another id, which is a
//     vacuous second pass rather than added coverage (Property 6).
const PROFILE = profileFromEnv(process.env);
const API_CONTAINER_SELECTED = checkAppliesToProfile('BOOT-API-22', PROFILE);

if (!LIVE) {
  // Written straight to process.stderr, not console.warn: Jest's default reporter discards the
  // console buffer of a file whose every test skipped, so the reason would otherwise vanish.
  process.stderr.write(
    '[container-split] readiness.spec.mjs: no live topology (globalThis.__CONTAINER_SPLIT_HARNESS__ ' +
      'absent). BOOT-READY-20 and BOOT-API-22 read the loopback observation plane, which only ' +
      'answers once run.mjs brings the topology up (task 15). Skipping the readiness reads; the ' +
      'polling predicate is still exercised statically.\n',
  );
}

// Register the readiness reads ONLY when a live topology is present; absent it, nothing is registered
// and the reporter derives BOOT-READY-20 / BOOT-API-22's `skip` records from the catalog (task 14.7).
// A literal `describe` callee inside the guard is what lets eslint's jest plugin recognize the block.
// The stderr notice above keeps a deferred run a LOUD skip in the run log.
if (LIVE) {
  describe('Property 3: readiness — both containers reach a serving state under their own grant', () => {
    // BOOT-READY-20 (Req 3.1): the Auth_Surface answers /health, /livez and /readyz with 200 within
    // 60s, read through the observation client, booted under the Container_1_Grant.
    test('[BOOT-READY-20] Auth_Surface answers /health, /livez and /readyz with 200 within 60s', async () => {
      const outcomes = await pollContainerReadiness(
        observation,
        'auth-surface',
        AUTH_SURFACE_READINESS_PATHS,
      );
      // Assert on the ready outcome itself: every readiness path served HTTP 200 inside the window.
      expect(outcomes.map((o) => o.path)).toEqual([...AUTH_SURFACE_READINESS_PATHS]);
      expect(outcomes.every((o) => o.ok && o.status === 200)).toBe(true);
    });

    // BOOT-API-22 (Req 3.3): the API_Container answers /livez and /readyz with 200 within 60s, booted
    // under the Container_2_Grant. The boot-log authorization-error clause of Req 3.3 is decided by
    // the log scan in readiness-log.spec.mjs (task 10.2), not here. Registered only under a profile
    // that RUNS an API_Container (split): under `collapsed` the run accounts for this id not at all
    // rather than polling an address no service is listening on.
    if (API_CONTAINER_SELECTED) {
      test('[BOOT-API-22] API_Container answers /livez and /readyz with 200 within 60s', async () => {
        const outcomes = await pollContainerReadiness(
          observation,
          'api-container',
          API_CONTAINER_READINESS_PATHS,
        );
        // Assert on the ready outcome itself: every readiness path served HTTP 200 inside the window.
        expect(outcomes.map((o) => o.path)).toEqual([...API_CONTAINER_READINESS_PATHS]);
        expect(outcomes.every((o) => o.ok && o.status === 200)).toBe(true);
      });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Static, no-topology assertions — so this file is not vacuous while the live reads are deferred to
// task 15. These decide nothing about a running container; they lock the invariants the live checks
// depend on, so a change that would silently break the deferred reads fails now instead.
// ---------------------------------------------------------------------------------------------
describe('[BOOT-READY-20 / BOOT-API-22] readiness check apparatus (static)', () => {
  test('the observation client is constructible with an injected fetch and is baked to the two containers', () => {
    const client = makeObservationClient({
      fetch: async () => ({ status: 200, headers: new Map() }),
    });
    expect(Object.keys(client.baseUrls).sort()).toEqual(['api-container', 'auth-surface']);
  });

  test('every readiness path this file reads is within the observation client’s allowed paths', () => {
    // The client rejects any path outside OBSERVATION_ALLOWED_PATHS at call time; asserting the
    // subset here turns that runtime rejection into a load-time failure if the client's allowed set
    // is ever narrowed below what Req 3.1 / 3.3 require.
    const allPaths = new Set([...AUTH_SURFACE_READINESS_PATHS, ...API_CONTAINER_READINESS_PATHS]);
    for (const path of allPaths) {
      expect(OBSERVATION_ALLOWED_PATHS).toContain(path);
    }
  });

  test('isServing is exactly HTTP 200 — a booting 503 or a wrong-path 404 is not serving', () => {
    expect(isServing(200)).toBe(true);
    expect(isServing(503)).toBe(false);
    expect(isServing(404)).toBe(false);
    expect(isServing(0)).toBe(false);
  });

  test('pollUntilServing resolves ok the first time an endpoint answers 200, within the window', async () => {
    // A scripted endpoint: 503 twice, then 200. A fake clock and no real waits.
    const statuses = [503, 503, 200];
    let call = 0;
    let clock = 0;
    const outcome = await pollUntilServing('/readyz', {
      readOnce: async () => ({ status: statuses[Math.min(call++, statuses.length - 1)] }),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      windowMs: READINESS_WINDOW_MS,
      intervalMs: READINESS_POLL_INTERVAL_MS,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(200);
    expect(outcome.attempts).toBe(3);
  });

  test('pollUntilServing reports the last status seen when the window closes without a 200', async () => {
    // Persistent 503: the window closes, the outcome names the 503 rather than a bare timeout.
    let clock = 0;
    const outcome = await pollUntilServing('/readyz', {
      readOnce: async () => ({ status: 503 }),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      windowMs: 3_000,
      intervalMs: 1_000,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(503);
  });

  test('pollUntilServing keeps polling through a connection failure and reports it if the window closes', async () => {
    let clock = 0;
    const outcome = await pollUntilServing('/livez', {
      readOnce: async () => {
        throw new Error('ECONNREFUSED');
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      windowMs: 2_000,
      intervalMs: 1_000,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBeNull();
    expect(outcome.error).toContain('ECONNREFUSED');
  });
});
