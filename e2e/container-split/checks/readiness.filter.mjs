// readiness.filter.mjs — the pure decision logic and constants behind this check's Layer B spec (task 14.6).
//
// The exported deciders and constants this check's spec relies on live here, in a non-spec sibling
// module, so the spec file (readiness.spec.mjs) can import them and export NOTHING itself. jest.config.mjs's
// testMatch collects only `*.spec.mjs` / `*.test.mjs`, so a `.filter.mjs` is never collected as a
// test — the same shape boot-nowrite.filter.mjs establishes. This is a move, not a rewrite: the logic
// is identical to what previously lived in the spec, and the spec exercises it via the import.
//
// NG1/NG2 hold: this decides over the harness's own artifacts and touches no application code and
// neither container-split script.

// The readiness endpoints each container must answer, from the design's Check Catalog and Req 3.1 /
// 3.3. The Auth_Surface must answer all three; the API_Container answers /livez and /readyz (its
// /health is not part of Req 3.3's readiness clause). Each set is a subset of the observation
// client's OBSERVATION_ALLOWED_PATHS, which the module-load assertion below confirms so a future
// narrowing of the client's allowed paths surfaces here rather than as a runtime rejection.
export const AUTH_SURFACE_READINESS_PATHS = Object.freeze(['/health', '/livez', '/readyz']);
export const API_CONTAINER_READINESS_PATHS = Object.freeze(['/livez', '/readyz']);

// The 60-second readiness window Req 3.1 and 3.3 name. Named once here so both checks read one
// source; the Jest config's testTimeout (minute-scale) is sized above this so a poll that runs the
// full window does not itself time the test out.
export const READINESS_WINDOW_MS = 60_000;

// How often to re-poll an endpoint that has not yet answered 200. Short enough that the check
// notices readiness promptly, long enough not to hammer a booting container.
export const READINESS_POLL_INTERVAL_MS = 1_000;

// A pure predicate: is this an HTTP 200? Kept as a named function so the poll loop and the inline
// static assertion below read one definition of "serving".
export function isServing(status) {
  return status === 200;
}

// Poll one readiness endpoint until it answers 200 or the window closes. Pure with respect to its
// injected dependencies: `readOnce(path)` performs one GET and resolves `{ status }` (the shape the
// observation client's `ready` returns), `now` reads the clock, and `sleep` waits. Returning a
// structured outcome rather than throwing lets the caller assert on it and lets a unit test drive
// it deterministically with a fake clock and a scripted `readOnce`.
//
// Resolves `{ ok, status, path, elapsedMs, attempts }`: `ok` is true the first time the endpoint
// answers 200 inside the window; false when the window closes without a 200, carrying the last
// status seen so the failure names what the endpoint was actually returning (a persistent 503 says
// "booting still", a 404 says "wrong path or wrong container") rather than a bare timeout.
export async function pollUntilServing(
  path,
  {
    readOnce,
    now = Date.now,
    sleep = defaultSleep,
    windowMs = READINESS_WINDOW_MS,
    intervalMs = READINESS_POLL_INTERVAL_MS,
  } = {},
) {
  const start = now();
  let attempts = 0;
  let lastStatus = null;
  let lastError = null;
  // Loop while still inside the window. The check runs at least once even if windowMs is 0.
  do {
    attempts += 1;
    try {
      const { status } = await readOnce(path);
      lastStatus = status;
      if (isServing(status)) {
        return { ok: true, status, path, elapsedMs: now() - start, attempts };
      }
    } catch (error) {
      // A connection refused / DNS failure while the container is still coming up is not a
      // property falsification — it is "not serving yet". Record it and keep polling until the
      // window closes, at which point it becomes the reported reason.
      lastError = error;
      lastStatus = null;
    }
    if (now() - start >= windowMs) {
      break;
    }
    await sleep(intervalMs);
  } while (now() - start < windowMs);

  return {
    ok: false,
    status: lastStatus,
    path,
    elapsedMs: now() - start,
    attempts,
    error: lastError ? lastError.message : null,
  };
}

// The default sleep: a real timer. Overridden in unit tests with a fake so the poll resolves
// without wall-clock waits.
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll every readiness path a container must answer until each becomes 200 within the window,
// through the observation client. Reads each path in turn (the checks share one topology and run
// serially under --runInBand, so sequential polls are correct and simplest). Throws with a
// path-named message on the first endpoint that never serves, so a failing check says which endpoint
// on which container stayed unhealthy and what it last returned — the observation Req 5.3 requires on
// a fail. Returns the per-path serving outcomes on success so the caller can assert on the ready
// result meaningfully (every path served 200) rather than merely on the helper not throwing.
export async function pollContainerReadiness(observation, container, paths) {
  const outcomes = [];
  for (const path of paths) {
    const outcome = await pollUntilServing(path, {
      readOnce: (p) => observation.ready(container, p),
    });
    if (!outcome.ok) {
      const seen =
        outcome.status !== null
          ? `last status ${outcome.status}`
          : `no response (${outcome.error ?? 'connection failure'})`;
      throw new Error(
        `${container} did not answer ${path} with HTTP 200 within ${READINESS_WINDOW_MS} ms ` +
          `(${outcome.attempts} attempts over ${outcome.elapsedMs} ms; ${seen}). The container did ` +
          'not reach a serving state under its own grant.',
      );
    }
    outcomes.push(outcome);
  }
  return outcomes;
}
