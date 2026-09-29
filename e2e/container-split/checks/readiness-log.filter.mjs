// readiness-log.filter.mjs — the pure decision logic and constants behind this check's Layer B spec (task 14.6).
//
// The exported deciders and constants this check's spec relies on live here, in a non-spec sibling
// module, so the spec file (readiness-log.spec.mjs) can import them and export NOTHING itself. jest.config.mjs's
// testMatch collects only `*.spec.mjs` / `*.test.mjs`, so a `.filter.mjs` is never collected as a
// test — the same shape boot-nowrite.filter.mjs establishes. This is a move, not a rewrite: the logic
// is identical to what previously lived in the spec, and the spec exercises it via the import.
//
// NG1/NG2 hold: this decides over the harness's own artifacts and touches no application code and
// neither container-split script.

// The check id this spec decides. The reporter parses it from each test title's leading [CHECK-ID]
// tag and the serializer looks it up in the Check Catalog for layer/requirements/property, so the id
// is named once here and prefixed onto every title (reporter.mjs: parseCheckId).
export const CHECK_ID = 'BOOT-CLEAN-21';

// The container whose boot log window this check scans. The Auth_Surface is the write-restricted
// container (Container_1_Grant); its boot log is where a refused-and-swallowed operation surfaces.
// It is the same service key `docker compose logs <service>` and the observation client both take.
export const AUTH_SURFACE_CONTAINER = 'auth-surface';

// The authorization-error signature in an Auth_Surface boot log line. mongod phrases a refused
// operation as "not authorized on <db> to execute command" / "Unauthorized"; the application may log
// it as a caught MongoServerError with code 13 (the MongoDB Unauthorized code) even when it swallows
// the error and still reaches /readyz. The matcher is deliberately broad across those phrasings so a
// swallowed refusal cannot slip through on wording, and anchored to authorization specifically so an
// unrelated 500 boot line (a bug that is not a grant fault) does not read as one — the recompute
// guidance is only correct for an actual authorization refusal. This mirrors path-exercise.spec.mjs's
// AUTH_ERROR_PATTERNS so the two log-scan checks classify a line identically.
export const AUTH_ERROR_PATTERNS = Object.freeze([
  /not\s+authorized/i,
  /unauthorized/i,
  /requires\s+authentication/i,
  /\bcode\s*[:=]?\s*13\b/, // MongoDB Unauthorized error code.
  /MongoServerError.*(auth|unauthor)/i,
]);

// The collection a mongod authorization line names, for the failure observation Req 3.2 requires
// ("the matched log line and the collection named in it"). mongod phrases the refusal as
// "not authorized on <db> to execute command { <cmd>: \"<collection>\", … }"; the app's caught log
// often carries the same command document. We pull the first string value that follows a write/read
// command name, and fall back to the `on <db>` clause when no collection is quoted. Returns null when
// the line names no collection — a null does not disqualify the line as an authorization error, it
// only means the observation cannot name the collection.
const COLLECTION_PATTERNS = Object.freeze([
  // { insert: "sessions", … } / { find: "users" } — the command's target is the first quoted value.
  /"(?:insert|update|delete|remove|find|findAndModify|createIndexes|create|drop|dropIndexes|aggregate)"\s*:\s*"([^"]+)"/i,
  // insert: 'sessions' / find: sessions — unquoted command name, quoted-or-bare target.
  /\b(?:insert|update|delete|remove|find|findAndModify|createIndexes|create|drop|dropIndexes|aggregate)\s*:\s*['"]?([A-Za-z0-9_.$-]+)['"]?/i,
]);

export function collectionNamedIn(line) {
  if (typeof line !== 'string') {
    return null;
  }
  for (const pattern of COLLECTION_PATTERNS) {
    const match = pattern.exec(line);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

// Classify a single boot log line. Pure over the line, so the whole judgement is unit-exercisable
// without a live container. Returns `{ isAuthorizationError, line, collection }`: `isAuthorizationError`
// true when the line matches one of the authorization signatures; `collection` is the collection the
// line implicates (or null when it names none). A blank or non-string line is not an authorization
// error.
export function classifyBootLogAuthorizationError(line) {
  if (typeof line !== 'string' || line.trim() === '') {
    return { isAuthorizationError: false, line, collection: null };
  }
  const isAuthorizationError = AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(line));
  return {
    isAuthorizationError,
    line: line.trim(),
    collection: isAuthorizationError ? collectionNamedIn(line) : null,
  };
}

// Scan a captured Auth_Surface boot log window for an authorization error. Pure over the log text.
// Returns the first matched line's classification — `{ line, collection }` — for the observation, or
// null when the window is clean. Splitting on newlines and returning the FIRST match is what makes the
// failure name a concrete line rather than a count, which is the observation Req 3.2 requires.
export function findBootLogAuthorizationError(logText) {
  if (typeof logText !== 'string' || logText.trim() === '') {
    return null;
  }
  for (const rawLine of logText.split('\n')) {
    const classified = classifyBootLogAuthorizationError(rawLine);
    if (classified.isAuthorizationError) {
      return { line: classified.line, collection: classified.collection };
    }
  }
  return null;
}

// The recompute guidance appended to the failure observation, so the run report reads the correct
// response without a second lookup (design.md: "Authorization error during Auth_Surface boot").
// Widening the grant to silence the line is the obvious wrong move, so the message says so.
export function bootCleanGuidance(matched) {
  const where = matched.collection ? `on collection ${JSON.stringify(matched.collection)} ` : '';
  return (
    `BOOT-CLEAN-21: an authorization error appears in the Auth_Surface's boot log window ${where}` +
    `(matched line: ${JSON.stringify(matched.line)}). The Auth_Surface exceeded the ` +
    'Container_1_Grant while booting — a caught-and-logged refusal counts, not only a fatal one. ' +
    "Recompute the Container_1_Grant from the offending path's collection needs, or extend the " +
    "startup-task gate's coverage so the write never runs at boot. Do NOT widen the grant to " +
    'silence the line — that hides the very fault this check exists to surface.'
  );
}

// Decide BOOT-CLEAN-21 over an injected observation client. Pure with respect to its dependencies, so
// the whole decision — read the boot window, scan it, name the matched line and collection — is
// exercisable with a fake observation client whose `logs` returns scripted text, and reused by the
// live run (task 15) with the real one. `observation` is a makeObservationClient instance; `window`
// carries `{ since }` (the boot window's left edge, captureBootStart's ISO timestamp) so the log read
// is scoped to the boot. Returns `{ ok, observation: message }`: `ok` true means the boot log window
// is clean; false carries the guidance the test fails with.
export async function scanBootLog({ observation, window = {} }) {
  const logResult = await observation.logs(AUTH_SURFACE_CONTAINER, { since: window.since });
  const logText = logResult?.stdout ?? '';
  const matched = findBootLogAuthorizationError(logText);
  if (matched !== null) {
    return { ok: false, observation: bootCleanGuidance(matched) };
  }
  return { ok: true };
}
