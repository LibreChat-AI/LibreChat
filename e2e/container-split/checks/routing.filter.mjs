// routing.filter.mjs — the pure decision logic and constants behind this check's Layer B spec (task 14.6).
//
// The exported deciders and constants this check's spec relies on live here, in a non-spec sibling
// module, so the spec file (routing.spec.mjs) can import them and export NOTHING itself. jest.config.mjs's
// testMatch collects only `*.spec.mjs` / `*.test.mjs`, so a `.filter.mjs` is never collected as a
// test — the same shape boot-nowrite.filter.mjs establishes. This is a move, not a rewrite: the logic
// is identical to what previously lived in the spec, and the spec exercises it via the import.
//
// NG1/NG2 hold: this decides over the harness's own artifacts and touches no application code and
// neither container-split script.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { HARNESS_UPSTREAM_HEADER } from '../run.mjs';

// Native-ESM __dirname (the Layer B jest.config runs these under --experimental-vm-modules with
// transform: {}), kept for parity with the sibling specs even though this file needs no on-disk
// read; it documents that `import.meta` is the supported idiom here rather than a `__dirname` guard.
const HERE = path.dirname(fileURLToPath(import.meta.url));
void HERE;

// The two check ids this spec decides. The reporter parses each from its test title's leading
// `[CHECK-ID]` tag and the serializer looks each up in the Check Catalog for layer / requirements /
// property, so each id is named once here and prefixed onto every title (reporter.mjs: parseCheckId).
export const ROUTE_ALLOW_CHECK_ID = 'ROUTE-ALLOW-27';
export const ROUTE_DEFAULT_CHECK_ID = 'ROUTE-DEFAULT-28';

// The two X-Harness-Upstream values the Caddyfile.split handle blocks set — the allowlist handle
// sets `auth-surface`, the unconditional default handle sets `api-container`. These are also the
// compose service names the observation client's `logs` is keyed on, so the attribution value and
// the log-corroboration target read one source (Caddyfile.split; run.mjs OBSERVATION_BASE_URLS).
export const AUTH_SURFACE_UPSTREAM = 'auth-surface';
export const API_CONTAINER_UPSTREAM = 'api-container';

// ROUTE-ALLOW-27's paths: allowlisted FULL paths, each expected to attribute to the Auth_Surface.
// Transcribed from the design's ROUTE-ALLOW-27 row and the Caddyfile.split Auth_Surface_Allowlist
// WITHOUT re-derivation (NG4) — moving a path between the two sets is a Container_1_Grant recompute
// (Req 2.11), not an edit here. Each `*`-form prefix is exercised at a concrete sub-path (the mount
// the allowlist's `/prefix/*` matcher covers) and the bare prefix is exercised too where the
// allowlist lists both forms, because Caddy's `path` matcher is exact unless it carries `*`.
export const ALLOWLISTED_PATHS = Object.freeze([
  // /api/auth and /api/auth/* — both forms.
  { surface: 'auth (bare)', path: '/api/auth', method: 'GET' },
  { surface: 'auth login', path: '/api/auth/login', method: 'POST' },
  // /oauth and /oauth/* — both forms.
  { surface: 'oauth (bare)', path: '/oauth', method: 'GET' },
  { surface: 'oauth provider', path: '/oauth/google', method: 'GET' },
  // /api/admin/login and /api/admin/login/* — full-path matchers, never the /api/admin prefix.
  { surface: 'admin login (bare)', path: '/api/admin/login', method: 'POST' },
  { surface: 'admin login sub', path: '/api/admin/login/callback', method: 'GET' },
  // /api/admin/oauth and /api/admin/oauth/*.
  { surface: 'admin oauth (bare)', path: '/api/admin/oauth', method: 'GET' },
  { surface: 'admin oauth sub', path: '/api/admin/oauth/callback', method: 'GET' },
  // /api/admin/verify — an exact full path (no wildcard form on the allowlist).
  { surface: 'admin verify', path: '/api/admin/verify', method: 'POST' },
  // /api/user/verify — an exact full path.
  { surface: 'user verify', path: '/api/user/verify', method: 'POST' },
  // Public reads and the proxy-forwarded health path.
  { surface: 'config', path: '/api/config', method: 'GET' },
  { surface: 'banner', path: '/api/banner', method: 'GET' },
  { surface: 'health', path: '/health', method: 'GET' },
]);

// ROUTE-DEFAULT-28's paths: the whole /api/admin DATA family, none on the allowlist, each expected
// to attribute to the API_Container (the unconditional default). This is the load-bearing set: each
// of these returns a working response from a mounted handler, so a prefix misroute would look like
// an application bug, not a routing fault — attribution is the only signal. Transcribed from the
// design's ROUTE-DEFAULT-28 row (config, langfuse, grants, groups, roles, skills, users,
// audit-log). `/api/admin/config` sits deliberately next to the allowlisted `/api/admin/login`: they
// share the `/api/admin` prefix and must partition on the full path, not the prefix.
export const NON_ALLOWLISTED_PATHS = Object.freeze([
  { surface: 'admin config', path: '/api/admin/config', method: 'GET' },
  { surface: 'admin langfuse', path: '/api/admin/langfuse', method: 'GET' },
  { surface: 'admin grants', path: '/api/admin/grants', method: 'GET' },
  { surface: 'admin groups', path: '/api/admin/groups', method: 'GET' },
  { surface: 'admin roles', path: '/api/admin/roles', method: 'GET' },
  { surface: 'admin skills', path: '/api/admin/skills', method: 'GET' },
  { surface: 'admin users', path: '/api/admin/users', method: 'GET' },
  { surface: 'admin audit-log', path: '/api/admin/audit-log', method: 'GET' },
]);

// The caveat every observation carries: these checks decide the load-balancer half of P2/P11 and no
// more (NG6). Named once so both the pass path and the fail path speak with one voice.
export const LOAD_BALANCER_HALF_CAVEAT =
  'This check decides the load-balancer half of the parent P2/P11 only; the full properties also ' +
  'turn on the Auth_Gate admission behavior, which the harness does not stand up (NG6).';

// The characters that CONTINUE a path, so a match that is followed by one of them is a DIFFERENT
// path rather than this one: `/` opens a deeper segment, and the rest are the URI path characters
// that extend the current segment (RFC 3986 unreserved plus the sub-delims that actually occur in a
// request path). Deliberately EXCLUDED, so they read as the end of the path token: `?` and `#` (the
// query and fragment delimiters), whitespace, `"` and `'` (the JSON and quoted-log delimiters), and
// `,` / `;` / `)` — legal in a path in principle, but in log text they delimit, and treating them as
// continuations would lose real lines.
const PATH_CONTINUATION = /[A-Za-z0-9\-._~%!$&*+=:@/]/;

// Whether a captured log line mentions the request path AS A COMPLETE PATH. Pure over the log text,
// so the corroboration is unit-exercisable without a live proxy. Returns the first matching line (for
// the observation) or null when the path does not appear.
//
// == Why a bare `includes` is wrong here ==
// This ran as `line.includes(pathText)` and produced FALSE POSITIVES that inverted the corroboration
// it exists to supply: `/oauth` matched the lines for `/oauth/google`, `/oauth/apple` and
// `/oauth/success`, every one of which the same exercise window contains. So bare `/oauth`'s
// attribution failure reported "Intended container (auth-surface) logged the request: yes" — read as
// a mislabeled header — on the evidence of a DIFFERENT path's request. The distinction the observation
// text promises (a mislabeled header logs on the intended container; a genuine misroute leaves it
// silent) is only as good as this match.
//
// A path matches when the text that follows it cannot be part of the same path: end of line, `?`,
// `#`, whitespace, a quote, or another delimiter (see PATH_CONTINUATION). `/oauth/google` therefore
// does not answer for `/oauth`, while `/oauth?x=1`, `/oauth"` and `/oauth` at end of token all do.
//
// It is used against TWO log shapes and assumes neither: the Caddy JSON access log (where the path
// sits inside `"uri":"/oauth"`) and plain application container logs (where it sits in a request line
// like `GET /oauth 200`). Both are handled by the same character-boundary rule, so nothing here parses
// JSON.
//
// Known looseness, unchanged and deliberate: the match is bounded on the RIGHT only, so a path that is
// a SUFFIX of a longer one still matches (`/health` matches a `/__harness/health` line). Bounding the
// left side would have to reject a preceding path character, which would also reject the legitimate
// `127.0.0.1:3080/health` form that container logs use. The prefix direction is the one that produced
// the wrong answer above; the suffix direction is left as it was rather than traded for false
// negatives.
export function findAccessLogLine(logText, pathText) {
  if (
    typeof logText !== 'string' ||
    logText.trim() === '' ||
    typeof pathText !== 'string' ||
    pathText === ''
  ) {
    return null;
  }
  for (const line of logText.split('\n')) {
    if (mentionsCompletePath(line, pathText)) {
      return line.trim();
    }
  }
  return null;
}

// Whether one line carries `pathText` as a complete path. Scans every occurrence rather than only the
// first, because a line can mention a longer path before the exact one (`"/oauth/google" … "/oauth"`).
function mentionsCompletePath(line, pathText) {
  let from = 0;
  for (;;) {
    const at = line.indexOf(pathText, from);
    if (at === -1) {
      return false;
    }
    const next = line[at + pathText.length];
    if (next === undefined || !PATH_CONTINUATION.test(next)) {
      return true;
    }
    from = at + 1;
  }
}

// Decide one path's attribution against the expected upstream. Pure over its injected clients, so
// the whole per-path decision — the deciding header, plus the two corroborations — is exercisable
// with a fake ingress client and a fake observation client, and reused by the live run (task 15)
// with the real ones.
//
//   * `ingress`     — a makeIngressClient instance; `request({ path, method })` resolves
//                     `{ status, upstream, headers, ... }` where `upstream` is X-Harness-Upstream or
//                     null when the proxy set none.
//   * `observation` — a makeObservationClient instance; `logs(container, { since })` resolves
//                     `{ stdout, stderr, ... }` for one container's `docker compose logs`.
//   * `proxyLogs`   — an optional async `() => ({ stdout })` returning the proxy access log for the
//                     window; when absent, the access-log corroboration is skipped (the header
//                     decides regardless, so its absence weakens the observation but not the verdict).
//   * `entry`       — `{ surface, path, method }`.
//   * `expectedUpstream` — the container this path must be attributed to.
//   * `window`      — `{ since }`, the exercise's left edge, so the log reads are scoped to it.
//
// Returns `{ ok, observation }`. `ok` is true only when the deciding header names the expected
// upstream. On the header disagreeing, the observation carries the three things task 11.3 requires —
// the header value observed, the proxy access-log line, and whether the intended container logged the
// request — so a mislabeled header is distinguished from a genuine misroute. Status is read only to
// enrich the observation and never gates `ok` (Property 7).
export async function decideAttribution({
  ingress,
  observation,
  proxyLogs = null,
  entry,
  expectedUpstream,
  window = {},
}) {
  const { surface, path: pathText, method } = entry;
  const result = await ingress.request({ path: pathText, method });

  // The deciding header. A missing header is an ATTRIBUTION failure (the proxy named no upstream),
  // reported as such rather than silently read as either container.
  if (result.upstream === null) {
    return {
      ok: false,
      observation:
        `${ROUTE_OBSERVATION_PREFIX(expectedUpstream)} ${JSON.stringify(pathText)} (${surface}): ` +
        `no ${HARNESS_UPSTREAM_HEADER} header on the response — the proxy attributed the request ` +
        `to no upstream. Status ${result.status} (not used to decide). ${LOAD_BALANCER_HALF_CAVEAT}`,
    };
  }

  if (result.upstream === expectedUpstream) {
    return { ok: true };
  }

  // The header disagrees — a misroute (or a mislabeled header). Corroborate with the proxy access
  // log and with whether the INTENDED container logged the request, so the observation distinguishes
  // the two. Both reads are best-effort: a corroboration that itself fails to read must not mask the
  // header verdict, so failures there degrade to a note rather than throwing.
  const accessLine = await safeAccessLogLine(proxyLogs, pathText);
  const intendedLogged = await safeContainerLogged(observation, expectedUpstream, pathText, window);

  return {
    ok: false,
    observation:
      `${ROUTE_OBSERVATION_PREFIX(expectedUpstream)} ${JSON.stringify(pathText)} (${surface}): ` +
      `expected ${HARNESS_UPSTREAM_HEADER}=${expectedUpstream} but the proxy attributed it to ` +
      `${JSON.stringify(result.upstream)}. Status ${result.status} (NOT used to decide — both ` +
      'containers mount every route from the same image, so a misroute yields a working handler, a ' +
      '200, or a 500, never a 404). ' +
      `Proxy access log: ${accessLine ?? '(no matching line found)'}. ` +
      `Intended container (${expectedUpstream}) logged the request: ${intendedLogged}. ` +
      'A mislabeled header shows the intended container logging the request while the header names ' +
      'the other; a genuine misroute shows the intended container silent. ' +
      LOAD_BALANCER_HALF_CAVEAT,
  };
}

// The observation prefix, naming the check the expected upstream belongs to so the run report reads
// which of the two checks a failure decided.
function ROUTE_OBSERVATION_PREFIX(expectedUpstream) {
  const id =
    expectedUpstream === AUTH_SURFACE_UPSTREAM ? ROUTE_ALLOW_CHECK_ID : ROUTE_DEFAULT_CHECK_ID;
  return `${id}: path`;
}

// Best-effort proxy access-log corroboration: never throws, so a corroboration read that fails does
// not mask the header verdict. Returns the matching line, a "(no proxy log source)" note when none
// was injected, or a "(proxy log read failed: …)" note on error.
async function safeAccessLogLine(proxyLogs, pathText) {
  if (typeof proxyLogs !== 'function') {
    return '(no proxy log source)';
  }
  try {
    const { stdout } = (await proxyLogs()) ?? {};
    return findAccessLogLine(stdout ?? '', pathText) ?? '(no matching line found)';
  } catch (error) {
    return `(proxy log read failed: ${error.message})`;
  }
}

// Best-effort "did the intended container log this request" corroboration. Returns a human string
// (`'yes'` / `'no'` / a note) rather than a bare boolean so it drops straight into the observation.
async function safeContainerLogged(observation, container, pathText, window) {
  try {
    const { stdout } = (await observation.logs(container, { since: window.since })) ?? {};
    return findAccessLogLine(stdout ?? '', pathText) !== null ? 'yes' : 'no';
  } catch (error) {
    return `(unread: ${error.message})`;
  }
}
