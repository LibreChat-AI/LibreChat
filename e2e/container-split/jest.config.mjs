// jest.config.mjs — Layer B's own Jest config (task 7.5).
//
// Layer B does NOT reuse api/jest.config.js. It diverges on the two things that matter for a suite
// that drives one live topology rather than in-process units:
//
//   1. testTimeout is MINUTE-SCALE, not the api config's 30 seconds. A Layer B check reads an HTTP
//      status through a proxy, waits on a readiness endpoint that answers only after a full container
//      boot, or queries system.profile across a boot window that closes 60 seconds after /readyz —
//      observations that unfold over the topology's own clock, not a function call's. A 30-second cap
//      would flake on a cold boot; the budget here is sized to the design's readiness windows.
//
//   2. --runInBand, expressed as maxWorkers: 1. Every check shares ONE topology — one Front_Proxy,
//      one Auth_Enabled_MongoDB, one pair of containers — and reads mutable shared state (the
//      capped system.profile, the containers' logs). Jest's default worker pool would run files in
//      parallel across processes that all point at that single topology, so two checks would race on
//      the same profile collection and the same log stream. Serial execution is not a speed choice
//      here; it is a correctness requirement of a shared-fixture suite (design: the runner "brings up,
//      checks, reports per check, and tears down" — one topology, checks in series).
//
// == Jest, not Playwright ==
// Every Layer B observation is an HTTP status, a response header (X-Harness-Upstream), a log line, or
// a MongoDB query. No browser, no rendering, no user interaction — so a browser runtime would be dead
// weight in a lane that never launches one. Jest is already the runner the Layer A suites use to spawn
// mongosh against a container-split script, so both layers share one assertion vocabulary and one
// reporter shape (the check record). This config keeps Layer B on that same runner.
//
// == The check-record artifact ==
// The custom reporter (reporter.mjs) turns each check's result into the design's check record and
// writes the JSON summary the CI lane attaches, alongside Jest's own 'default' reporter output for a
// developer running locally. The serializer it wraps (serializer.mjs) is pure and unit-tested.
//
// == Native ESM, not a babel-to-CommonJS transform ==
// The harness modules are ESM entrypoints: run.mjs resolves its own directory with
// `fileURLToPath(import.meta.url)` (its "run only when invoked directly" guard and its ENV_DIR both
// depend on it), and reporter.mjs does the same to place the run-report artifact beside itself.
// `import.meta` is only legal inside an ES module, so compiling these files to CommonJS with
// @babel/preset-env — which is what an earlier revision of this config did — rewrites the module
// wrapper away and leaves a bare `import.meta.url` that throws `SyntaxError: Cannot use 'import.meta'
// outside a module` the moment any check imports run.mjs. Every checks/*.spec.mjs imports run.mjs, so
// under the babel-CJS transform NOT ONE check could execute; only `--listTests` and `--showConfig`,
// which never load a file, appeared to work.
//
// So Layer B runs Jest in NATIVE-ESM mode instead. The .mjs files load as real ES modules — no
// transform — so `import.meta.url` stays valid exactly as it is under `node run.mjs`. Jest's ESM
// support is behind Node's `--experimental-vm-modules`, which task 15.2's runner (run.mjs, folded
// into the single `harness:container-split` entry) sets via NODE_OPTIONS when it spawns this config;
// Node 24 (the repo's .nvmrc / CI) supports it.
// The tradeoff of native ESM is that `__dirname` is not defined; the check specs that need their own
// directory resolve it from `import.meta.url`, the one shape valid under both `node` and this config.
//
// == Running against a live topology is task 15 ==
// Authoring this config is task 7.5. The checks/*.spec.mjs files exercise a topology that only exists
// once run.mjs brings it up with Docker (task 15). This config is what that run invokes; the pure and
// static tests in each spec execute and pass under it today, while the HARNESS_LIVE-gated live tests
// self-skip cleanly without a topology.
//
// NG1/NG2 hold: this configures the harness's own test runner and touches no application code or
// either container-split script.

export default {
  // Node, not jsdom: there is no DOM to render — every observation is HTTP, a header, a log line, or
  // a Mongo query.
  testEnvironment: 'node',

  // The suite lives beside this config; its checks are the checks/*.spec.mjs files.
  rootDir: '.',
  roots: ['<rootDir>'],

  // Match the Layer B checks only. `.spec.mjs` under checks/ — the serializer/reporter/catalog and
  // their own unit tests live at the root and are matched by the sibling *.test.mjs pattern so the
  // topology checks and the harness's own unit tests do not collide.
  testMatch: ['<rootDir>/checks/**/*.spec.mjs', '<rootDir>/**/*.test.mjs'],

  // Minute-scale, not the api config's 30s. Sized to the design's readiness windows (a full container
  // boot plus the 60s boot-window tail), so a cold bring-up does not read as a check failure.
  testTimeout: 120_000,

  // --runInBand. One shared topology, mutable shared state (system.profile, container logs): the
  // checks CANNOT be parallelized across workers without racing. Serial is a correctness requirement.
  maxWorkers: 1,

  // Load .mjs as real ES modules — NO transform. run.mjs and reporter.mjs use `import.meta.url`,
  // which is only legal in an ES module; a babel-to-CommonJS transform would rewrite the module
  // wrapper away and leave a bare `import.meta` that throws at load (see the note above). Jest reads
  // these files through Node's ESM loader instead, so `import.meta.url` stays valid exactly as under
  // `node run.mjs`. This needs `--experimental-vm-modules` in NODE_OPTIONS (set by task 15.2's runner
  // when it spawns this config); Node 24 supports it. Jest always
  // treats a .mjs file as an ES module, so no `extensionsToTreatAsEsm` entry is needed (and Jest
  // rejects one that names .mjs) — an empty `transform` is what removes the babel-CJS step.
  transform: {},

  // .mjs is not in Jest's default moduleFileExtensions; add it so imports resolve without extensions
  // and the spec files are discovered.
  moduleFileExtensions: ['mjs', 'js', 'json'],

  // The context bridge (task 15.2). run.mjs and the Jest workers are separate processes, so run.mjs
  // publishes the context PRIMITIVES to a gitignored JSON file (HARNESS_CONTEXT_FILE) and this module
  // reconstructs globalThis.__CONTAINER_SPLIT_HARNESS__ — the ingress/observation clients and the
  // read-only observer Db — from them. It is a setupFilesAfterEnv file (not setupFiles) so `afterAll`
  // is available to close the observer connection, and it runs before each spec file's body so the
  // specs' module-level `const CTX = harnessContext()` sees the context. With no HARNESS_CONTEXT_FILE
  // (a plain `jest`/`--listTests` run) it does nothing, leaving the context absent so the live checks
  // self-skip and the static checks stay green.
  setupFilesAfterEnv: ['<rootDir>/jest.setup.mjs'],

  // Reset mock state between checks so one check's stubbed exec/fetch cannot leak into the next under
  // serial execution.
  clearMocks: true,

  // Two reporters: Jest's default for the developer running locally, and the harness's check-record
  // reporter for the JSON artifact the CI lane attaches (RUN-REPORT-32, reporting half).
  reporters: ['default', '<rootDir>/reporter.mjs'],
};
