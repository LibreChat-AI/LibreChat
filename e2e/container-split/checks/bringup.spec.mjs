// checks/bringup.spec.mjs — the bring-up and ingress-exposure checks (task 9.3).
//
// Two Layer B checks, both keyed to the design's Check Catalog (design.md: "## Check Catalog"):
//
//   [TOPO-BRINGUP-16]  Every service in the topology reaches a serving/healthy state within the
//                      300-second bring-up window. This is the CHECK-SIDE counterpart to run.mjs's
//                      TOPO-BRINGUP-16 setup guard (task 7.1): the runner brings the topology up with
//                      `docker compose up --wait --wait-timeout 300` and classifies a service that
//                      never became healthy as a SETUP FAILURE — the topology never came up, so it
//                      has FALSIFIED NOTHING, and no request-level check is admitted (Property 9,
//                      Req 1.11, 1.13). This check reads `docker compose ps --format json` back and
//                      asserts every expected service is running/healthy; on failure the unhealthy
//                      service is NAMED with its log tail, and the outcome is a setup failure rather
//                      than a falsified property.
//
//   [TOPO-INGRESS-17]  Only the Front_Proxy is published on the ingress address (127.0.0.1:8080),
//                      and the API_Container is published on NO external address — reachable from
//                      outside only through the proxy (Req 1.9, 1.10). Asserted from the RESOLVED
//                      PORT BINDINGS (`docker compose ps --format json`), so a future compose edit
//                      that publishes the API_Container on the ingress address, or on any other
//                      external address, FAILS HERE rather than silently making the routing checks
//                      (ROUTE-ALLOW-27 / ROUTE-DEFAULT-28) meaningless — a directly-reachable
//                      API_Container would let request traffic bypass the routed-path partition the
//                      routing checks decide on.
//
// == What runs where ==
// Both observations are Docker facts: the health state Docker resolved for each service and the port
// bindings Docker published. Neither can be decided from `docker compose config` alone — config
// reports the ports the compose file WROTE, not the bindings Docker actually established, and reports
// no health state at all — so both are honestly Layer B checks that need the topology up (task 15
// brings it up and runs them). To keep this spec LOADABLE and structurally valid now (jest.config.mjs
// must discover it; `node --check` must pass), the live Docker reads are behind an injectable `exec`
// that defaults to a real `docker` spawn, and the pure parsing/decision logic below is exercised now
// with SYNTHETIC `docker compose ps` output. The checks are gated on HARNESS_LIVE=1 — the same signal
// the sibling live checks use (topology.spec.mjs, mongo.spec.mjs), which run.mjs sets when it invokes
// Jest against a live topology. Absent it, each check is simply not registered (task 14.7) and the
// run report shows it as `skip` — a record the reporter derives from the catalog for any id with no
// result.
//
// == The observation plane vs. the ingress ==
// The topology publishes exactly one INGRESS address — 127.0.0.1:8080 (INGRESS_BASE_URL), the proxy's
// sole external door — plus a LOOPBACK OBSERVATION PLANE for health/log reads: 127.0.0.1:27019 (mongo,
// for the observer credential), 127.0.0.1:3091 (auth-surface /health,/livez,/readyz) and
// 127.0.0.1:3092 (api-container /livez,/readyz). The observation plane is health/log machinery, NOT
// an ingress (design: the observation-plane rule); TOPO-INGRESS-17's job is precisely to keep the
// API_Container off the ingress address AND off any non-observation external address, so its only
// external publication stays the loopback observation port. That is why the ingress decider
// distinguishes "the ingress address", "a loopback observation address", and "any other external
// address" rather than treating every published port alike.
//
// NG1/NG2 hold: this reads the harness's own topology (ps health + port bindings) and touches no
// application code, no route mount and no HTTP path, and edits neither container-split script. NG6
// holds: no credential validation happens here — these read health states and port bindings.

import { BRINGUP_TIMEOUT_MS } from '../run.mjs';
// The exported constants, the Docker exec seam, the ps-parse and the bring-up / ingress deciders live
// in bringup.filter.mjs (a non-spec sibling) so this spec file exports nothing (task 14.6).
import {
  BRINGUP_WINDOW_MS,
  COMPLETED_SUCCESSFULLY,
  INGRESS_HOST,
  INGRESS_PORT,
  OBSERVATION_ADDRESSES,
  PS_ARGS,
  EXPECTED_COLLAPSED_SERVICES,
  expectedServicesFor,
  proxyServiceFor,
  harnessProfile,
  parseComposePs,
  indexPsByService,
  isServiceUp,
  isProvisionComplete,
  decideBringup,
  decideProvisionGate,
  classifyPublisher,
  decideIngress,
  readPs,
  readProvisionGate,
  readLogTails,
} from './bringup.filter.mjs';
// ---------------------------------------------------------------------------------------------
// The checks. Each test's TITLE starts with its catalog id so reporter.mjs maps the result onto the
// check record. Both need a live topology, so both are gated on HARNESS_LIVE=1 — the same signal the
// sibling live checks (topology.spec.mjs, mongo.spec.mjs) use, which run.mjs sets when it invokes
// Jest against a live topology (task 15). Absent it, neither check is registered (task 14.7); the
// reporter derives a `skip` record from the catalog for any id with no result (serializer.mjs: skip
// requires an observation). Registering a live check only when live — rather than a definition-time
// a definition-time skip — is what makes an unexecuted check leave no test behind to mark, so absence is derived
// rather than announced.
// ---------------------------------------------------------------------------------------------

// A live topology exists only when run.mjs brought it up (task 15). HARNESS_LIVE=1 is the signal;
// without it the live-only checks are not registered rather than failing (Property 9: a topology that
// is not up has falsified nothing).
const LIVE = process.env.HARNESS_LIVE === '1';

// The profile this run is judged under. BOTH checks here are PROFILE-AWARE (check-catalog.mjs selects
// them under `split` and `collapsed` alike): the claims — every service healthy inside the window, only
// the proxy binds the ingress — are meaningful for a one-container topology, so what varies is the
// expected service set and the proxy's service name, passed in per profile rather than branched on
// inside an assertion.
const PROFILE = harnessProfile();

// Register the two live checks ONLY when a live topology is present. Absent it (HARNESS_LIVE unset),
// nothing is registered and the reporter derives TOPO-BRINGUP-16 / TOPO-INGRESS-17's `skip` records
// from the catalog (task 14.7) — a check that did not run leaves no test behind to mark. A literal
// `test` callee inside the `if (LIVE)` guard is what lets eslint's jest plugin recognize the blocks.
// The static ps-parse and ingress deciders in the sibling describe below run regardless.
if (LIVE) {
  describe('two-container topology: bring-up and ingress exposure', () => {
    test('[TOPO-BRINGUP-16] every service is healthy within the bring-up window', async () => {
      const { up, byService } = await readPs();
      // Under the live gate the topology is up; a race that tore it down between the gate and this read
      // is itself a failure worth reporting, not a silent skip.
      expect(up).toBe(true);
      // The compose model's provisioning gate, read for the one case the container record cannot decide:
      // a completed one-shot whose record was swept. `ps -a` above is the primary observation and
      // normally settles it.
      const provisionGate = await readProvisionGate({ profile: PROFILE });
      const decision = decideBringup(byService, { profile: PROFILE, provisionGate });
      // Build the failure observation (reason + each unhealthy service's log tail) ONLY on failure —
      // the log-tail read is a live Docker call worth avoiding on the happy path — but keep the
      // assertion itself unconditional so it is never nested in a branch (design: TOPO-BRINGUP-16
      // names the unhealthy service AND its log tail; reporter.mjs captures this message as the
      // setup-failure observation).
      let message = '';
      if (!decision.ok) {
        const tails = await readLogTails(decision.unhealthy);
        const tailText = Object.entries(tails)
          .map(([service, tail]) => `--- ${service} (log tail) ---\n${tail}`)
          .join('\n');
        message = `${decision.reason}\n${tailText}`;
      }
      // One top-level assertion: empty on a healthy bring-up, the reason-plus-tail message otherwise.
      expect(decision.ok ? '' : message).toBe('');
    });

    test('[TOPO-INGRESS-17] only the Front_Proxy is published on the ingress address; the API_Container is not', async () => {
      const { up, byService } = await readPs();
      expect(up).toBe(true);
      const decision = decideIngress(byService, { profile: PROFILE });
      // The observation on failure is the reason string, which reporter.mjs captures from the Jest
      // failure message and puts on the check record. On pass both sides are the empty string.
      expect(decision.ok ? '' : decision.reason).toBe('');
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Static, no-topology assertions — so this file is not vacuous while the live reads are deferred to
// task 15. These decide nothing about a running container; they exercise the pure ps-parse and
// port-binding deciders over SYNTHETIC docker output, locking the invariants the live checks depend
// on so a change that would silently break the deferred reads fails now instead.
// ---------------------------------------------------------------------------------------------
describe('[TOPO-BRINGUP-16 / TOPO-INGRESS-17] bring-up and ingress deciders (static)', () => {
  // Every decision below is over a SYNTHETIC SPLIT topology, so each names `profile: 'split'`
  // explicitly rather than letting the deciders read HARNESS_PROFILE. These are profile-independent
  // unit tests over pure functions and they run under either profile — judging a split-shaped fixture
  // against the collapsed profile's expected service set would fail them on a healthy collapsed run,
  // for a reason that has nothing to do with the topology. The live checks above pass the RUN's
  // profile; these pass the FIXTURE's.
  const SPLIT = { profile: 'split' };

  // A synthetic `ps` entry with sensible defaults; overrides tailor one service's state or ports.
  const entry = (over = {}) => ({
    Service: 'svc',
    State: 'running',
    Health: 'healthy',
    ExitCode: 0,
    Publishers: [],
    ...over,
  });

  // A well-formed split-profile topology: every long-lived service running+healthy, the proxy on the
  // ingress address, each container on its loopback observation port only, mongod on the observer
  // port, and provision exited(0).
  const healthyPs = () => [
    entry({
      Service: 'mongodb',
      Publishers: [{ URL: '127.0.0.1', PublishedPort: 27019, TargetPort: 27017 }],
    }),
    entry({ Service: 'redis' }),
    entry({ Service: 'meilisearch' }),
    entry({
      Service: 'auth-surface',
      Publishers: [{ URL: '127.0.0.1', PublishedPort: 3091, TargetPort: 3080 }],
    }),
    entry({
      Service: 'api-container',
      Publishers: [{ URL: '127.0.0.1', PublishedPort: 3092, TargetPort: 3080 }],
    }),
    entry({
      Service: 'proxy',
      Publishers: [{ URL: '127.0.0.1', PublishedPort: 8080, TargetPort: 80 }],
    }),
    entry({ Service: 'provision', State: 'exited', Health: '', ExitCode: 0 }),
  ];

  test('parseComposePs tolerates JSONL and a JSON array, and reads empty as no topology', () => {
    const jsonl = '{"Service":"redis","State":"running"}\n{"Service":"proxy","State":"running"}';
    expect(parseComposePs(jsonl).map((e) => e.Service)).toEqual(['redis', 'proxy']);
    const arr = '[{"Service":"redis","State":"running"}]';
    expect(parseComposePs(arr).map((e) => e.Service)).toEqual(['redis']);
    expect(parseComposePs('')).toEqual([]);
    expect(parseComposePs('   ')).toEqual([]);
  });

  test('isServiceUp: running+healthy is up, running+no-healthcheck is up, starting/unhealthy is not', () => {
    expect(isServiceUp({ state: 'running', health: 'healthy' })).toBe(true);
    expect(isServiceUp({ state: 'running', health: '' })).toBe(true);
    expect(isServiceUp({ state: 'running', health: 'starting' })).toBe(false);
    expect(isServiceUp({ state: 'running', health: 'unhealthy' })).toBe(false);
    expect(isServiceUp({ state: 'exited', health: '' })).toBe(false);
    expect(isServiceUp(null)).toBe(false);
  });

  test('isProvisionComplete: exited(0) is complete; running or non-zero exit is not', () => {
    expect(isProvisionComplete({ state: 'exited', exitCode: 0 })).toBe(true);
    expect(isProvisionComplete({ state: 'exited', exitCode: 1 })).toBe(false);
    expect(isProvisionComplete({ state: 'running', exitCode: null })).toBe(false);
    expect(isProvisionComplete(null)).toBe(false);
  });

  test('[TOPO-BRINGUP-16] a fully-healthy split topology passes the bring-up decision', () => {
    const byService = indexPsByService(healthyPs());
    const decision = decideBringup(byService, SPLIT);
    expect(decision.ok).toBe(true);
    expect(decision.unhealthy).toEqual([]);
  });

  test('[TOPO-BRINGUP-16] an unhealthy service is named as a setup failure', () => {
    const ps = healthyPs();
    ps.find((e) => e.Service === 'auth-surface').Health = 'unhealthy';
    const decision = decideBringup(indexPsByService(ps), SPLIT);
    expect(decision.ok).toBe(false);
    expect(decision.unhealthy).toContain('auth-surface');
    expect(decision.reason).toMatch(/auth-surface/);
    expect(decision.reason).toMatch(/SETUP FAILURE/);
    expect(decision.reason).toMatch(/no request-level check/);
  });

  test('[TOPO-BRINGUP-16] a missing service is named', () => {
    const ps = healthyPs().filter((e) => e.Service !== 'redis');
    const decision = decideBringup(indexPsByService(ps), SPLIT);
    expect(decision.ok).toBe(false);
    expect(decision.unhealthy).toContain('redis');
  });

  test('[TOPO-BRINGUP-16] a provision that did not exit 0 is a failure', () => {
    const ps = healthyPs();
    ps.find((e) => e.Service === 'provision').ExitCode = 2;
    const decision = decideBringup(indexPsByService(ps), SPLIT);
    expect(decision.ok).toBe(false);
    expect(decision.unhealthy).toContain('provision');
  });

  test('[TOPO-BRINGUP-16] the ps read passes -a, so a completed one-shot is visible at all', () => {
    // Without `-a`, `docker compose ps` lists only RUNNING containers, so the provisioning one-shot —
    // which has exited 0 by the time the containers are up, exactly as its compose gate requires — was
    // absent from the read and the check reported the grants as never provisioned on a run where
    // provisioning had printed `Done.`.
    expect(PS_ARGS).toContain('-a');
  });

  test('[TOPO-BRINGUP-16] an exited(0) provision completes the bring-up, and a swept record falls back to the compose gate', () => {
    // Case 1: the record is there and says exited(0) — the primary observation.
    expect(decideBringup(indexPsByService(healthyPs()), SPLIT).ok).toBe(true);

    // Case 2: no provision record at all (a swept one-shot), but both containers are up behind a
    // `service_completed_successfully` gate — compose would not have started them otherwise.
    const swept = healthyPs().filter((e) => e.Service !== 'provision');
    const gated = decideBringup(indexPsByService(swept), {
      ...SPLIT,
      provisionGate: { gatedServices: ['auth-surface', 'api-container'] },
    });
    expect(gated.ok).toBe(true);
    // The verdict says which evidence decided it rather than implying it read the container.
    expect(gated.notes.join(' ')).toMatch(new RegExp(COMPLETED_SUCCESSFULLY));

    // Case 3: no record and no gate — nothing vouches for the provisioning run, so it stays a failure.
    const unvouched = decideBringup(indexPsByService(swept), SPLIT);
    expect(unvouched.ok).toBe(false);
    expect(unvouched.unhealthy).toContain('provision');
    expect(unvouched.reason).toMatch(/cannot be shown to have been provisioned/);

    // Case 4: the gate names a service that is NOT up — an inference from a container compose never
    // started proves nothing.
    const notUp = swept.map((e) =>
      e.Service === 'auth-surface' ? { ...e, Health: 'starting' } : e,
    );
    const halfUp = decideBringup(indexPsByService(notUp), {
      ...SPLIT,
      provisionGate: { gatedServices: ['auth-surface'] },
    });
    expect(halfUp.ok).toBe(false);
    expect(halfUp.unhealthy).toContain('provision');
  });

  test('decideProvisionGate reads the gate off the compose model and stops vouching when it is dropped', () => {
    const gated = {
      services: {
        'auth-surface': { depends_on: { provision: { condition: COMPLETED_SUCCESSFULLY } } },
        'api-container': { depends_on: { provision: { condition: COMPLETED_SUCCESSFULLY } } },
      },
    };
    expect(decideProvisionGate(gated, SPLIT).gatedServices).toEqual([
      'auth-surface',
      'api-container',
    ]);

    // A weaker condition is not the gate: `service_started` says nothing about completion.
    const weakened = {
      services: {
        'auth-surface': { depends_on: { provision: { condition: 'service_started' } } },
        'api-container': { depends_on: {} },
      },
    };
    expect(decideProvisionGate(weakened, SPLIT).gatedServices).toEqual([]);
    expect(decideProvisionGate({}, SPLIT).gatedServices).toEqual([]);
  });

  test('the provisioning gate is read for the services the PROFILE runs', () => {
    // Both containers declare the gate under `split`. Under `collapsed` there is no `api-container`, so
    // asking about it would look for a gate on a service the profile does not run — and the bring-up
    // fallback would then find no vouching service on a perfectly healthy collapsed topology.
    const model = {
      services: {
        'auth-surface': { depends_on: { provision: { condition: COMPLETED_SUCCESSFULLY } } },
        'api-container': { depends_on: { provision: { condition: COMPLETED_SUCCESSFULLY } } },
      },
    };
    expect(decideProvisionGate(model, { profile: 'collapsed' }).gatedServices).toEqual([
      'auth-surface',
    ]);
  });

  test('readProvisionGate vouches for nothing when the compose read fails', async () => {
    const failed = await readProvisionGate({
      ...SPLIT,
      exec: async () => ({ status: 1, stdout: '', stderr: 'invalid compose project' }),
    });
    expect(failed.gatedServices).toEqual([]);

    const unparseable = await readProvisionGate({
      ...SPLIT,
      exec: async () => ({ status: 0, stdout: 'not json', stderr: '' }),
    });
    expect(unparseable.gatedServices).toEqual([]);
  });

  test('classifyPublisher: ingress, observation, external and internal are distinguished', () => {
    expect(classifyPublisher({ URL: '127.0.0.1', PublishedPort: 8080 })).toBe('ingress');
    expect(classifyPublisher({ URL: '127.0.0.1', PublishedPort: 3092 })).toBe('observation');
    expect(classifyPublisher({ URL: '127.0.0.1', PublishedPort: 27019 })).toBe('observation');
    expect(classifyPublisher({ URL: '0.0.0.0', PublishedPort: 3080 })).toBe('external');
    expect(classifyPublisher({ URL: '127.0.0.1', PublishedPort: 0 })).toBe('internal');
    expect(classifyPublisher({ PublishedPort: 0 })).toBe('internal');
  });

  test('[TOPO-INGRESS-17] a healthy split topology passes: only the proxy binds the ingress, api-container is loopback-only', () => {
    const decision = decideIngress(indexPsByService(healthyPs()), SPLIT);
    expect(decision.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------------------------
  // The collapsed profile. Both checks are PROFILE-AWARE, so the same deciders must judge a
  // one-container topology by ITS shape: `proxy-collapsed` binds the ingress, there is no
  // `api-container`, and nothing else changes. These tests are what keep the parameterization honest —
  // without them "profile-aware" would be a claim in a comment.
  // ---------------------------------------------------------------------------------------------
  const COLLAPSED = { profile: 'collapsed' };

  // A well-formed collapsed topology: the single reused container on its loopback observation port, the
  // collapsed proxy on the ingress, mongod on the observer port, provision exited(0). No api-container.
  const healthyCollapsedPs = () => [
    entry({
      Service: 'mongodb',
      Publishers: [{ URL: '127.0.0.1', PublishedPort: 27019, TargetPort: 27017 }],
    }),
    entry({ Service: 'redis' }),
    entry({ Service: 'meilisearch' }),
    entry({
      Service: 'auth-surface',
      Publishers: [{ URL: '127.0.0.1', PublishedPort: 3091, TargetPort: 3080 }],
    }),
    entry({
      Service: 'proxy-collapsed',
      Publishers: [{ URL: '127.0.0.1', PublishedPort: 8080, TargetPort: 80 }],
    }),
    entry({ Service: 'provision', State: 'exited', Health: '', ExitCode: 0 }),
  ];

  test('[TOPO-BRINGUP-16] a healthy COLLAPSED topology passes, and is not judged by the split service set', () => {
    const byService = indexPsByService(healthyCollapsedPs());
    expect(decideBringup(byService, COLLAPSED).ok).toBe(true);

    // The same topology against the SPLIT expectations is the failure the harness reported before the
    // profile dimension existed: `api-container` absent from `docker compose ps`.
    const asSplit = decideBringup(byService, SPLIT);
    expect(asSplit.ok).toBe(false);
    expect(asSplit.unhealthy).toContain('api-container');
    expect(expectedServicesFor('collapsed')).toEqual([...EXPECTED_COLLAPSED_SERVICES]);
    expect(expectedServicesFor('collapsed')).not.toContain('api-container');
  });

  test('[TOPO-BRINGUP-16] an unhealthy collapsed service is still named', () => {
    // The claim survives the collapse: a container that never came healthy is a setup failure under
    // either profile, so the check is not weakened by being parameterized.
    const ps = healthyCollapsedPs();
    ps.find((e) => e.Service === 'proxy-collapsed').Health = 'unhealthy';
    const decision = decideBringup(indexPsByService(ps), COLLAPSED);
    expect(decision.ok).toBe(false);
    expect(decision.unhealthy).toContain('proxy-collapsed');
    expect(decision.reason).toMatch(/SETUP FAILURE/);
  });

  test('[TOPO-INGRESS-17] under collapsed the ingress belongs to proxy-collapsed, and a second binder still fails', () => {
    expect(proxyServiceFor('collapsed')).toBe('proxy-collapsed');
    const byService = indexPsByService(healthyCollapsedPs());
    expect(decideIngress(byService, COLLAPSED).ok).toBe(true);

    // The observation that failed before: read against the split profile's proxy name, the collapsed
    // proxy looks like a non-proxy service binding the ingress.
    expect(decideIngress(byService, SPLIT).ok).toBe(false);

    // Still a real check: the single container offering its own ingress door is a failure.
    const doubled = healthyCollapsedPs();
    doubled
      .find((e) => e.Service === 'auth-surface')
      .Publishers.push({
        URL: '127.0.0.1',
        PublishedPort: 8080,
        TargetPort: 3080,
      });
    const decision = decideIngress(indexPsByService(doubled), COLLAPSED);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/auth-surface/);
  });

  test('[TOPO-INGRESS-17] under collapsed a proxy that binds no ingress is still "no ingress door"', () => {
    const ps = healthyCollapsedPs();
    ps.find((e) => e.Service === 'proxy-collapsed').Publishers = [];
    const decision = decideIngress(indexPsByService(ps), COLLAPSED);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/no ingress door/);
  });

  test('[TOPO-INGRESS-17] fails when the API_Container is published on the ingress address', () => {
    const ps = healthyPs();
    // A compose edit that publishes the api-container on the ingress door.
    ps.find((e) => e.Service === 'api-container').Publishers.push({
      URL: '127.0.0.1',
      PublishedPort: 8080,
      TargetPort: 3080,
    });
    const decision = decideIngress(indexPsByService(ps), SPLIT);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/api-container/);
  });

  test('[TOPO-INGRESS-17] fails when the API_Container is published on any other external address', () => {
    const ps = healthyPs();
    // A compose edit that binds the api-container's app port on all interfaces — an external door
    // that is neither the ingress nor a loopback observation address.
    ps.find((e) => e.Service === 'api-container').Publishers.push({
      URL: '0.0.0.0',
      PublishedPort: 3080,
      TargetPort: 3080,
    });
    const decision = decideIngress(indexPsByService(ps), SPLIT);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/api-container/);
    expect(decision.reason).toMatch(/external/);
  });

  test('[TOPO-INGRESS-17] fails when a non-proxy service also binds the ingress address', () => {
    const ps = healthyPs();
    ps.find((e) => e.Service === 'auth-surface').Publishers.push({
      URL: '127.0.0.1',
      PublishedPort: 8080,
      TargetPort: 3080,
    });
    const decision = decideIngress(indexPsByService(ps), SPLIT);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/auth-surface/);
  });

  test('[TOPO-INGRESS-17] fails when the Front_Proxy does not publish the ingress address', () => {
    const ps = healthyPs();
    ps.find((e) => e.Service === 'proxy').Publishers = [];
    const decision = decideIngress(indexPsByService(ps), SPLIT);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/no ingress door/);
  });

  test('the ingress address matches run.mjs INGRESS_BASE_URL, and the observation set is loopback-only', () => {
    expect(INGRESS_HOST).toBe('127.0.0.1');
    expect(INGRESS_PORT).toBe(8080);
    // Every observation address is a loopback address, never the ingress port.
    for (const address of OBSERVATION_ADDRESSES) {
      expect(address.startsWith('127.0.0.1:')).toBe(true);
      expect(address).not.toBe(`${INGRESS_HOST}:${INGRESS_PORT}`);
    }
    // The two container health ports and the mongod observer port are present.
    expect(OBSERVATION_ADDRESSES.has('127.0.0.1:3091')).toBe(true);
    expect(OBSERVATION_ADDRESSES.has('127.0.0.1:3092')).toBe(true);
    expect(OBSERVATION_ADDRESSES.has('127.0.0.1:27019')).toBe(true);
  });

  test('the bring-up window equals run.mjs BRINGUP_TIMEOUT_MS (300s)', () => {
    expect(BRINGUP_WINDOW_MS).toBe(BRINGUP_TIMEOUT_MS);
    expect(BRINGUP_WINDOW_MS).toBe(300_000);
  });
});
