// jest.setup.mjs — the Layer B context bridge (task 15.2).
//
// run.mjs and the Jest workers run in SEPARATE processes, so a literal
// `globalThis.__CONTAINER_SPLIT_HARNESS__ = …` in run.mjs never reaches the checks. run.mjs instead
// writes the context PRIMITIVES (the observer URI, the boot timestamps, the profile, the compose
// file) to a gitignored JSON file and points HARNESS_CONTEXT_FILE at it (run.mjs:
// assembleContextPrimitives / HARNESS_CONTEXT_FILE). This module — registered as `setupFiles` in
// jest.config.mjs so it runs BEFORE any checks/*.spec.mjs is imported and its module-level
// `harnessContext()` reads globalThis — reads that file and RECONSTRUCTS the live context the specs
// expect:
//
//   globalThis.__CONTAINER_SPLIT_HARNESS__ = {
//     ingress,       // makeIngressClient({ fetch }) — the sole external door (Front_Proxy)
//     observation,   // makeObservationClient({ fetch, exec }) — loopback readiness + docker logs
//     observerDb,    // a mongodb Db connected read-only to 127.0.0.1:27019 under the observer cred
//     proxyLogs,     // async () => ({ stdout }) — the Front_Proxy's own access log, its own channel
//     bootStart,     // captureBootStart's { epochMs, iso } — the boot window's left edge
//     readyAtMs,     // epoch ms /readyz first answered 200 — the window's right edge is +60s
//     window,        // { since } for `docker compose logs --since`
//   }
//
// It does NOT apply the bridge's `composeEnv` — the nine compose interpolation values a check that
// spawns `docker compose` needs. Those reach this process's REAL environment through the spawn that
// starts it (run.mjs: runLayerBChecks), because a write to the Jest-sandboxed `process.env` cannot
// reach a child process at all. See the note below where they would otherwise have been applied.
//
// The two HTTP clients keep their separation BY CONSTRUCTION (task 7.6): the ingress client carries
// only the proxy address, the observation client only the loopback readiness/log surface. This
// module supplies each its primitive (`fetch`, `exec`) and nothing that would let one be aimed at
// the other's address — the factories bake the base URLs in.
//
// `proxyLogs` is deliberately a THIRD, NARROW channel rather than a widening of either client. The
// observation client is baked to the two application containers and throws for anything else
// (run.mjs: makeObservationClient's baseUrlFor), which is the separation task 7.6 establishes — so
// the proxy's access log cannot and must not be read through it. This channel reads ONE thing: the
// Front_Proxy service's own log. It carries no HTTP surface at all, so it cannot become a second
// ingress, and the routing checks consume it through `resolveProxyLogs`.
//
// == Native ESM, setupFilesAfterEnv, top-level await ==
// jest.config.mjs runs Jest in native-ESM mode (`--experimental-vm-modules`) and lists this module
// under `setupFilesAfterEnv`, so it is evaluated — as an ES module, with its top-level `await`
// completed — AFTER the test framework is installed (which is what makes `afterAll` available for
// closing the observer connection) but BEFORE each spec file's body runs. That ordering is what lets
// the specs keep their `const CTX = harnessContext()` at module scope (task 14.7) rather than inside
// an async hook: globalThis is populated before the spec reads it.
//
// Under `maxWorkers: 1` (jest.config.mjs) this runs once per spec file in one process, so the
// connection is opened once and reused: a module-level guard makes the second and later evaluations
// no-ops rather than opening a fresh client per file.
//
// == When no context file is present ==
// A plain `jest`/`--listTests` invocation (the static-checks run, or a developer running the config
// directly) sets no HARNESS_CONTEXT_FILE. This module then does nothing, leaving
// globalThis.__CONTAINER_SPLIT_HARNESS__ absent — which is exactly the signal every spec's live gate
// reads to self-skip. So the static checks stay green with no topology, and the live checks activate
// only when run.mjs published a context.
//
// NG1/NG2 hold: this wires the harness's own clients and a read-only observer connection. It adds no
// application code, no route mount and no HTTP path, and edits neither container-split script.

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { MongoClient } from 'mongodb';

import {
  makeIngressClient,
  makeObservationClient,
  OBSERVATION_COMPOSE_BASE_ARGS,
  HARNESS_CONTEXT_ENV,
  IDENTITIES,
} from './run.mjs';

// The Front_Proxy's COMPOSE SERVICE NAME, per profile — read off compose.harness.yml, where the split
// proxy is the `proxy` service (`container_name: harness-proxy`) and the collapsed one is
// `proxy-collapsed`. Not `front-proxy`: that name appears only as a SetupFailure's `service` label in
// run.mjs and names no compose service, so `docker compose logs front-proxy` reads nothing at all —
// which is why the routing observation used to report "(no proxy log source)" or an empty read.
const PROXY_SERVICE_BY_PROFILE = Object.freeze({
  split: 'proxy',
  collapsed: 'proxy-collapsed',
});

// Build an exec the observation client uses for `docker compose logs …`. It mirrors run.mjs's real
// exec (resolves `{ status, stdout, stderr }`, never rejects on a non-zero exit) and injects
// COMPOSE_FILE so the `['compose', …]` argv the observation client spells resolves the harness file
// without an `-f`. Kept tiny and local: the bootstrap only needs log reads, not the full run seam.
function makeLogsExec(composeFile) {
  return (command, args = []) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: { ...process.env, COMPOSE_FILE: composeFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }));
    });
}

// The proxy access-log channel the routing checks' `resolveProxyLogs` looks for on the bridge
// (checks/routing.spec.mjs). Shaped to what routing.filter.mjs's `safeAccessLogLine` consumes: an
// async function resolving an object with a `stdout` string — which is exactly what the `exec` above
// resolves, so this is a thin argv builder over the SAME exec the observation client was handed, not
// a second spawn implementation.
//
// Reads the whole proxy log rather than passing `--since`: the access log is one short-lived
// container's stdout for one run, and a `--since` timestamp is compared against the container's clock,
// so filtering could silently drop the very line a failure needs to quote. Both profile flags are
// spelled from run.mjs's OBSERVATION_COMPOSE_BASE_ARGS so a log read resolves the service under either
// profile, the same way the observation client's reads do.
function makeProxyLogsReader({ exec, profile }) {
  const service = PROXY_SERVICE_BY_PROFILE[profile] ?? PROXY_SERVICE_BY_PROFILE.split;
  return async () =>
    exec('docker', [...OBSERVATION_COMPOSE_BASE_ARGS, 'logs', '--no-color', service]);
}

const contextFile = process.env[HARNESS_CONTEXT_ENV];

// setupFilesAfterEnv runs once per spec file; build the context only on the first evaluation and
// reuse it thereafter, so one observer connection serves the whole (--runInBand) Layer B run.
if (contextFile && !globalThis.__CONTAINER_SPLIT_HARNESS__) {
  // Read the primitives run.mjs published. A malformed or absent file is a bring-up bug, not a
  // reason to silently skip — let the parse throw so the run reports a load failure rather than
  // every check quietly self-skipping as if no topology were requested.
  const raw = await readFile(contextFile, 'utf8');
  const primitives = JSON.parse(raw);

  // NOTE — the nine compose interpolation values are deliberately NOT applied here.
  //
  // compose.harness.yml interpolates them with no defaults, so a check that spawns `docker compose`
  // needs them in the environment `docker` is spawned with. An earlier revision of this file looped
  // over `primitives.composeEnv` and assigned each into `process.env`, on the reasoning that the check
  // seams call `execFile('docker', argv)` with no `env` and therefore inherit `process.env`. That
  // reasoning is wrong under Jest and the fix did not work: Jest hands each test environment a CLONE of
  // `process` (jest-util's createProcessObject — `process.env` is a proxy over a per-test-file copy),
  // while `node:child_process` is the real core module closing over the real `process`. The write lands
  // in the sandbox copy; the docker child is spawned from the real environment, which never saw it. So
  // TOPO-ENV-14 and MONGO-URI-19 kept failing with `The "HARNESS_IMAGE" variable is not set … invalid
  // compose project` against a topology that was up and healthy. (`ps` tolerates blank interpolation and
  // exits 0, which is why TOPO-IMAGE-13 and TOPO-BRINGUP-16 passed throughout.)
  //
  // They now arrive the only way a child process can receive them: run.mjs's runLayerBChecks puts them
  // in the `env` of the spawn that starts this Jest process, so they are in its REAL environment before
  // any module here runs, and every `docker` a check spawns inherits them. That also means the
  // sandboxed `process.env` this file sees is already a copy that carries them — makeLogsExec's
  // `{ ...process.env }` spread picks them up with nothing to apply. `primitives.composeEnv` stays on
  // the bridge as the published record of what the topology came up with; do not re-add the loop.
  //
  // They are per-run secrets either way: nothing here logs them, and nothing should.

  // The observation client reads logs through `docker compose logs`; build it with the real fetch
  // (loopback readiness reads) and the logs exec (COMPOSE_FILE-aware).
  const logsExec = makeLogsExec(primitives.composeFile);
  const observation = makeObservationClient({
    fetch: globalThis.fetch,
    exec: logsExec,
  });

  // The proxy access log — its own channel, built over the same exec. The observation client is baked
  // to the two application containers and throws for any other name, so routing this through it would
  // have meant widening the very separation task 7.6 makes structural.
  const proxyLogs = makeProxyLogsReader({ exec: logsExec, profile: primitives.profile });

  // The ingress client reaches the Front_Proxy only — baked to its address by construction.
  const ingress = makeIngressClient({ fetch: globalThis.fetch });

  // Connect the read-only observer Db to the loopback observation plane under the observer
  // credential. `find` is the only action the observer holds (task 7.2), so this connection can read
  // system.profile and the inspected collections and nothing else — the boot-write and group-sync
  // checks read through it. A single client for the whole Layer B run (which is --runInBand, one
  // topology), closed in the afterAll below.
  const client = new MongoClient(primitives.observerUri);
  await client.connect();
  const observerDb = client.db(IDENTITIES.mongoDb);

  globalThis.__CONTAINER_SPLIT_HARNESS__ = {
    ingress,
    observation,
    observerDb,
    // The Front_Proxy's access log, published at the TOP LEVEL under the name
    // checks/routing.spec.mjs's resolveProxyLogs reads (`ctx.proxyLogs`). Without it every
    // ROUTE-ALLOW-27 / ROUTE-DEFAULT-28 failure reported "(no proxy log source)" and the check could
    // not make the mislabeled-header vs genuine-misroute distinction its own observation text claims.
    proxyLogs,
    bootStart: primitives.bootStart,
    readyAtMs: primitives.readyAtMs,
    window: primitives.window ?? {},
    // The Seeded_Account the runner inserted under the Root_Credential at stage 6, before the boot
    // window opened (task 11.5, Req 3.16/3.17/3.18): `{ id, email, username, name, password, provider,
    // role }`. The path exercises resolve their recorded SEED_PLACEHOLDERS from it, and the
    // Session_Fixture is minted by posting its email and password to /api/auth/login through the
    // ingress above — after the boot window has closed, which mintSessionFixture enforces itself. Its
    // password is a per-run secret that arrived on the mode-0600 bridge; nothing here logs it.
    seededAccount: primitives.seededAccount ?? null,
    // Kept so a later cleanup (or a check that wants to close the connection) can reach the client
    // without re-parsing the file. Not read by any spec today.
    __observerClient: client,
  };

  // Close the observer connection when the run finishes, so the runner's teardown does not race an
  // open client against `docker compose down` and an idle socket does not hold the Jest process open.
  // `afterAll` is available because this module is a setupFilesAfterEnv file (the test framework is
  // installed by the time it runs). Registered once per file; closing an already-closed client is a
  // no-op, and the guard above means only the first file opened it.
  if (typeof afterAll === 'function') {
    afterAll(async () => {
      await client.close().catch(() => {});
    });
  }
}
