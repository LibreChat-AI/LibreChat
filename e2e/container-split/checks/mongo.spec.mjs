// checks/mongo.spec.mjs — the MongoDB access-control and URI checks (task 9.4).
//
// Two Layer B checks, both keyed to the design's Check Catalog (design.md: "## Check Catalog"):
//
//   [MONGO-AUTH-18]  An unauthenticated connection to the Auth_Enabled_MongoDB is refused by mongod,
//                    and a wrong credential fails. This is what distinguishes the harness's instance
//                    from the `mongod --noauth` both existing compose files run — a green harness run
//                    means nothing without it (Req 2.1).
//
//   [MONGO-URI-19]   Both containers' resolved MONGO_URI values name the LibreChat database as the
//                    default database and carry authSource=admin, asserted against the resolved
//                    container environment as well as against what run.mjs generates. A missing or
//                    wrong authSource is reported as an AUTHENTICATION-SOURCE DEFECT — the failure
//                    mode task 4.3's PROVISION-AUTHSOURCE-11 and NC5 name — not as a container that
//                    will not start (Req 2.5, 2.6).
//
// == What runs where ==
// Every observation in this file is either a static read over what run.mjs generates and what
// `docker compose config` resolves, or a live MongoClient probe against the observer plane. The
// runner (run.mjs) already owns the URI shape (validateMongoUri, buildContainerUris) and the fixed
// identities (IDENTITIES), so this spec REUSES those rather than restating the URI grammar — a change
// to the URI construction flows into this check through the import instead of a second edit here.
//
//   * The [MONGO-URI-19] STATIC assertion needs no live topology: validateMongoUri over the URIs
//     run.mjs generates (buildContainerUris) is the "what the runner generated" side. It runs under
//     the Layer B config, which loads run.mjs as a NATIVE ES module (jest.config.mjs, task 7.5: no
//     babel-to-CommonJS transform) — run.mjs is an ESM entrypoint whose `import.meta.url` a CommonJS
//     transform cannot represent, which is why the config runs Jest with --experimental-vm-modules
//     rather than compiling the runner down.
//   * The [MONGO-URI-19] RESOLVED-ENVIRONMENT assertion reads each container's resolved MONGO_URI out
//     of `docker compose config` (the compose file's interpolated value — the "resolved container
//     environment" side) and runs the SAME validateMongoUri over it. It needs the compose file to
//     resolve, which needs the per-run env files run.mjs writes, so it is gated on a live topology
//     and exercised in task 15.
//   * The [MONGO-AUTH-18] probes open a MongoClient to the observer plane on 127.0.0.1:27019 — the
//     loopback address compose.harness.yml publishes mongod on for observation only (design:
//     Auth_Enabled_MongoDB service; NOT 27017/27018, which the two existing compose files bind). A
//     live mongod is required, so these are gated on a live topology and exercised in task 15.
//
// == The live-topology gate ==
// A live topology exists only once run.mjs brings it up with Docker (task 15). Until then the
// live-only checks must SELF-SKIP loudly rather than fail — a topology that is not up has falsified
// nothing (Property 9). The gate is HARNESS_LIVE=1 in the environment, which run.mjs sets when it
// invokes Jest against a live topology; absent it, the live checks skip with a reason the reporter
// turns into a `skip` record carrying an observation (serializer.mjs: skip requires an observation).
// The title encodes the reason as `(skipped: …)`, which reporter.mjs's parseCheckId tolerates and
// outcomeFromAssertion reads. This is what makes `jest --listTests` discover the file, while task
// 15's live run (HARNESS_LIVE=1, under the ESM-loading Layer B config) exercises the probes for real.
//
// NG1/NG2 hold: this reads the harness's own compose file and probes the harness's own mongod. It
// adds no application code, no route mount and no HTTP path, and edits neither container-split
// script. NG6 holds: the probes authenticate (or fail to) against mongod directly; there is no
// credential validation at any proxy edge here.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';

import {
  IDENTITIES,
  generateSecrets,
  buildContainerUris,
  validateMongoUri,
  SetupFailure,
  SETUP_FAILURE_KINDS,
} from '../run.mjs';
// The profile reader, from the module that owns the Check Catalog's profile dimension.
import { profileFromEnv } from '../check-catalog.mjs';

const execFileAsync = promisify(execFile);

// This file's own directory, resolved from `import.meta.url`. The Layer B Jest config loads .mjs as
// native ES modules (jest.config.mjs: no babel-to-CommonJS transform), so `import.meta` is valid here
// under Jest exactly as it is under `node` — the same runtime run.mjs and reporter.mjs resolve their
// directories in. `__dirname` does not exist under native ESM, so it is deliberately not used. The
// live resolved-env check (below) is the only consumer, and it runs under this config.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// The observer plane address compose.harness.yml publishes mongod on (design: Auth_Enabled_MongoDB
// service — `127.0.0.1:27019:27017`). Deliberately not 27017 or 27018, which the two existing compose
// files bind. Named once here so the MONGO-AUTH-18 probes and any future reader read one source.
const OBSERVER_PLANE_HOST = '127.0.0.1';
const OBSERVER_PLANE_PORT = 27019;
const OBSERVER_PLANE_ADDRESS = `${OBSERVER_PLANE_HOST}:${OBSERVER_PLANE_PORT}`;

// The compose service names whose resolved MONGO_URI the resolved-environment check reads, PER PROFILE.
// These are the service keys in compose.harness.yml; validateMongoUri names the offending side on
// failure.
//
// MONGO-URI-19 is PROFILE-AWARE (check-catalog.mjs): Req 2.5/2.6 is a per-URI claim — authSource=admin,
// the LibreChat database as the default — and it holds for the collapsed container's own URI exactly as
// it does for the split pair's. What does NOT survive is the service LIST: the collapsed profile runs no
// `api-container`, so asking for its resolved URI yielded `undefined` and failed the check on a healthy
// collapsed topology. Parameterizing the list keeps the claim and drops the wrong expectation.
const CONTAINER_SERVICES_BY_PROFILE = Object.freeze({
  split: Object.freeze(['auth-surface', 'api-container']),
  collapsed: Object.freeze(['auth-surface']),
});

// The profile this run is judged under, resolved through the Check Catalog's reader so this check and
// the reporter's id selection cannot disagree about which profile is running.
const PROFILE = profileFromEnv(process.env);
const CONTAINER_SERVICES =
  CONTAINER_SERVICES_BY_PROFILE[PROFILE] ?? CONTAINER_SERVICES_BY_PROFILE.split;

// A live topology exists only when run.mjs brought it up (task 15). HARNESS_LIVE=1 is the signal;
// without it the live-only checks self-skip rather than fail (Property 9: a topology that is not up
// has falsified nothing).
const LIVE = process.env.HARNESS_LIVE === '1';

// A short connection budget for the MONGO-AUTH-18 probes. A refusal is fast — mongod rejects an
// unauthenticated command or a wrong credential immediately — so a probe that hangs past this budget
// is itself a finding (a mongod NOT enforcing access control would accept and then hang on the
// operation, not refuse). Kept well inside the Jest config's minute-scale testTimeout.
const PROBE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------------------------
// [MONGO-URI-19] — both MONGO_URI values name the LibreChat database and carry authSource=admin.
// ---------------------------------------------------------------------------------------------
describe('[MONGO-URI-19] MONGO_URI names the LibreChat database and authSource=admin', () => {
  // The STATIC side: validateMongoUri over the URIs run.mjs generates. This is the "what the runner
  // generated" half and needs no live topology. Reusing validateMongoUri (rather than re-parsing the
  // URI here) is what keeps this check honest against a change to the URI grammar: if run.mjs's
  // construction drifts, this fails through the shared function rather than agreeing with a private
  // copy of the rules.
  test('[MONGO-URI-19] both generated container URIs pass validateMongoUri (authSource=admin, LibreChat default db)', () => {
    const uris = buildContainerUris(generateSecrets());

    // Every entry buildContainerUris returns is a container URI; assert both, so a future third
    // entry is covered without editing this test.
    for (const [side, uri] of Object.entries(uris)) {
      // validateMongoUri throws a SetupFailure on a missing/wrong authSource or a wrong default db,
      // and returns the parsed shape otherwise. It does not throw here — these are the runner's own
      // well-formed URIs — but running it is what makes the check decide the URI grammar.
      const parsed = validateMongoUri(uri, side);
      expect(parsed.authSource).toBe(IDENTITIES.authSource);
      expect(parsed.authSource).toBe('admin');
      expect(parsed.defaultDb).toBe(IDENTITIES.mongoDb);
      expect(parsed.defaultDb).toBe('LibreChat');
    }
  });

  // A missing authSource must surface as an AUTHENTICATION-SOURCE DEFECT — the failure mode task
  // 4.3's PROVISION-AUTHSOURCE-11 and NC5 name — and NOT as a container that will not start. This
  // asserts that reporting contract on the mechanism MONGO-URI-19 reuses: validateMongoUri raises a
  // SetupFailure tagged MONGO_URI_AUTHSOURCE. NC5 strips authSource from one container's URI and
  // relies on exactly this classification, so the check that NC5 targets must carry it.
  test('[MONGO-URI-19] a URI missing authSource is reported as an authentication-source defect, not a start failure', () => {
    const withoutAuthSource = `mongodb://u:p@mongodb:27017/${IDENTITIES.mongoDb}`;
    let thrown;
    try {
      validateMongoUri(withoutAuthSource, 'auth-surface');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SetupFailure);
    expect(thrown.kind).toBe(SETUP_FAILURE_KINDS.MONGO_URI_AUTHSOURCE);
    // The message frames it as an authentication-source problem, not a bring-up failure.
    expect(thrown.message).toMatch(/authSource/);
  });

  // A wrong authSource (present but not admin) must be caught for the same reason: the roles and
  // users live on admin, so any other authSource authenticates against the wrong database and fails
  // with an error that reads like a wrong password.
  test('[MONGO-URI-19] a URI with authSource other than admin is an authentication-source defect', () => {
    const wrongAuthSource = `mongodb://u:p@mongodb:27017/${IDENTITIES.mongoDb}?authSource=${IDENTITIES.mongoDb}`;
    let thrown;
    try {
      validateMongoUri(wrongAuthSource, 'api-container');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SetupFailure);
    expect(thrown.kind).toBe(SETUP_FAILURE_KINDS.MONGO_URI_AUTHSOURCE);
  });

  // The RESOLVED-ENVIRONMENT side: read each container's resolved MONGO_URI out of the compose file
  // and run the SAME validateMongoUri over it. This is the "resolved container environment" half the
  // task calls for. `docker compose config` resolves the compose file's ${...} interpolation from the
  // per-run env files run.mjs writes, so this is the value the container actually receives — which is
  // what makes the cross-check meaningful rather than a comparison of two independently-authored
  // strings. It needs a resolvable compose file, so it is gated on the live topology and exercised in
  // task 15.
  // Registered ONLY under the live gate; absent it, this live read is not registered and the reporter
  // derives MONGO-URI-19's `skip` record from the catalog (task 14.7). The static [MONGO-URI-19]
  // assertions above run regardless, so the id is recorded either way. A literal `test` callee inside
  // the `if (LIVE)` guard is what lets eslint's jest plugin recognize the block.
  if (LIVE) {
    test('[MONGO-URI-19] each resolved container MONGO_URI passes validateMongoUri', async () => {
      const resolved = await readResolvedMongoUris();
      // The services THIS PROFILE runs — both containers under `split`, the single reused container
      // under `collapsed`. Every one of them must carry a resolved URI; a service the profile does not
      // run is not in the list to begin with, rather than being read and found undefined.
      for (const service of CONTAINER_SERVICES) {
        const uri = resolved[service];
        expect(typeof uri).toBe('string');
        // validateMongoUri names the offending service on failure.
        const parsed = validateMongoUri(uri, service);
        expect(parsed.authSource).toBe('admin');
        expect(parsed.defaultDb).toBe(IDENTITIES.mongoDb);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// [MONGO-AUTH-18] — mongod enforces access control on the observer plane.
// ---------------------------------------------------------------------------------------------
describe('[MONGO-AUTH-18] the Auth_Enabled_MongoDB enforces access control', () => {
  // Registered ONLY under the live gate; absent a live topology neither probe is registered and the
  // reporter derives MONGO-AUTH-18's `skip` record from the catalog (task 14.7). A literal `test`
  // callee inside the `if (LIVE)` guard is what lets eslint's jest plugin recognize the test blocks.
  if (!LIVE) {
    return;
  }

  // An unauthenticated connection to 127.0.0.1:27019 must be REFUSED by mongod. Against a
  // `mongod --noauth` instance the same command would succeed — which is exactly the difference this
  // check exists to catch. The probe issues an authenticated-only command (listing databases across
  // the deployment) with no credential and asserts mongod rejects it with an authorization error.
  test('[MONGO-AUTH-18] an unauthenticated connection is refused by mongod', async () => {
    const { MongoClient, MongoServerError } = await import('mongodb');
    const uri = `mongodb://${OBSERVER_PLANE_ADDRESS}/?authSource=admin`;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: PROBE_TIMEOUT_MS,
      connectTimeoutMS: PROBE_TIMEOUT_MS,
      // Do not retry: a refusal is the expected first outcome; retrying would only slow the failure.
      directConnection: true,
    });
    let refused = false;
    let observed;
    try {
      await client.connect();
      // A command that requires authentication on an access-control-enabled mongod. On --noauth this
      // returns the database list; on --auth with no credential it must throw an authorization error.
      await client.db('admin').command({ listDatabases: 1 });
    } catch (error) {
      refused = true;
      observed = error;
    } finally {
      await client.close().catch(() => {});
    }
    expect(refused).toBe(true);
    // Guard against a silent pass: if the command somehow returned, `refused` is false and this fails
    // with the observation that mongod accepted an unauthenticated privileged command.
    if (!refused) {
      throw new Error(
        `mongod at ${OBSERVER_PLANE_ADDRESS} accepted an unauthenticated listDatabases — access ` +
          'control is NOT enforced. This is the --noauth failure mode MONGO-AUTH-18 exists to catch.',
      );
    }
    expect(observed).toBeDefined();
    // The refusal must be mongod's own authorization/authentication rejection, not a connection or
    // timeout error — a mongod that is simply unreachable would also throw, and that would prove
    // nothing about access control. MongoServerError with an Unauthorized/authentication code is the
    // server refusing; anything else is surfaced so the observation names what actually failed.
    // Decided on the captured error and asserted OUTSIDE the try/catch so the assertion is never
    // nested in the catch (design: MONGO-AUTH-18 refusal is mongod's own auth rejection).
    const isAuthRefusal =
      observed instanceof MongoServerError &&
      (observed.code === 13 || // Unauthorized
        observed.code === 18 || // AuthenticationFailed
        /unauthorized|not authorized|authentication/i.test(observed.message));
    expect(isAuthRefusal).toBe(true);
  });

  // A WRONG credential must fail too. Access control that accepted a bogus username/password would be
  // as broken as one that accepted no credential; asserting both closes the gap between "requires a
  // credential" and "requires the RIGHT credential".
  test('[MONGO-AUTH-18] a wrong credential fails authentication', async () => {
    const { MongoClient, MongoServerError } = await import('mongodb');
    // A username/password that no provisioning run creates. authSource=admin so the failure is an
    // authentication failure at the right database, not an authSource mismatch.
    const uri =
      `mongodb://harness_wrong_user:harness_wrong_password@${OBSERVER_PLANE_ADDRESS}` +
      `/${IDENTITIES.mongoDb}?authSource=admin`;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: PROBE_TIMEOUT_MS,
      connectTimeoutMS: PROBE_TIMEOUT_MS,
      directConnection: true,
    });
    let failed = false;
    let observed;
    try {
      await client.connect();
      await client.db(IDENTITIES.mongoDb).command({ ping: 1 });
    } catch (error) {
      failed = true;
      observed = error;
    } finally {
      await client.close().catch(() => {});
    }
    expect(failed).toBe(true);
    if (!failed) {
      throw new Error(
        `mongod at ${OBSERVER_PLANE_ADDRESS} authenticated a credential no provisioning run creates` +
          ' — access control is NOT enforcing credentials.',
      );
    }
    // The failure must be mongod's own authentication rejection (MongoServerError with an
    // authentication/authorization code or message), not an unreachable-server error. Decided on the
    // captured error and asserted OUTSIDE the try/catch so the assertion is never nested in the catch.
    const isAuthFailure =
      observed instanceof MongoServerError &&
      (observed.code === 18 || // AuthenticationFailed
        observed.code === 13 || // Unauthorized
        /authentication failed|unauthorized|not authorized/i.test(observed.message));
    expect(isAuthFailure).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------------------------

// Read each container service's resolved MONGO_URI out of `docker compose config`. `config` resolves
// the compose file's ${...} interpolation from the per-run env files, so what this returns is the
// value the container actually receives (the "resolved container environment"). Returns a map keyed
// by service name; a service absent from the resolved config (the api-container under the collapsed
// profile) is simply absent from the map. Runs only under the live gate.
async function readResolvedMongoUris() {
  const composeFile = path.join(HERE, '..', 'compose.harness.yml');
  const profile = PROFILE;
  const { stdout } = await execFileAsync(
    'docker',
    ['compose', '-f', composeFile, '--profile', profile, 'config', '--format', 'json'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const config = JSON.parse(stdout);
  const services = config.services ?? {};
  const result = {};
  for (const service of CONTAINER_SERVICES) {
    const def = services[service];
    if (def === undefined) {
      continue;
    }
    // `docker compose config` normalizes `environment:` to an object map. MONGO_URI is the value the
    // container receives; read it from there rather than re-interpolating the compose file's raw
    // string, which would reintroduce the very substitution this read exists to resolve.
    const env = def.environment ?? {};
    if (typeof env.MONGO_URI === 'string') {
      result[service] = env.MONGO_URI;
    }
  }
  return result;
}
