// bringup.filter.mjs — the pure decision logic and Docker exec seam behind TOPO-BRINGUP-16 and
// TOPO-INGRESS-17 (task 9.3).
//
// The bring-up and ingress-exposure checks' whole judgement — the `docker compose ps` parse, the
// per-service up/complete predicates, the bring-up and ingress deciders, and the thin live-read
// wrappers over an injectable exec seam — lives here as pure functions and frozen constants,
// importable and exercisable without Jest. The spec (bringup.spec.mjs) imports these, keeps its
// HARNESS_LIVE gate and its Jest registrations local, and exports nothing itself (task 14.6). This
// follows the discipline boot-nowrite.filter.mjs sets: the pure decision lives in a non-spec sibling
// so importing it never re-registers a `describe`/`test`, and jest.config.mjs's testMatch
// (`*.spec.mjs` / `*.test.mjs`) does not collect a `.filter.mjs`.
//
// NG1/NG2/NG6 hold: this reads the harness's own topology and touches no application code, no route
// mount, no HTTP path, and neither container-split script; no credential validation happens here.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';

import { BRINGUP_TIMEOUT_MS, INGRESS_BASE_URL, OBSERVATION_BASE_URLS } from '../run.mjs';
// The profile reader, from the module that owns the profile dimension of the Check Catalog. The
// expected service set and the proxy's service name below are keyed on the same profile names the
// catalog selects check ids with, so a run cannot judge one topology against another's shape.
import { profileFromEnv } from '../check-catalog.mjs';

const execFileAsync = promisify(execFile);

// This file's own directory, resolved from `import.meta.url`. The Layer B Jest config loads .mjs as
// native ES modules (jest.config.mjs: no babel-to-CommonJS transform), so `import.meta` is valid here
// under Jest exactly as it is under `node` — the same runtime run.mjs and reporter.mjs resolve their
// directories in. `__dirname` does not exist under native ESM, so it is deliberately not used.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// The harness compose file lives one level up from checks/ (e2e/container-split/compose.harness.yml).
// Bound absolutely so a `docker compose` read observes the same topology regardless of the cwd the
// suite runs from.
const COMPOSE_FILE = path.join(HERE, '..', 'compose.harness.yml');

// The compose service names that must all be healthy in the split profile within the bring-up window.
// These are the service keys in compose.harness.yml (`profiles: ["split", …]` or `["split"]`) — the
// same names `docker compose ps` reports under `Service`.
export const EXPECTED_SPLIT_SERVICES = Object.freeze([
  'mongodb',
  'redis',
  'meilisearch',
  'auth-surface',
  'api-container',
  'proxy',
]);

// The same set for the collapsed profile, read off compose.harness.yml's `profiles:` lists: the
// collapsed profile substitutes `proxy-collapsed` for `proxy` and runs NO `api-container` (the single
// reused container is the `auth-surface` service under an env overlay). Everything else is shared.
//
// TOPO-BRINGUP-16 is PROFILE-AWARE rather than split-only (check-catalog.mjs): "the topology came up
// healthy within the window, and provisioning completed before any container started" is a real claim
// about a one-container topology too — it is the whole question task 15.5 exists to answer — so the
// expected SERVICE SET is parameterized here instead of the check being dropped or an assertion
// branching on a container name.
export const EXPECTED_COLLAPSED_SERVICES = Object.freeze([
  'mongodb',
  'redis',
  'meilisearch',
  'auth-surface',
  'proxy-collapsed',
]);

// Profile -> the services that must be healthy. One table, so a compose edit that adds a service to a
// profile has one place to be recorded.
export const EXPECTED_SERVICES_BY_PROFILE = Object.freeze({
  split: EXPECTED_SPLIT_SERVICES,
  collapsed: EXPECTED_COLLAPSED_SERVICES,
});

// Profile -> the Front_Proxy's compose service name. The collapsed profile's proxy is a DIFFERENT
// SERVICE (`proxy-collapsed`, `Caddyfile.collapsed`, same published ingress address), which is why
// TOPO-INGRESS-17 failed under `collapsed` reporting that the ingress was "published by
// proxy-collapsed, not only by the Front_Proxy (proxy)" — a correct observation of the wrong expected
// name. jest.setup.mjs keys its proxy log reader on the same mapping.
export const PROXY_SERVICE_BY_PROFILE = Object.freeze({
  split: 'proxy',
  collapsed: 'proxy-collapsed',
});

// The harness profile this process runs under, from the environment the runner annotates. Resolved
// through the Check Catalog's reader so every consumer — the catalog's own id selection, the reporter,
// and these checks — reads one name from one place.
export function harnessProfile(env = process.env) {
  return profileFromEnv(env);
}

// The services a profile expects to be healthy. Falls back to the split set for an unrecognized
// profile, which `harnessProfile` cannot produce; the parameter exists so a test can name a profile
// directly.
export function expectedServicesFor(profile = harnessProfile()) {
  return EXPECTED_SERVICES_BY_PROFILE[profile] ?? EXPECTED_SPLIT_SERVICES;
}

// The Front_Proxy service name for a profile, same fallback and for the same reason.
export function proxyServiceFor(profile = harnessProfile()) {
  return PROXY_SERVICE_BY_PROFILE[profile] ?? PROXY_SERVICE_BY_PROFILE.split;
}

// The one-shot provisioning service. It runs to completion and exits BEFORE the containers start
// (compose depends_on: service_completed_successfully), so at the point the bring-up check reads
// `ps` it is expected to be `exited (0)`, not `running`. Named apart from the long-lived services so
// the bring-up decider judges it by successful completion rather than by a running/healthy state.
export const PROVISION_SERVICE = 'provision';

// The bring-up window, from run.mjs (Req 1.11 / 1.13): `docker compose up --wait --wait-timeout 300`.
// Re-exported through the shared constant so this check and the runner's setup guard read one number
// rather than two literals that could drift.
export const BRINGUP_WINDOW_MS = BRINGUP_TIMEOUT_MS;

// The sole ingress address the Front_Proxy publishes (compose.harness.yml: `127.0.0.1:8080:80`),
// derived from run.mjs's INGRESS_BASE_URL so the check and the ingress client name one address. The
// host and port are what a port binding must match to count as "published on the ingress".
const INGRESS_URL = new URL(INGRESS_BASE_URL);
export const INGRESS_HOST = INGRESS_URL.hostname; // 127.0.0.1
export const INGRESS_PORT = Number(INGRESS_URL.port); // 8080

// The loopback observation-plane host:port pairs that are LEGITIMATE external publications — the
// health/log machinery, not ingresses (design: the observation-plane rule). Built from run.mjs's
// OBSERVATION_BASE_URLS (the two containers' loopback health addresses, 3091 / 3092) plus the mongod
// observer port (27019, compose.harness.yml). A published binding on one of these is expected and
// must NOT count as an ingress exposure; anything else external does.
export const OBSERVATION_ADDRESSES = Object.freeze(
  buildObservationAddresses(OBSERVATION_BASE_URLS),
);

// Assemble the allowed loopback observation addresses as a set of `host:port` strings. Kept pure so a
// test can build the same set from a synthetic OBSERVATION_BASE_URLS without importing the runner.
export function buildObservationAddresses(observationBaseUrls) {
  const addresses = new Set();
  for (const url of Object.values(observationBaseUrls)) {
    const parsed = new URL(url);
    addresses.add(`${parsed.hostname}:${parsed.port}`);
  }
  // The mongod observer plane (compose.harness.yml: `127.0.0.1:27019:27017`) — health/observation
  // only, deliberately not 27017/27018. Not in OBSERVATION_BASE_URLS (those are the HTTP health
  // addresses), so add it here so the ingress decider does not misread it as an off-ingress exposure.
  addresses.add('127.0.0.1:27019');
  return addresses;
}

// ---------------------------------------------------------------------------------------------
// The live Docker exec seam.
//
// A single injectable command runner isolates every Docker touch, so the parsing and comparison
// logic below is pure and unit-exercisable without Docker, and task 15 runs the same code against a
// live topology. The default runner spawns real `docker` with argv (execFile, not a shell string),
// so a value interpolated into an argument cannot be re-parsed as a shell token — there is no shell.
// It returns `{ status, stdout, stderr }` the way the runner's own classifiers expect, mapping a
// non-zero exit to a captured status rather than throwing, so a caller decides what a failure means.
// ---------------------------------------------------------------------------------------------
export async function defaultDockerExec(args) {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      // `ps --format json` for a handful of services is a few KB; a log tail is bounded below.
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    // execFile rejects on a non-zero exit or a missing binary. Surface both as a captured result so
    // the caller can classify "no topology" (skip) vs. "topology up but a service is unhealthy"
    // (fail as a setup failure).
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error.message ?? error),
    };
  }
}

// The `docker compose -f <file> ps -a --format json` argv. `-f COMPOSE_FILE` binds the read to the
// harness compose file regardless of the cwd the suite runs from, so a check run from the repo root
// and one run from e2e/container-split observe the same topology.
//
// `-a` is load-bearing, and its absence was this check's first live failure. Plain `ps` lists RUNNING
// containers only. The provisioning service is a one-shot: by the time the containers are up it has
// run to completion and EXITED 0 — which is precisely the state the compose
// `depends_on: service_completed_successfully` gate requires — so a plain `ps` omitted it and the
// check reported `provision (absent — the grants were never provisioned)` about a stage that had
// demonstrably succeeded and printed `Done.` seconds earlier. With `-a` the completed container is
// visible and "exited 0 having completed" is distinguishable from "never ran".
export const PS_ARGS = Object.freeze([
  'compose',
  '-f',
  COMPOSE_FILE,
  'ps',
  '-a',
  '--format',
  'json',
]);

// The `docker compose -f <file> --profile <profile> config --format json` argv, for reading the
// provisioning GATE out of the compose model — the fallback observation when the provision container's
// own record is gone (see readProvisionGate).
export function configArgs(profile = harnessProfile()) {
  return ['compose', '-f', COMPOSE_FILE, '--profile', profile, 'config', '--format', 'json'];
}

// The compose dependency condition that expresses "this service starts only after the named one-shot
// ran to completion successfully". It is how compose itself states the property TOPO-BRINGUP-16 needs
// about the provisioning step, which is why it is the fallback when the container record is not there
// to read.
export const COMPLETED_SUCCESSFULLY = 'service_completed_successfully';

// The services whose `depends_on` must carry that condition on the provisioning service. Both
// containers declare it (compose.harness.yml), which is what puts Req 2.10's ordering in compose
// rather than in the runner.
export const PROVISION_DEPENDENTS = Object.freeze(['auth-surface', 'api-container']);

// The same list per profile. Under `collapsed` there is no `api-container`, so only the one container
// can vouch for the provisioning run — naming a service the profile does not run would leave the
// fallback unable to find its gate on a perfectly healthy collapsed topology.
export const PROVISION_DEPENDENTS_BY_PROFILE = Object.freeze({
  split: PROVISION_DEPENDENTS,
  collapsed: Object.freeze(['auth-surface']),
});

export function provisionDependentsFor(profile = harnessProfile()) {
  return PROVISION_DEPENDENTS_BY_PROFILE[profile] ?? PROVISION_DEPENDENTS;
}

// The `docker compose -f <file> logs --no-color --tail <n> <service>` argv, for the log tail a
// bring-up failure carries so a diagnosis does not require re-running (design: TOPO-BRINGUP-16 names
// the unhealthy service AND its log tail). Built per service so the tail names exactly the service
// that failed.
export function logsArgs(service, tail = 50) {
  return ['compose', '-f', COMPOSE_FILE, 'logs', '--no-color', '--tail', String(tail), service];
}

// ---------------------------------------------------------------------------------------------
// Pure parsing (no Docker) — the half a unit test exercises directly with synthetic ps output.
// ---------------------------------------------------------------------------------------------

// Parse `docker compose ps --format json` into an array of entries. The format is version-dependent:
// newer `docker compose` emits one JSON object per line (JSONL), older emits a single JSON array.
// Tolerate both, plus an empty string (nothing up — the caller reads that as "no topology"). A line
// that does not parse throws rather than being dropped, because a silently-dropped entry could hide a
// service and let an incomplete comparison read as agreement.
export function parseComposePs(psOutput) {
  const text = (psOutput ?? '').trim();
  if (text === '') {
    return [];
  }
  if (text.startsWith('[')) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) {
      throw new Error('docker compose ps --format json did not yield an array or JSONL.');
    }
    return arr;
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

// Index parsed `ps` entries by compose service name, keeping the fields the two deciders read:
// State (`running`/`exited`/…), Health (`healthy`/`unhealthy`/`starting`/`` when no healthcheck),
// ExitCode, and the resolved Publishers (the port bindings Docker established). Pure over the parsed
// array. Returns `{ [service]: { state, health, exitCode, publishers } }`.
export function indexPsByService(entries) {
  const byService = {};
  for (const entry of entries) {
    const service = entry.Service ?? null;
    if (service === null) {
      continue;
    }
    byService[service] = {
      state: entry.State ?? null,
      health: entry.Health ?? '',
      exitCode: typeof entry.ExitCode === 'number' ? entry.ExitCode : null,
      publishers: Array.isArray(entry.Publishers) ? entry.Publishers : [],
    };
  }
  return byService;
}

// Whether one service entry is "up" for bring-up purposes. A long-lived service is up when it is
// `running` AND either has no healthcheck (Health === '') or reports `healthy` — a `starting` or
// `unhealthy` service is NOT up, which is the state a service that never came healthy within the
// window shows. The provisioning service is a special case handled by isProvisionComplete: it is a
// one-shot that has EXITED 0 by the time the containers are up, so judging it by `running` would
// wrongly read a correctly-completed run as a failure.
export function isServiceUp(entry) {
  if (entry === undefined || entry === null) {
    return false;
  }
  if (entry.state !== 'running') {
    return false;
  }
  // A healthcheck present and not yet healthy means not-up; absent healthcheck (empty string) means
  // running is sufficient.
  return entry.health === '' || entry.health === 'healthy';
}

// Whether the one-shot provisioning service completed successfully: `exited` with code 0. This is the
// state the compose `depends_on: service_completed_successfully` gate requires before the containers
// start, so by the time the bring-up read runs, `provision` is expected to be exited(0), never
// running.
export function isProvisionComplete(entry) {
  if (entry === undefined || entry === null) {
    return false;
  }
  return entry.state === 'exited' && entry.exitCode === 0;
}

// ---------------------------------------------------------------------------------------------
// [TOPO-BRINGUP-16] decision — pure.
// ---------------------------------------------------------------------------------------------

// Decide TOPO-BRINGUP-16 from the indexed `ps` map. Pure. Returns
// `{ ok, unhealthy, reason? }`: ok only when every expected long-lived service is up (running +
// healthy-or-no-healthcheck) AND the provisioning service completed successfully. Any missing
// service, any service not up, or a provisioning run that did not exit 0 is a fail whose `reason`
// NAMES the offending service(s) — the observation the check reports as a setup failure (the runner
// then attaches the service's log tail). `unhealthy` is the list of offending service names so a
// caller can fetch each one's log tail.
export function decideBringup(
  byService,
  {
    profile = harnessProfile(),
    expectedServices = expectedServicesFor(profile),
    provisionService = PROVISION_SERVICE,
    provisionGate = null,
  } = {},
) {
  const unhealthy = [];
  const notes = [];

  for (const service of expectedServices) {
    if (!(service in byService)) {
      unhealthy.push(`${service} (absent from \`docker compose ps\`)`);
      continue;
    }
    if (!isServiceUp(byService[service])) {
      const entry = byService[service];
      const detail =
        entry.health && entry.health !== 'healthy'
          ? `state=${entry.state}, health=${entry.health}`
          : `state=${entry.state}`;
      unhealthy.push(`${service} (${detail})`);
    }
  }

  // The provisioning one-shot must have COMPLETED SUCCESSFULLY, which for a one-shot means exited 0 —
  // not running, and not merely present. Three cases, and telling them apart is the whole point:
  //
  //   1. Present and exited 0            -> complete. The primary observation, visible because the ps
  //                                         read passes `-a`.
  //   2. Present and anything else       -> a failure: a non-zero exit means the grants were not
  //                                         applied, and a still-running provision means the
  //                                         containers booted ahead of their own precondition.
  //   3. Absent from `ps -a` altogether  -> the container RECORD is gone. That is not the same claim
  //                                         as "it never ran": a one-shot run with `--rm` is removed on
  //                                         completion, and a swept record leaves nothing to read. So
  //                                         before calling it never-provisioned, consult the gate
  //                                         compose itself enforces: if both containers declare
  //                                         `depends_on: provision: service_completed_successfully`
  //                                         and both are up, then compose would not have started them
  //                                         unless provisioning had completed successfully. That is a
  //                                         structural guarantee rather than a direct observation, so
  //                                         the decision records WHICH evidence decided it.
  if (provisionService in byService) {
    if (!isProvisionComplete(byService[provisionService])) {
      const entry = byService[provisionService];
      unhealthy.push(
        `${provisionService} (did not complete successfully: state=${entry.state}, exitCode=${entry.exitCode})`,
      );
    }
  } else {
    const gatedDependents = (provisionGate?.gatedServices ?? []).filter(
      (service) => service in byService && isServiceUp(byService[service]),
    );
    if (gatedDependents.length > 0) {
      notes.push(
        `${provisionService} left no container record in \`docker compose ps -a\` (a completed ` +
          'one-shot can be swept), so its completion is taken from the gate compose enforces: ' +
          `${gatedDependents.join(', ')} declare \`depends_on: ${provisionService}: ` +
          `${COMPLETED_SUCCESSFULLY}\` and are up, which compose would not have started unless ` +
          'provisioning had exited 0.',
      );
    } else {
      unhealthy.push(
        `${provisionService} (absent from \`docker compose ps -a\` and not vouched for by a ` +
          `\`${COMPLETED_SUCCESSFULLY}\` gate on a running container — the grants cannot be shown to ` +
          'have been provisioned)',
      );
    }
  }

  if (unhealthy.length > 0) {
    return {
      ok: false,
      unhealthy: unhealthy.map((u) => u.split(' ')[0]),
      notes,
      reason:
        'the topology did not come up healthy within the bring-up window: ' +
        `${unhealthy.join('; ')}. Reported as a SETUP FAILURE (the topology never came up, so it ` +
        'has falsified nothing — Property 9); no request-level check is admitted.',
    };
  }

  return { ok: true, unhealthy: [], notes };
}

// ---------------------------------------------------------------------------------------------
// [TOPO-INGRESS-17] decision — pure.
// ---------------------------------------------------------------------------------------------

// Classify one published port binding as one of: `ingress` (the ingress address 127.0.0.1:8080),
// `observation` (a loopback health/observation address the topology legitimately publishes), or
// `external` (any other host-published binding — the exposure TOPO-INGRESS-17 forbids on the
// API_Container). A binding with no PublishedPort (an internal-only exposure) is `internal` and does
// not count as an external door. Pure over the `Publishers` entries `docker compose ps` reports.
export function classifyPublisher(
  publisher,
  { observationAddresses = OBSERVATION_ADDRESSES } = {},
) {
  const publishedPort = publisher.PublishedPort ?? 0;
  if (!publishedPort || publishedPort === 0) {
    // Not published to the host — internal to the compose network only.
    return 'internal';
  }
  // `URL` is null when Docker did not report a host bind address; `0.0.0.0`/`::` mean all interfaces.
  const host = publisher.URL ?? '0.0.0.0';
  const address = `${host}:${publishedPort}`;

  if (host === INGRESS_HOST && publishedPort === INGRESS_PORT) {
    return 'ingress';
  }
  if (observationAddresses.has(address)) {
    return 'observation';
  }
  return 'external';
}

// Decide TOPO-INGRESS-17 from the indexed `ps` map. Pure. Returns `{ ok, reason? }`. Two clauses,
// both asserted from the RESOLVED port bindings:
//
//   1. ONLY the Front_Proxy is published on the ingress address (127.0.0.1:8080). If any service
//      OTHER than the proxy binds the ingress address, or if the proxy does NOT bind it, that is a
//      fail — the ingress must be the proxy's and only the proxy's.
//   2. The API_Container is published on NO external address — its only host publication may be the
//      loopback observation plane (127.0.0.1:3092). Any `ingress` or `external` binding on the
//      api-container fails: a directly-reachable API_Container would let request traffic bypass the
//      routed-path partition and make the routing checks meaningless.
export function decideIngress(
  byService,
  {
    profile = harnessProfile(),
    proxyService = proxyServiceFor(profile),
    apiService = 'api-container',
    observationAddresses = OBSERVATION_ADDRESSES,
  } = {},
) {
  const problems = [];

  // Clause 1: who binds the ingress address.
  const ingressBinders = [];
  for (const [service, entry] of Object.entries(byService)) {
    for (const publisher of entry.publishers) {
      if (classifyPublisher(publisher, { observationAddresses }) === 'ingress') {
        ingressBinders.push(service);
      }
    }
  }
  const nonProxyBinders = [...new Set(ingressBinders)].filter((s) => s !== proxyService);
  if (nonProxyBinders.length > 0) {
    problems.push(
      `the ingress address ${INGRESS_HOST}:${INGRESS_PORT} is published by ${nonProxyBinders.join(', ')}, ` +
        `not only by the Front_Proxy (${proxyService}). Only the proxy may bind the ingress (Req 1.9).`,
    );
  }
  // Both profiles run a proxy — `proxy` under split, `proxy-collapsed` under collapsed — and it must
  // bind the ingress; if it does not, the ingress is not established at all. `proxyService` is the
  // profile's name for it, so this clause decides the same thing under either topology rather than
  // going vacuous on the one whose proxy is named differently.
  if (proxyService in byService && !ingressBinders.includes(proxyService)) {
    problems.push(
      `the Front_Proxy (${proxyService}) does NOT publish the ingress address ${INGRESS_HOST}:${INGRESS_PORT}; ` +
        'the topology has no ingress door.',
    );
  }

  // Clause 2: the API_Container must have no external (or ingress) publication. The collapsed profile
  // runs no `api-container` at all, so the clause has no subject there and is satisfied by the
  // service's ABSENCE rather than by a branch on the profile: there is no second container to reach
  // directly, which is the state the clause exists to require.
  const apiEntry = byService[apiService];
  if (apiEntry !== undefined) {
    for (const publisher of apiEntry.publishers) {
      const kind = classifyPublisher(publisher, { observationAddresses });
      if (kind === 'ingress' || kind === 'external') {
        const host = publisher.URL ?? '0.0.0.0';
        problems.push(
          `the ${apiService} is published on ${kind} address ${host}:${publisher.PublishedPort}. ` +
            'It must be reachable from outside ONLY through the Front_Proxy (Req 1.9, 1.10); a ' +
            'directly-reachable API_Container makes the routing checks meaningless.',
        );
      }
    }
  }

  if (problems.length > 0) {
    return { ok: false, reason: problems.join(' ') };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The live reads — thin wrappers over the exec seam that gather what the pure deciders consume.
// ---------------------------------------------------------------------------------------------

// Read the indexed `ps` map from the live topology. Returns `{ up, byService }`. `up` is false when
// `docker compose ps` reports no service (empty output) or the `docker`/`compose` invocation itself
// failed to find a topology — the signal the checks use to SELF-SKIP rather than fail (a topology
// that is not up has falsified nothing).
export async function readPs({ exec = defaultDockerExec } = {}) {
  const result = await exec([...PS_ARGS]);
  if (result.status !== 0 && (result.stdout ?? '').trim() === '') {
    return { up: false, byService: {} };
  }
  const entries = parseComposePs(result.stdout);
  if (entries.length === 0) {
    return { up: false, byService: {} };
  }
  return { up: true, byService: indexPsByService(entries) };
}

// Which services the compose model gates on the provisioning one-shot's successful completion. Pure
// over `docker compose config --format json`'s parsed output: a service qualifies when its `depends_on`
// names the provisioning service with condition `service_completed_successfully`. Returns
// `{ gatedServices }`.
//
// This is the compose model's own statement of the property, read back rather than assumed — a compose
// edit that dropped the condition would leave `gatedServices` empty, so the fallback stops vouching for
// a provisioning run it can no longer infer.
export function decideProvisionGate(
  config,
  {
    provisionService = PROVISION_SERVICE,
    profile = harnessProfile(),
    dependents = provisionDependentsFor(profile),
  } = {},
) {
  const services = config?.services ?? {};
  const gatedServices = dependents.filter((name) => {
    const dependsOn = services[name]?.depends_on;
    if (dependsOn === null || typeof dependsOn !== 'object') {
      return false;
    }
    return dependsOn[provisionService]?.condition === COMPLETED_SUCCESSFULLY;
  });
  return { gatedServices };
}

// Read the provisioning gate from the live compose model. Returns `{ gatedServices: [] }` on any
// failure to read or parse: the gate is corroborating evidence for one branch of the bring-up decision,
// so a failed read must leave that branch unvouched-for rather than throw over the primary observation.
export async function readProvisionGate({
  exec = defaultDockerExec,
  profile = harnessProfile(),
} = {}) {
  const result = await exec(configArgs(profile));
  if (result.status !== 0) {
    return { gatedServices: [] };
  }
  try {
    return decideProvisionGate(JSON.parse(result.stdout ?? ''), { profile });
  } catch {
    return { gatedServices: [] };
  }
}

// Fetch the log tail for each named service, for the observation a bring-up failure carries. Returns
// `{ [service]: tailText }`. A log read that itself fails is recorded as its captured stderr rather
// than throwing — the primary observation is the bring-up decision's reason; the tail is corroborating
// detail that must not mask it.
export async function readLogTails(services, { exec = defaultDockerExec, tail = 50 } = {}) {
  const tails = {};
  for (const service of services) {
    const result = await exec(logsArgs(service, tail));
    tails[service] = result.status === 0 ? (result.stdout ?? '') : (result.stderr ?? '');
  }
  return tails;
}
