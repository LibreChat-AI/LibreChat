// checks/routing.spec.mjs — the two routing-attribution checks (task 11.3).
//
// Decides the load-balancer half of the routed path partition — and no more:
//
//   * ROUTE-ALLOW-27 (Req 3.10): each allowlisted full path is attributed to the Auth_Surface —
//     `/api/auth/*`, `/oauth/*`, `/api/admin/login/*`, `/api/admin/oauth/*`, `/api/admin/verify`,
//     `/api/user/verify`, `/api/config`, `/api/banner`, `/health`.
//   * ROUTE-DEFAULT-28 (Req 3.11): each non-allowlisted path is attributed to the API_Container,
//     covering the whole `/api/admin` DATA family — `config`, `langfuse`, `grants`, `groups`,
//     `roles`, `skills`, `users`, `audit-log` — because the Auth_Surface is never a default target.
//
// == Property 5 (load-balancer half) and Property 7 (attribution, never status) ==
// Both containers mount every route from the same image, so no status code distinguishes them: a
// misroute yields a working handler, a 200, or a database-layer 500 — never an unmounted-path 404.
// The SPA fallback is the same trap in the other direction (a document route on the wrong container
// serves the same `index.html` via the same `createSpaFallback`). STATUS CODES DECIDE NOTHING HERE
// (design.md, Property 7). The deciding observation is the container's identity, carried by the
// proxy-set `X-Harness-Upstream` response header, corroborated by the proxy access log and by
// whether the intended container logged the request at all.
//
// The header is a RESPONSE header the proxy sets at the edge, inside the same `handle` block that
// picks the upstream (Caddyfile.split), so no client can influence it; an inbound request header of
// the same name lives in a different namespace and reaches the routing decision not at all. `header`
// replaces rather than appends, so the value is the proxy's regardless of what the upstream emitted.
//
// == What a failure reports ==
// A failing check names three things so a mislabeled header is distinguished from a genuine misroute
// (task 11.3 bullet): the header value observed, the proxy access-log line for the request, and
// whether the INTENDED container logged the request at all. The canonical failure this guards is the
// prefix misroute that SUCCEEDS — a rule on the `/api/admin` prefix makes `GET /api/admin/roles`
// land on the Auth_Surface and return 200, because the Auth_Surface's grant holds `roles` read. Every
// status-based check passes; only attribution catches it (design.md: "Proxy prefix misroute that
// succeeds"; NC1). That is why status is read for corroboration only and never decides.
//
// == Scope: the load-balancer half and no more (NG6) ==
// ROUTE-ALLOW-27 and ROUTE-DEFAULT-28 decide the load-balancer half of the parent's P2 and P11 and
// nothing further. The full properties also turn on the Auth_Gate's admission behavior — bearer
// validation, cookie exemptions, crypto at the edge — which the harness does not stand up (NG6). The
// check records say so per check rather than overclaiming; the observation strings below carry the
// same caveat.
//
// == Why this loads now but exercises at task 15 ==
// The live topology exists only once run.mjs brings it up with Docker and supplies the ingress
// client its real `fetch` and the observation client its real `exec` (task 15). Until then there is
// no proxy to reach and no container log to corroborate against, so the request-issuing tests
// SELF-SKIP with a `(skipped: …)` reason the reporter encodes, and the pure attribution decider is
// exercised with static unit tests that run now. The path lists, the expected-upstream mapping and
// the decision logic are all authored and exercised here; only the live fetch and the live log read
// are deferred.
//
// NG1/NG2/NG6 hold: this exercises the existing image through a commodity proxy and reads a
// proxy-set response header and container logs. It adds no application code, no route mount and no
// HTTP path (NG1), edits neither container-split script (NG2), and performs no credential validation
// of any kind — the proxy does not emulate the Auth_Gate (NG6).

import { makeIngressClient, makeObservationClient, HARNESS_UPSTREAM_HEADER } from '../run.mjs';
// The exported constants and pure deciders live in routing.filter.mjs (a non-spec sibling) so this
// spec file exports nothing (task 14.6). The spec imports what its checks exercise.
import {
  ROUTE_ALLOW_CHECK_ID,
  ROUTE_DEFAULT_CHECK_ID,
  AUTH_SURFACE_UPSTREAM,
  API_CONTAINER_UPSTREAM,
  ALLOWLISTED_PATHS,
  NON_ALLOWLISTED_PATHS,
  findAccessLogLine,
  decideAttribution,
} from './routing.filter.mjs';
// The profile dimension of the Check Catalog: which checks THIS run's profile selects.
import { checkAppliesToProfile, profileFromEnv } from '../check-catalog.mjs';

// Read the harness context task 15's runner populates before invoking Jest: the live ingress client
// (fetch reaching the running Front_Proxy), the live observation client (exec reading running-
// container logs), an optional proxy-log reader, and the exercise window. When it is absent — a plain
// `jest`/`--listTests` invocation with no topology up — the request-issuing tests self-skip, so the
// file is structurally valid and discoverable without standing anything up. Accepts either ready-made
// clients or the primitives to build them, matching the sibling specs.
function harnessContext() {
  const ctx = globalThis.__CONTAINER_SPLIT_HARNESS__;
  if (!ctx || typeof ctx !== 'object') {
    return null;
  }
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
  const proxyLogs = resolveProxyLogs(ctx);
  return { ingress, observation, proxyLogs, window: ctx.window ?? {} };
}

// The proxy access-log reader: a ready-made `proxyLogs` from the harness context (jest.setup.mjs
// publishes one, built over the same COMPOSE_FILE-aware exec the observation client gets), or one
// built from a bare `ctx.exec`, or null when neither is available (the header still decides; only the
// access-log corroboration is then unavailable). Split out of harnessContext to keep that function
// free of a nested ternary.
//
// The service is `proxy`, the compose service name of the Front_Proxy (compose.harness.yml). It read
// `front-proxy` before — a name that exists only as a SetupFailure label in run.mjs and matches no
// compose service, so the fallback read nothing.
function resolveProxyLogs(ctx) {
  if (typeof ctx.proxyLogs === 'function') {
    return ctx.proxyLogs;
  }
  if (typeof ctx.exec === 'function') {
    return async () => ctx.exec('docker', ['compose', 'logs', '--no-color', 'proxy']);
  }
  return null;
}

// Live gate. HARNESS_LIVE=1 is set by task 15's runner alongside the harness context; without it the
// live tests are simply not registered (task 14.7) and the reporter derives their skip records from
// the catalog. Registration happens inside an `if (LIVE)` guard with a literal `it` callee.
const CTX = harnessContext();

// Both checks here are SPLIT-ONLY (check-catalog.mjs), and for two different reasons worth keeping
// straight:
//
//   * ROUTE-DEFAULT-28 would be FALSE under `collapsed` on a topology behaving exactly as designed:
//     `Caddyfile.collapsed` is one unconditional upstream, so a non-allowlisted path attributes to
//     `auth-surface` — the collapse working, not a misroute.
//   * ROUTE-ALLOW-27 would be VACUOUSLY TRUE there, which is worse. With one unconditional upstream
//     EVERY path attributes to the Auth_Surface, so "each allowlisted path attributes to the
//     Auth_Surface" holds no matter what the allowlist says — it would stay green with the allowlist
//     emptied or the partition inverted. A vacuous pass reads as evidence that the routed-path partition
//     was decided (Property 6), so the collapsed run does not claim it at all.
//
// The gate therefore asks the catalog rather than only the topology.
const PROFILE = profileFromEnv(process.env);
const SELECTED =
  checkAppliesToProfile('ROUTE-ALLOW-27', PROFILE) &&
  checkAppliesToProfile('ROUTE-DEFAULT-28', PROFILE);
const LIVE = process.env.HARNESS_LIVE === '1' && CTX !== null && SELECTED;

if (!LIVE && SELECTED) {
  // Written straight to process.stderr, not console.warn: Jest's default reporter discards the
  // console buffer of a file whose every test skipped, so the reason would otherwise vanish.
  process.stderr.write(
    '[container-split] routing.spec.mjs: no live topology (HARNESS_LIVE!=1 or ' +
      'globalThis.__CONTAINER_SPLIT_HARNESS__ absent). ROUTE-ALLOW-27 and ROUTE-DEFAULT-28 issue ' +
      'requests through the Front_Proxy ingress, which only answers once run.mjs brings the topology ' +
      'up (task 15). Skipping the attribution reads; the pure decider is exercised statically.\n',
  );
}

if (!SELECTED) {
  // A different statement from "no topology", and it must not read as a deferred check: this profile
  // does not select these ids, so the run accounts for neither, and nothing is missing from it.
  process.stderr.write(
    `[container-split] routing.spec.mjs: profile "${PROFILE}" does not select ROUTE-ALLOW-27 or ` +
      'ROUTE-DEFAULT-28. Its proxy has ONE unconditional upstream, so there is no routed-path ' +
      'partition to decide: ROUTE-DEFAULT-28 would be false on a correctly collapsed topology and ' +
      'ROUTE-ALLOW-27 would pass vacuously. The split run decides both at full strength.\n',
  );
}

// Register the live attribution checks ONLY when a live topology is present. Absent it, no live test
// is registered and the reporter derives ROUTE-ALLOW-27 / ROUTE-DEFAULT-28's `skip` records from the
// catalog (task 14.7); the stderr notice above keeps the run log honest. A literal `it` callee inside
// the `if (LIVE)` guard is what lets eslint's jest plugin recognize the test blocks.
if (LIVE) {
  describe(`${ROUTE_ALLOW_CHECK_ID}: each allowlisted full path is attributed to the Auth_Surface`, () => {
    for (const entry of ALLOWLISTED_PATHS) {
      // The title starts with a LITERAL `[ROUTE-ALLOW-27]` tag (not the `${ROUTE_ALLOW_CHECK_ID}`
      // interpolation) so jest/valid-title can read the leading string and reporter.mjs's parseCheckId
      // regex still matches; the per-entry surface/method/path is concatenated on so each path stays
      // its own `it`.
      it(
        '[ROUTE-ALLOW-27] attributes ' +
          entry.surface +
          ' (' +
          entry.method +
          ' ' +
          entry.path +
          ') to the Auth_Surface',
        async () => {
          const { ok, observation } = await decideAttribution({
            ingress: CTX.ingress,
            observation: CTX.observation,
            proxyLogs: CTX.proxyLogs,
            entry,
            expectedUpstream: AUTH_SURFACE_UPSTREAM,
            window: CTX.window,
          });
          if (!ok) {
            throw new Error(observation);
          }
          expect(ok).toBe(true);
        },
      );
    }
  });

  describe(`${ROUTE_DEFAULT_CHECK_ID}: each non-allowlisted path is attributed to the API_Container`, () => {
    for (const entry of NON_ALLOWLISTED_PATHS) {
      // Literal `[ROUTE-DEFAULT-28]` tag prefix (not the `${ROUTE_DEFAULT_CHECK_ID}` interpolation) so
      // jest/valid-title reads the leading string and reporter.mjs's parseCheckId regex still matches;
      // the per-entry surface/method/path is concatenated on so each path stays its own `it`.
      it(
        '[ROUTE-DEFAULT-28] attributes ' +
          entry.surface +
          ' (' +
          entry.method +
          ' ' +
          entry.path +
          ') to the API_Container',
        async () => {
          const { ok, observation } = await decideAttribution({
            ingress: CTX.ingress,
            observation: CTX.observation,
            proxyLogs: CTX.proxyLogs,
            entry,
            expectedUpstream: API_CONTAINER_UPSTREAM,
            window: CTX.window,
          });
          if (!ok) {
            throw new Error(observation);
          }
          expect(ok).toBe(true);
        },
      );
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Static, no-topology assertions — so this file is not vacuous while the live reads are deferred to
// task 15. These decide nothing about a running container; they lock the invariants the live checks
// depend on (Property 7: attribution decides, status never does), so a change that would silently
// break the deferred reads fails now instead.
// ---------------------------------------------------------------------------------------------
describe('[ROUTE-ALLOW-27 / ROUTE-DEFAULT-28] routing attribution decider (static)', () => {
  // A fake ingress client keyed by path -> the upstream the proxy would attribute, so the decider is
  // driven without a live proxy. Status is a fixed 200 for every path to prove it never gates `ok`.
  function fakeIngress(attributionByPath) {
    return {
      async request({ path: p }) {
        const upstream = Object.prototype.hasOwnProperty.call(attributionByPath, p)
          ? attributionByPath[p]
          : null;
        return { status: 200, upstream, headers: new Map() };
      },
    };
  }

  // A fake observation client whose `logs` returns whatever text the test scripts for a container.
  function fakeObservation(logsByContainer = {}) {
    return {
      async logs(container) {
        return { status: 0, stdout: logsByContainer[container] ?? '', stderr: '' };
      },
    };
  }

  test('passes when the header names the expected upstream — for both checks', async () => {
    const ingress = fakeIngress({
      '/api/config': AUTH_SURFACE_UPSTREAM,
      '/api/admin/roles': API_CONTAINER_UPSTREAM,
    });
    const observation = fakeObservation();

    const allow = await decideAttribution({
      ingress,
      observation,
      entry: { surface: 'config', path: '/api/config', method: 'GET' },
      expectedUpstream: AUTH_SURFACE_UPSTREAM,
    });
    expect(allow.ok).toBe(true);

    const dflt = await decideAttribution({
      ingress,
      observation,
      entry: { surface: 'admin roles', path: '/api/admin/roles', method: 'GET' },
      expectedUpstream: API_CONTAINER_UPSTREAM,
    });
    expect(dflt.ok).toBe(true);
  });

  test('fails on the prefix misroute that succeeds — /api/admin/roles attributed to the Auth_Surface (NC1)', async () => {
    // The highest-value control: the request returns 200 (route mounted, grant holds roles read), so
    // every status-based check passes. Only the header catches it. The observation must name the
    // header value, the proxy access line, and whether the intended container logged the request.
    const ingress = fakeIngress({ '/api/admin/roles': AUTH_SURFACE_UPSTREAM });
    const observation = fakeObservation({
      // The intended container (api-container) is SILENT — the request never reached it.
      [API_CONTAINER_UPSTREAM]: 'some unrelated boot line\n',
    });
    const proxyLogs = async () => ({
      stdout:
        '{"request":{"uri":"/api/admin/roles"},"resp_headers":{"X-Harness-Upstream":["auth-surface"]}}',
    });

    const result = await decideAttribution({
      ingress,
      observation,
      proxyLogs,
      entry: { surface: 'admin roles', path: '/api/admin/roles', method: 'GET' },
      expectedUpstream: API_CONTAINER_UPSTREAM,
      window: {},
    });

    expect(result.ok).toBe(false);
    expect(result.observation).toContain('/api/admin/roles');
    expect(result.observation).toContain(`${HARNESS_UPSTREAM_HEADER}=${API_CONTAINER_UPSTREAM}`);
    expect(result.observation).toContain(AUTH_SURFACE_UPSTREAM); // the header value observed
    expect(result.observation).toContain('Proxy access log:');
    expect(result.observation).toContain(
      `Intended container (${API_CONTAINER_UPSTREAM}) logged the request: no`,
    );
    // Status is 200 and must be reported as NOT deciding.
    expect(result.observation).toContain('NOT used to decide');
  });

  test('status never gates the verdict — a 500 with the right header still passes, a 200 with the wrong header still fails', async () => {
    // Right header, bad status: pass. Both containers can 500 on a mounted handler, so status must
    // not turn a correctly-attributed request into a failure.
    const ingress500 = {
      async request() {
        return { status: 500, upstream: AUTH_SURFACE_UPSTREAM, headers: new Map() };
      },
    };
    const pass = await decideAttribution({
      ingress: ingress500,
      observation: fakeObservation(),
      entry: { surface: 'auth login', path: '/api/auth/login', method: 'POST' },
      expectedUpstream: AUTH_SURFACE_UPSTREAM,
    });
    expect(pass.ok).toBe(true);

    // Wrong header, good status: fail.
    const ingress200Wrong = {
      async request() {
        return { status: 200, upstream: API_CONTAINER_UPSTREAM, headers: new Map() };
      },
    };
    const fail = await decideAttribution({
      ingress: ingress200Wrong,
      observation: fakeObservation(),
      entry: { surface: 'auth login', path: '/api/auth/login', method: 'POST' },
      expectedUpstream: AUTH_SURFACE_UPSTREAM,
    });
    expect(fail.ok).toBe(false);
  });

  test('a missing X-Harness-Upstream header is an attribution failure, not either container', async () => {
    const ingress = fakeIngress({}); // no path mapped -> upstream null
    const result = await decideAttribution({
      ingress,
      observation: fakeObservation(),
      entry: { surface: 'banner', path: '/api/banner', method: 'GET' },
      expectedUpstream: AUTH_SURFACE_UPSTREAM,
    });
    expect(result.ok).toBe(false);
    expect(result.observation).toContain(`no ${HARNESS_UPSTREAM_HEADER} header`);
  });

  test('findAccessLogLine returns the first line mentioning the path, or null', () => {
    const log = 'line one /api/config\nline two /api/banner\n';
    expect(findAccessLogLine(log, '/api/banner')).toBe('line two /api/banner');
    expect(findAccessLogLine(log, '/api/admin/roles')).toBeNull();
    expect(findAccessLogLine('', '/api/config')).toBeNull();
    expect(findAccessLogLine(null, '/api/config')).toBeNull();
  });

  test('a path does not match a LONGER path that starts with it — the JSON access log shape', () => {
    // The defect this guards: `/oauth` read as present on the strength of `/oauth/google`'s line. The
    // same exercise window carries lines for /oauth/google, /oauth/apple and /oauth/success, so a
    // prefix match made "the intended container logged the request" answer about a different request.
    const caddyLog = [
      '{"level":"info","request":{"method":"GET","uri":"/oauth/google"},"resp_headers":{"X-Harness-Upstream":["auth-surface"]}}',
      '{"level":"info","request":{"method":"GET","uri":"/oauth/success"},"resp_headers":{"X-Harness-Upstream":["auth-surface"]}}',
    ].join('\n');
    expect(findAccessLogLine(caddyLog, '/oauth')).toBeNull();
    expect(findAccessLogLine(caddyLog, '/oauth/google')).toContain('"/oauth/google"');

    // The bare path, once it really is requested, matches on the quote boundary — and is not confused
    // by the longer path appearing on the same line before it.
    const withBare =
      caddyLog +
      '\n{"level":"info","request":{"method":"GET","uri":"/oauth"},"resp_headers":{"X-Harness-Upstream":["api-container"]}}';
    expect(findAccessLogLine(withBare, '/oauth')).toContain('"uri":"/oauth"');
    expect(
      findAccessLogLine('{"request":{"uri":"/oauth/google"},"referer":"/oauth"}', '/oauth'),
    ).toBe('{"request":{"uri":"/oauth/google"},"referer":"/oauth"}');
  });

  test('a path does not match a LONGER path that starts with it — the plain container log shape', () => {
    // The same rule against the other shape this function is used on (safeContainerLogged reads plain
    // `docker compose logs` output, which is not JSON), so nothing here may assume JSON.
    const containerLog = [
      '2026-09-25 12:49:01 info: GET /oauth/apple 302 3ms',
      '2026-09-25 12:49:02 warn: passport strategy google not registered for /oauth/google',
    ].join('\n');
    expect(findAccessLogLine(containerLog, '/oauth')).toBeNull();
    expect(findAccessLogLine(containerLog, '/oauth/apple')).toBe(
      '2026-09-25 12:49:01 info: GET /oauth/apple 302 3ms',
    );

    // A query string, a fragment, a trailing quote and end-of-line all END the path, so each still
    // answers for the bare path; a deeper segment does not.
    expect(findAccessLogLine('GET /oauth?state=x 302', '/oauth')).toBe('GET /oauth?state=x 302');
    expect(findAccessLogLine('GET /oauth#frag 302', '/oauth')).toBe('GET /oauth#frag 302');
    expect(findAccessLogLine('target="/oauth" served', '/oauth')).toBe('target="/oauth" served');
    expect(findAccessLogLine('the request was /oauth', '/oauth')).toBe('the request was /oauth');
    expect(findAccessLogLine('GET /oauthx 404', '/oauth')).toBeNull();
    // The same partition one level down: /api/admin/login must not answer for /api/admin/login/local.
    expect(findAccessLogLine('POST /api/admin/login/local 429', '/api/admin/login')).toBeNull();
  });

  test('the allowlisted set attributes to auth-surface and the default set to api-container, and the two sets are disjoint', () => {
    // A drift guard: no path may sit in both sets, and the /api/admin data family (the prefix-misroute
    // trap) is entirely in the default set while /api/admin/login stays allowlisted.
    const allow = new Set(ALLOWLISTED_PATHS.map((e) => e.path));
    const dflt = new Set(NON_ALLOWLISTED_PATHS.map((e) => e.path));
    for (const p of allow) {
      expect(dflt.has(p)).toBe(false);
    }
    expect(allow.has('/api/admin/login')).toBe(true);
    expect(dflt.has('/api/admin/config')).toBe(true);
    expect(dflt.has('/api/admin/roles')).toBe(true);
  });

  test('every attribution decision carries the load-balancer-half caveat (NG6)', async () => {
    const ingress = fakeIngress({ '/api/config': API_CONTAINER_UPSTREAM }); // wrong on purpose
    const result = await decideAttribution({
      ingress,
      observation: fakeObservation(),
      entry: { surface: 'config', path: '/api/config', method: 'GET' },
      expectedUpstream: AUTH_SURFACE_UPSTREAM,
    });
    expect(result.observation).toContain('load-balancer half');
    expect(result.observation).toContain('NG6');
  });
});
