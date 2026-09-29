// run-sequence.test.mjs — unit tests for the exec-runner stage logic (task 15.2).
//
// The whole point of task 15.2's design is that the Docker-touching orchestration is quarantined
// behind ONE injected `exec`, so the STAGE LOGIC — the Layer A lead, image resolution, the nine-value
// preflight, readiness/bring-up classification, the context-primitive assembly, and the ordered
// sequence with its SetupFailure branches — is exercisable WITHOUT Docker, exactly as run.mjs's
// earlier pure functions are. These tests feed a FAKE exec that returns scripted
// `{ status, stdout, stderr }` results and assert the runner classifies each stage's outcome
// correctly and, on a stage failure, throws the right SetupFailure and admits no later stage
// (Property 9).
//
// The ORDER assertions are load-bearing rather than decorative. Layer A ran after bring-up once,
// while a comment claimed it ran first, so a bring-up failure meant the cheap grant answer was never
// collected at all. The tests below pin Layer A ahead of every Docker command and pin a failing
// Layer A to zero Docker commands, so that regression cannot return silently.
//
// Native-ESM Jest under e2e/container-split/jest.config.mjs (its `**/*.test.mjs` pattern). Imports
// run.mjs's pure exports; touches no application code or container-split script (NG1/NG2).

import { execFileSync } from 'node:child_process';

// The application's own hasher, used here to assert the decisive property of the Seeded_Account's
// password hash: the comparison the local login strategy performs succeeds against it (task 11.5).
import bcrypt from 'bcryptjs';

import {
  IDENTITIES,
  SETUP_FAILURE_KINDS,
  SetupFailure,
  resolveHarnessImageTag,
  DEFAULT_HARNESS_IMAGE,
  classifyImagePresence,
  resolveImage,
  parseImageIdentity,
  reuseNoticeFor,
  rebuildCommandFor,
  buildComposeEnv,
  COMPOSE_FILE_PATH,
  COMPOSE_INTERPOLATION_KEYS,
  preflightComposeInterpolation,
  classifyMongoReadiness,
  classifyBringup,
  classifyBringupFailure,
  BRINGUP_FAILURE_MODES,
  findUnhealthyServices,
  findFailedServices,
  parseFailedContainers,
  buildObserverUri,
  buildRootMongoshArgs,
  classifyObserverSnippet,
  buildObserverAndProfilingSnippet,
  buildSeededAccountSnippet,
  generateSeededAccount,
  hashSeededPassword,
  SEEDED_ACCOUNT_BCRYPT_COST,
  SEEDED_ACCOUNT_COLLECTION,
  SEEDED_ACCOUNT_EMAIL_DOMAIN,
  SEEDED_ACCOUNT_PROVIDER,
  SEEDED_ACCOUNT_ROLE,
  assembleContextPrimitives,
  runHarness,
  runLayerAChecks,
  runLayerBChecks,
  LAYER_A_JEST_ARGS,
  REPO_ROOT,
} from './run.mjs';

// A minimal secrets fixture: distinct passwords, the shape generateSecrets produces. Not generated
// (these tests are deterministic), so the values are obvious placeholders.
const SECRETS = Object.freeze({
  MONGO_ROOT_PASSWORD: 'rootpw',
  AUTH_MONGO_PASSWORD: 'authpw',
  API_MONGO_PASSWORD: 'apipw',
  OBSERVER_MONGO_PASSWORD: 'obspw',
  CREDS_KEY: 'k'.repeat(64),
  CREDS_IV: 'i'.repeat(32),
  JWT_SECRET: 'j'.repeat(64),
  JWT_REFRESH_SECRET: 'r'.repeat(64),
  MEILI_MASTER_KEY: 'm'.repeat(64),
});

// A scriptable fake exec. `handler(command, args, opts)` returns the `{ status, stdout, stderr }` for
// that invocation; every call is recorded so a test can assert the ORDER of stages. `ok` is the
// default success result. A handler that returns undefined falls through to `ok`.
function makeFakeExec(handler = () => undefined) {
  const calls = [];
  const exec = async (command, args = [], opts = {}) => {
    calls.push({ command, args, opts });
    const result = handler(command, args, opts);
    return result ?? { status: 0, stdout: '', stderr: '' };
  };
  exec.calls = calls;
  return exec;
}

// A key phrase in each command so a handler can match a stage without matching argv positions.
const joined = (args) => args.join(' ');

// Run a thrower and return the error it threw (or null if it did not throw), so a test asserts on the
// error OUTSIDE any catch block — jest/no-conditional-expect forbids an `expect` inside a catch.
function caught(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe('stage 1 — image resolution', () => {
  test('resolveHarnessImageTag defaults to the harness tag when HARNESS_IMAGE is unset', () => {
    expect(resolveHarnessImageTag({ env: {} })).toBe(DEFAULT_HARNESS_IMAGE);
    expect(resolveHarnessImageTag({ env: { HARNESS_IMAGE: '   ' } })).toBe(DEFAULT_HARNESS_IMAGE);
  });

  test('resolveHarnessImageTag honors an explicit HARNESS_IMAGE', () => {
    expect(resolveHarnessImageTag({ env: { HARNESS_IMAGE: 'my/image:tag' } })).toBe('my/image:tag');
  });

  test('classifyImagePresence reads presence off docker image inspect exit status', () => {
    expect(classifyImagePresence({ status: 0 }).present).toBe(true);
    expect(classifyImagePresence({ status: 1 }).present).toBe(false);
  });

  // A `docker image inspect --format IMAGE_IDENTITY_FORMAT` line: the local id and the RFC3339 created
  // time, tab-separated, as the runner reads them off the format template.
  const IDENTITY_LINE = 'sha256:abc123\t2024-02-03T04:05:06.789Z\n';

  test('a present image is reused as-is, with no build, and carries its identity', async () => {
    const exec = makeFakeExec((command, args) => {
      const a = joined(args);
      // The presence probe (no --format) exits 0; the identity read (--format) returns the id/created.
      if (a.startsWith('image inspect') && a.includes('--format')) {
        return { status: 0, stdout: IDENTITY_LINE, stderr: '' };
      }
      if (a.startsWith('image inspect')) return { status: 0, stdout: '', stderr: '' };
      return undefined;
    });
    const result = await resolveImage({ exec, harnessImage: 'x:local' });
    expect(result).toEqual({
      reference: 'x:local',
      id: 'sha256:abc123',
      createdAt: '2024-02-03T04:05:06.789Z',
      // provenance is 'reused' because this run invoked no build — decided by the code path, not the id.
      provenance: 'reused',
    });
    // No build ran — only the presence probe and the identity read.
    expect(exec.calls.every((c) => !joined(c.args).startsWith('build'))).toBe(true);
  });

  test('an absent image is built from the Dockerfile node target and carries provenance built', async () => {
    const exec = makeFakeExec((command, args) => {
      const a = joined(args);
      if (a.startsWith('image inspect') && a.includes('--format')) {
        // After the build, the now-present image inspects to its identity.
        return { status: 0, stdout: IDENTITY_LINE, stderr: '' };
      }
      if (a.startsWith('image inspect')) return { status: 1, stdout: '', stderr: 'No such image' };
      if (a.startsWith('build')) return { status: 0, stdout: '', stderr: '' };
      return undefined;
    });
    const result = await resolveImage({ exec, harnessImage: 'x:local' });
    expect(result).toEqual({
      reference: 'x:local',
      id: 'sha256:abc123',
      createdAt: '2024-02-03T04:05:06.789Z',
      // This run invoked the build, so provenance is 'built' — even though the identity read could have
      // returned an existing id/old time for a fully cached build.
      provenance: 'built',
    });
    const buildCall = exec.calls.find((c) => joined(c.args).startsWith('build'));
    expect(buildCall.args).toEqual([
      'build',
      '-f',
      'Dockerfile',
      '--target',
      'node',
      '-t',
      'x:local',
      '.',
    ]);
  });

  test('an image that can be neither found nor built throws a named IMAGE_UNRESOLVED SetupFailure', async () => {
    const exec = makeFakeExec((command, args) => {
      const a = joined(args);
      if (a.startsWith('image inspect')) return { status: 1, stdout: '', stderr: '' };
      if (a.startsWith('build')) return { status: 2, stdout: '', stderr: 'build blew up' };
      return undefined;
    });
    const error = await resolveImage({ exec, harnessImage: 'x:local' }).then(
      () => null,
      (e) => e,
    );
    expect(error).toMatchObject({
      isSetupFailure: true,
      kind: SETUP_FAILURE_KINDS.IMAGE_UNRESOLVED,
    });
    // The message names the tag and the command to run.
    expect(error.message).toContain('x:local');
    expect(error.message).toContain('docker build -f Dockerfile --target node');
  });

  test('parseImageIdentity reads id and normalizes the created time to ISO 8601 UTC', () => {
    // A non-UTC offset is normalized to Z; the id is passed through verbatim.
    expect(parseImageIdentity('sha256:deadbeef\t2024-06-01T12:00:00+02:00\n')).toEqual({
      id: 'sha256:deadbeef',
      createdAt: '2024-06-01T10:00:00.000Z',
    });
  });

  test('parseImageIdentity yields nulls for a blank or partial inspect line rather than throwing', () => {
    expect(parseImageIdentity('')).toEqual({ id: null, createdAt: null });
    expect(parseImageIdentity('   ')).toEqual({ id: null, createdAt: null });
    // An id with no created time: id present, createdAt null.
    expect(parseImageIdentity('sha256:only-id')).toEqual({ id: 'sha256:only-id', createdAt: null });
    // An unparseable time is null, not NaN and not a throw.
    expect(parseImageIdentity('sha256:x\tnot-a-date')).toEqual({
      id: 'sha256:x',
      createdAt: null,
    });
  });

  test('reuseNoticeFor prints exactly one notice on reuse, naming the rebuild command for the tag', () => {
    const notice = reuseNoticeFor({ reference: 'x:local', provenance: 'reused' });
    expect(notice).not.toBeNull();
    expect(notice).toContain('may not match the current code');
    expect(notice).toContain(rebuildCommandFor('x:local'));
    expect(notice).toContain('docker build -f Dockerfile --target node -t x:local .');
  });

  test('reuseNoticeFor prints NO notice on a built image (or a null record)', () => {
    expect(reuseNoticeFor({ reference: 'x:local', provenance: 'built' })).toBeNull();
    expect(reuseNoticeFor(null)).toBeNull();
    expect(reuseNoticeFor(undefined)).toBeNull();
  });
});

describe('stage 2 — the nine compose interpolation values', () => {
  test('buildComposeEnv resolves all nine plus COMPOSE_FILE from IDENTITIES and the secrets', () => {
    const env = buildComposeEnv(SECRETS, { harnessImage: 'x:local' });
    expect(env).toEqual({
      COMPOSE_FILE: COMPOSE_FILE_PATH,
      HARNESS_IMAGE: 'x:local',
      MONGO_ROOT_USERNAME: IDENTITIES.rootUsername,
      MONGO_ROOT_PASSWORD: SECRETS.MONGO_ROOT_PASSWORD,
      MONGO_DB: IDENTITIES.mongoDb,
      AUTH_MONGO_USERNAME: IDENTITIES.authUsername,
      AUTH_MONGO_PASSWORD: SECRETS.AUTH_MONGO_PASSWORD,
      API_MONGO_USERNAME: IDENTITIES.apiUsername,
      API_MONGO_PASSWORD: SECRETS.API_MONGO_PASSWORD,
      MEILI_MASTER_KEY: SECRETS.MEILI_MASTER_KEY,
    });
    // Every interpolation key the compose file needs is present and non-empty.
    for (const key of COMPOSE_INTERPOLATION_KEYS) {
      expect(typeof env[key]).toBe('string');
      expect(env[key].length).toBeGreaterThan(0);
    }
  });

  test('preflight passes a complete env unchanged', () => {
    const env = buildComposeEnv(SECRETS, { harnessImage: 'x:local' });
    expect(preflightComposeInterpolation(env)).toBe(env);
  });

  test('preflight names every unresolved value in one INTERPOLATION_UNRESOLVED SetupFailure', () => {
    const env = buildComposeEnv(SECRETS, { harnessImage: 'x:local' });
    delete env.MEILI_MASTER_KEY;
    env.API_MONGO_PASSWORD = '';
    const error = caught(() => preflightComposeInterpolation(env));
    expect(error).toBeInstanceOf(SetupFailure);
    expect(error.kind).toBe(SETUP_FAILURE_KINDS.INTERPOLATION_UNRESOLVED);
    expect(error.message).toContain('MEILI_MASTER_KEY');
    expect(error.message).toContain('API_MONGO_PASSWORD');
  });
});

describe('stage 5/9 — readiness and bring-up classification', () => {
  test('classifyMongoReadiness ok on exit 0', () => {
    expect(classifyMongoReadiness({ status: 0 }).ok).toBe(true);
  });

  test('classifyMongoReadiness throws MONGO_READINESS_TIMEOUT with the log tail on non-zero', () => {
    const error = caught(() => classifyMongoReadiness({ status: 1, logTail: 'mongod said no' }));
    expect(error.kind).toBe(SETUP_FAILURE_KINDS.MONGO_READINESS_TIMEOUT);
    expect(error.service).toBe('mongodb');
    expect(error.detail).toBe('mongod said no');
  });

  test('classifyBringup ok on exit 0', () => {
    expect(classifyBringup({ status: 0 }).ok).toBe(true);
  });

  test('classifyBringup names the service still not serving on a genuine readiness timeout', () => {
    const error = caught(() =>
      classifyBringup(
        { status: 1 },
        {
          failure: {
            mode: BRINGUP_FAILURE_MODES.READINESS_TIMEOUT,
            failed: [{ name: 'harness-auth-surface', service: 'auth-surface', health: 'starting' }],
          },
          logTail: 'tail',
        },
      ),
    );
    expect(error.kind).toBe(SETUP_FAILURE_KINDS.BRINGUP_TIMEOUT);
    expect(error.message).toContain('harness-auth-surface');
    expect(error.message).toContain('starting');
    expect(error.service).toBe('auth-surface');
    expect(error.detail).toBe('tail');
  });

  test('findUnhealthyServices flags a starting service and ignores a cleanly exited one-shot', () => {
    const psl = [
      JSON.stringify({
        Name: 'harness-mongodb',
        Service: 'mongodb',
        Health: 'healthy',
        State: 'running',
      }),
      JSON.stringify({
        Name: 'harness-provision',
        Service: 'provision',
        Health: '',
        State: 'exited',
        ExitCode: 0,
      }),
      JSON.stringify({
        Name: 'harness-proxy',
        Service: 'proxy',
        Health: 'starting',
        State: 'running',
      }),
    ].join('\n');
    const unhealthy = findUnhealthyServices(psl);
    expect(unhealthy.map((u) => u.service)).toEqual(['proxy']);
  });

  test('findUnhealthyServices flags a non-zero exited service', () => {
    const psl = JSON.stringify({
      Name: 'harness-api-container',
      Service: 'api-container',
      Health: '',
      State: 'exited',
      ExitCode: 1,
    });
    expect(findUnhealthyServices(psl).map((u) => u.service)).toEqual(['api-container']);
  });

  test('parseFailedContainers recovers the service from a compose "exited" stderr line', () => {
    const stderr = 'dependency failed to start: container harness-api-container exited (1)\n';
    const parsed = parseFailedContainers(stderr);
    expect(parsed).toEqual([
      {
        name: 'harness-api-container',
        service: 'api-container',
        health: 'exited (1)',
        state: 'exited',
      },
    ]);
  });

  test('parseFailedContainers recovers an "is unhealthy" service too', () => {
    const parsed = parseFailedContainers('container harness-auth-surface is unhealthy');
    expect(parsed[0]).toMatchObject({ service: 'auth-surface', state: 'unhealthy' });
  });
});

// ---------------------------------------------------------------------------------------------
// The two DIFFERENT failures a non-zero `docker compose up --wait` can mean.
//
// These tests are written around a real observed failure, because the classifier got all three of its
// claims wrong on it at once. Compose aborted in about fourteen seconds with
//   dependency failed to start: container harness-auth-surface exited (1)
// and the report said `bringup-timeout: Bring-up did not reach a healthy topology within 300s`,
// listing `harness-proxy` among the unhealthy services — a container that never started at all,
// because its dependency had failed first. Three defects: an elapsed time nobody observed, the wrong
// failure mode, and a name that was a consequence rather than the cause.
//
// The captured compose output below is that failure's shape. Pure over strings — no spawning.
// ---------------------------------------------------------------------------------------------
describe('stage 9 — telling a container failure from a readiness timeout', () => {
  // What `up --wait` wrote to stderr in the observed failure.
  const DEPENDENCY_FAILED_STDERR =
    'dependency failed to start: container harness-auth-surface exited (1)\n';

  // What `ps -a` reported at the same moment: mongod healthy, the provision one-shot cleanly exited,
  // the auth surface exited(1) — and the proxy left `created`, because it never started.
  const PS_AFTER_DEPENDENCY_FAILURE = [
    JSON.stringify({
      Name: 'harness-mongodb',
      Service: 'mongodb',
      Health: 'healthy',
      State: 'running',
    }),
    JSON.stringify({
      Name: 'harness-provision',
      Service: 'provision',
      Health: '',
      State: 'exited',
      ExitCode: 0,
    }),
    JSON.stringify({
      Name: 'harness-auth-surface',
      Service: 'auth-surface',
      Health: '',
      State: 'exited',
      ExitCode: 1,
    }),
    JSON.stringify({ Name: 'harness-proxy', Service: 'proxy', Health: '', State: 'created' }),
  ].join('\n');

  // A genuine timeout: nothing exited, one service simply never went healthy inside the window.
  const PS_AFTER_READINESS_TIMEOUT = [
    JSON.stringify({
      Name: 'harness-mongodb',
      Service: 'mongodb',
      Health: 'healthy',
      State: 'running',
    }),
    JSON.stringify({
      Name: 'harness-auth-surface',
      Service: 'auth-surface',
      Health: 'starting',
      State: 'running',
    }),
  ].join('\n');

  test('findFailedServices reports only what actually failed, not everything not-healthy', () => {
    const failed = findFailedServices(PS_AFTER_DEPENDENCY_FAILURE);
    // The auth surface exited non-zero. The proxy is `created` — it never ran, so it did not fail, and
    // naming it buries the one name that matters.
    expect(failed.map((f) => f.service)).toEqual(['auth-surface']);
    expect(failed[0].health).toBe('exited (1)');
    // Contrast the WIDE reading, which is right only in the timeout mode: it flags the proxy too.
    expect(findUnhealthyServices(PS_AFTER_DEPENDENCY_FAILURE).map((f) => f.service)).toEqual([
      'auth-surface',
      'proxy',
    ]);
  });

  test('findFailedServices flags an unhealthy-but-running service', () => {
    const psl = JSON.stringify({
      Name: 'harness-api-container',
      Service: 'api-container',
      Health: 'unhealthy',
      State: 'running',
    });
    expect(findFailedServices(psl).map((f) => f.service)).toEqual(['api-container']);
  });

  test('findFailedServices ignores a cleanly exited one-shot and a merely-pending service', () => {
    expect(findFailedServices(PS_AFTER_READINESS_TIMEOUT)).toEqual([]);
  });

  test('the observed dependency failure classifies as CONTAINER_FAILED naming only the auth surface', () => {
    const failure = classifyBringupFailure({
      stderr: DEPENDENCY_FAILED_STDERR,
      psOutput: PS_AFTER_DEPENDENCY_FAILURE,
    });
    expect(failure.mode).toBe(BRINGUP_FAILURE_MODES.CONTAINER_FAILED);
    expect(failure.failed.map((f) => f.service)).toEqual(['auth-surface']);
  });

  test('stderr and ps are unioned, so neither source alone can hide a failure', () => {
    // `ps -a` can have already swept the exited container, reporting nothing failed…
    const fromStderrOnly = classifyBringupFailure({
      stderr: DEPENDENCY_FAILED_STDERR,
      psOutput: '',
    });
    expect(fromStderrOnly.mode).toBe(BRINGUP_FAILURE_MODES.CONTAINER_FAILED);
    expect(fromStderrOnly.failed.map((f) => f.service)).toEqual(['auth-surface']);

    // …and stderr names only the container compose tripped over, so a second failure shows up in ps.
    const both = classifyBringupFailure({
      stderr: DEPENDENCY_FAILED_STDERR,
      psOutput: JSON.stringify({
        Name: 'harness-api-container',
        Service: 'api-container',
        Health: '',
        State: 'exited',
        ExitCode: 1,
      }),
    });
    expect(both.failed.map((f) => f.service).sort()).toEqual(['api-container', 'auth-surface']);
  });

  test('a container named by both sources is reported once', () => {
    const failure = classifyBringupFailure({
      stderr: DEPENDENCY_FAILED_STDERR,
      psOutput: JSON.stringify({
        Name: 'harness-auth-surface',
        Service: 'auth-surface',
        Health: '',
        State: 'exited',
        ExitCode: 1,
      }),
    });
    expect(failure.failed).toHaveLength(1);
  });

  test('nothing failed => READINESS_TIMEOUT, naming the service still not serving', () => {
    const failure = classifyBringupFailure({
      stderr: 'container harness-auth-surface is starting\n',
      psOutput: PS_AFTER_READINESS_TIMEOUT,
    });
    expect(failure.mode).toBe(BRINGUP_FAILURE_MODES.READINESS_TIMEOUT);
    expect(failure.failed.map((f) => f.service)).toEqual(['auth-surface']);
  });

  test('a container failure reports the container mode, not a 300-second timeout', () => {
    const failure = classifyBringupFailure({
      stderr: DEPENDENCY_FAILED_STDERR,
      psOutput: PS_AFTER_DEPENDENCY_FAILURE,
    });
    const error = caught(() =>
      classifyBringup(
        { status: 1 },
        { failure, logTail: 'auth-surface log tail', elapsedMs: 14_200 },
      ),
    );

    expect(error.kind).toBe(SETUP_FAILURE_KINDS.BRINGUP_CONTAINER_FAILED);
    expect(error.kind).not.toBe(SETUP_FAILURE_KINDS.BRINGUP_TIMEOUT);
    // It names the container that failed, and ONLY that one.
    expect(error.message).toContain('harness-auth-surface');
    expect(error.message).toContain('exited (1)');
    expect(error.message).not.toContain('harness-proxy');
    expect(error.service).toBe('auth-surface');
    // The elapsed time is the one the runner MEASURED. It never claims the readiness budget was spent.
    expect(error.message).toContain('Observed elapsed: 14.2s');
    expect(error.message).not.toMatch(/within 300s/);
    // The SetupFailure shape and Property 9 behavior are unchanged.
    expect(error.isSetupFailure).toBe(true);
    expect(error.detail).toBe('auth-surface log tail');
    expect(error.message).toContain('No request-level check is admitted');
  });

  test('an unmeasured elapsed time is not asserted at all', () => {
    const failure = classifyBringupFailure({
      stderr: DEPENDENCY_FAILED_STDERR,
      psOutput: PS_AFTER_DEPENDENCY_FAILURE,
    });
    const error = caught(() => classifyBringup({ status: 1 }, { failure }));
    expect(error.message).not.toMatch(/Observed elapsed/);
  });

  test('a readiness timeout frames 300s as the budget and says nothing exited', () => {
    const failure = classifyBringupFailure({ psOutput: PS_AFTER_READINESS_TIMEOUT });
    const error = caught(() =>
      classifyBringup({ status: 1 }, { failure, elapsedMs: 301_000, logTail: 'tail' }),
    );
    expect(error.kind).toBe(SETUP_FAILURE_KINDS.BRINGUP_TIMEOUT);
    expect(error.message).toContain('300s readiness budget');
    expect(error.message).toContain('no container exited or reported unhealthy');
    expect(error.message).toContain('Observed elapsed: 301s');
  });

  test('a non-zero up with no diagnosable output still fails, saying it could name nothing', () => {
    // Honest degradation: the run must not pass, and the message must not invent a service.
    const failure = classifyBringupFailure({ stderr: '', psOutput: '' });
    const error = caught(() => classifyBringup({ status: 1 }, { failure }));
    expect(error.kind).toBe(SETUP_FAILURE_KINDS.BRINGUP_TIMEOUT);
    expect(error.service).toBe('bringup');
    expect(error.message).toContain('named no pending service');
  });
});

describe('stage 7 — the harness-owned root snippet', () => {
  test('buildRootMongoshArgs targets the loopback observer plane as root, reading the snippet from stdin', () => {
    const args = buildRootMongoshArgs(SECRETS);
    expect(args[0]).toContain(`${IDENTITIES.rootUsername}:${SECRETS.MONGO_ROOT_PASSWORD}@`);
    expect(args[0]).toContain('127.0.0.1:27019');
    expect(args[0]).toContain('authSource=admin');
    expect(args).toContain('--file');
    expect(args).toContain('/dev/stdin');
  });

  test('classifyObserverSnippet ok on exit 0, OBSERVER_SNIPPET_FAILED otherwise', () => {
    expect(classifyObserverSnippet({ status: 0 }).ok).toBe(true);
    const error = caught(() => classifyObserverSnippet({ status: 3, stderr: 'role exists' }));
    expect(error.kind).toBe(SETUP_FAILURE_KINDS.OBSERVER_SNIPPET_FAILED);
    expect(error.detail).toBe('role exists');
  });
});

// ---------------------------------------------------------------------------------------------
// The `Seeded_Account` insert (task 11.5; Req 3.16, 3.17, 3.18).
//
// Three constraints are decided here, all of them structural rather than observational, because the
// insert itself needs a live mongod:
//
//   * It is a step of the HARNESS-OWNED ROOT snippet, so it runs under the Root_Credential and never
//     under the Container_1_Grant (Req 3.17). Seeding with the grant the checks decide on would test
//     the grant with itself.
//   * It is the LAST step of that snippet, which the runner applies before `captureBootStart()`, so the
//     write completes ahead of the boot window BOOT-NOWRITE-23 counts writes inside (Req 3.18).
//   * The password hash is bcrypt at the application's own cost factor, so the login comparison
//     succeeds and the stored hash is not a second convention.
// ---------------------------------------------------------------------------------------------
describe('stage 6 — the Seeded_Account insert', () => {
  test('the generated account is a per-run identity with an unroutable address and the default role', () => {
    const first = generateSeededAccount();
    const second = generateSeededAccount();

    // 12 random bytes as hex — exactly what `ObjectId(<24 hex>)` takes, so the runner can publish the
    // id the recorded /api/auth/resetPassword payload references.
    expect(first.id).toMatch(/^[0-9a-f]{24}$/);
    expect(first.id).not.toBe(second.id);
    expect(first.password).not.toBe(second.password);
    // Long past the 8-character minimum `loginSchema` and the user schema both enforce, under the 128
    // maximum.
    expect(first.password.length).toBeGreaterThanOrEqual(8);
    expect(first.password.length).toBeLessThan(128);
    // `.invalid` can never resolve (RFC 2606), and the address is lowercase because the schema
    // lowercases both `email` and `username`.
    expect(first.email.endsWith(`@${SEEDED_ACCOUNT_EMAIL_DOMAIN}`)).toBe(true);
    expect(first.email).toBe(first.email.toLowerCase());
    expect(first.username).toBe(first.username.toLowerCase());
    // An ORDINARY user: the admin-login exercise's recorded 403 is the capability middleware's answer
    // for a non-admin, so an admin seed would change what that path observes.
    expect(first.role).toBe(SEEDED_ACCOUNT_ROLE);
    expect(first.provider).toBe(SEEDED_ACCOUNT_PROVIDER);
  });

  test('the password hash is bcrypt at the cost factor the registration path uses, and it verifies', () => {
    const account = generateSeededAccount();
    const hash = hashSeededPassword(account.password);

    // `$2a$10$…` — the cost factor `registerUser` spells as `bcrypt.genSaltSync(10)`
    // (api/server/services/AuthService.js). A different factor would still verify, but it would be a
    // second convention the application never writes.
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(SEEDED_ACCOUNT_BCRYPT_COST).toBe(10);
    // The decisive property: the comparison the local strategy performs (`comparePassword` →
    // `bcrypt.compare`) succeeds against this hash. Asserted with the application's own library.
    expect(bcrypt.compareSync(account.password, hash)).toBe(true);
    expect(bcrypt.compareSync('not-the-password', hash)).toBe(false);
  });

  test('the insert snippet writes the field set the login path reads, and never the plaintext password', () => {
    const account = generateSeededAccount();
    const snippet = buildSeededAccountSnippet(IDENTITIES.mongoDb, account);

    expect(snippet).toContain(`getSiblingDB(${JSON.stringify(IDENTITIES.mongoDb)})`);
    expect(snippet).toContain(JSON.stringify(SEEDED_ACCOUNT_COLLECTION));
    expect(snippet).toContain(`ObjectId(${JSON.stringify(account.id)})`);
    expect(snippet).toContain('insertOne(');
    // What the login path reads: the address `findUser` looks up, a verified email so login does not
    // divert into the verification branch, the local provider `comparePassword` requires, and
    // twoFactorEnabled false so `loginController` mints a token instead of answering `twoFAPending`.
    expect(snippet).toContain(JSON.stringify(account.email));
    expect(snippet).toContain('"emailVerified":true');
    expect(snippet).toContain(`"provider":"${SEEDED_ACCOUNT_PROVIDER}"`);
    expect(snippet).toContain('"twoFactorEnabled":false');
    expect(snippet).toContain(`"role":"${SEEDED_ACCOUNT_ROLE}"`);
    // `localStrategy` reads `createdAt`; an absent value makes its comparison NaN.
    expect(snippet).toContain('createdAt: new Date()');
    // The PLAINTEXT never reaches the database — only the bcrypt hash does.
    expect(snippet).not.toContain(account.password);
    expect(snippet).toMatch(/\$2[aby]\$10\$/);
    // A seed that did not land must fail loudly: mongosh exits non-zero on a throw, so the run reports
    // a setup failure instead of a session mint that fails later for an unstated reason.
    expect(snippet).toContain('countDocuments(');
    expect(snippet).toContain('throw new Error(');
  });

  test('the seed is the LAST step of the root snippet — after profiling, before the boot-window edge', () => {
    const account = generateSeededAccount();
    const snippet = buildObserverAndProfilingSnippet(IDENTITIES.mongoDb, 'obspw', {
      seededAccount: account,
    });

    const observer = snippet.indexOf('createRole(');
    const profilingOn = snippet.indexOf('setProfilingLevel(2)');
    const insert = snippet.indexOf('insertOne(');
    expect(observer).toBeGreaterThan(-1);
    expect(profilingOn).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(-1);
    // Observer, then profiling, then the seed. After profiling so BOOT-NOWRITE-23 reads a profile that
    // records the write; last so it is still ahead of the timestamp the runner takes next.
    expect(observer).toBeLessThan(profilingOn);
    expect(profilingOn).toBeLessThan(insert);
    // And with no account supplied the snippet is exactly the observer + profiling text, so a caller
    // that needs only those two is unchanged.
    expect(buildObserverAndProfilingSnippet(IDENTITIES.mongoDb, 'obspw')).not.toContain(
      'insertOne(',
    );
  });

  test('runHarness feeds the seed to mongosh before the boot timestamp and publishes it on the bridge', async () => {
    const account = generateSeededAccount();
    const exec = makeFakeExec((command, args) =>
      joined(args).includes('provision') ? { status: 0, stdout: 'Done.\n', stderr: '' } : undefined,
    );
    // A monotonic clock: every `now()` is one tick later, so the boot timestamp's tick can be compared
    // against the tick at which the snippet was fed to mongosh.
    let tick = 0;
    const now = () => {
      tick += 1;
      return tick;
    };
    const mongoshTick = { value: null };
    const tracingExec = async (command, args, opts) => {
      if (command === 'mongosh') {
        mongoshTick.value = tick;
      }
      return exec(command, args, opts);
    };

    const { contextPrimitives } = await runHarness({
      exec: tracingExec,
      profile: 'split',
      secrets: SECRETS,
      harnessImage: 'x:local',
      pollReadyz: async () => ({ readyAtMs: 12345 }),
      seededAccount: account,
      now,
      stdout: { write() {} },
    });

    const mongoshCall = exec.calls.find((call) => call.command === 'mongosh');
    // The insert travels on the SAME stdin snippet as the observer credential and the profile sizing,
    // which is what puts it under the Root_Credential (Req 3.17).
    expect(mongoshCall.opts.input).toContain('insertOne(');
    expect(mongoshCall.opts.input).toContain(`ObjectId(${JSON.stringify(account.id)})`);
    // And it is fed before the boot window's left edge is recorded (Req 3.18).
    expect(mongoshTick.value).toBeLessThan(contextPrimitives.bootStart.epochMs);
    // Published on the bridge so the checks can resolve their recorded payloads and mint the session.
    expect(contextPrimitives.seededAccount).toEqual(account);
    expect(() => JSON.stringify(contextPrimitives)).not.toThrow();
  });
});

describe('stage 10 — context-primitive assembly', () => {
  test('buildObserverUri points the observer at the loopback plane on admin', () => {
    const uri = buildObserverUri('obspw');
    expect(uri).toContain(`${IDENTITIES.observerUsername}:obspw@`);
    expect(uri).toContain('127.0.0.1:27019');
    expect(uri).toContain(`/${IDENTITIES.mongoDb}?authSource=admin`);
  });

  test('assembleContextPrimitives carries exactly the serializable shape the bridge writes', () => {
    const bootStart = { epochMs: 1000, iso: '1970-01-01T00:00:01.000Z' };
    const ctx = assembleContextPrimitives({
      profile: 'split',
      secrets: SECRETS,
      bootStart,
      readyAtMs: 5000,
    });
    expect(ctx.profile).toBe('split');
    expect(ctx.observerUri).toBe(buildObserverUri(SECRETS.OBSERVER_MONGO_PASSWORD));
    expect(ctx.bootStart).toEqual(bootStart);
    expect(ctx.readyAtMs).toBe(5000);
    expect(ctx.window).toEqual({ since: bootStart.iso });
    // It must be JSON-serializable — it crosses a process boundary as a file.
    expect(() => JSON.stringify(ctx)).not.toThrow();
  });

  test('the bridge carries the nine compose interpolation values, so a check that spawns compose resolves the same project', () => {
    // Without this, every check that reads the live topology through `docker compose` failed with
    // `The "HARNESS_IMAGE" variable is not set … invalid compose project` while the topology it was
    // reading stood up healthy beside it: compose.harness.yml carries no defaults (deliberately) and the
    // Layer B Jest process does not inherit what the runner passes per compose invocation.
    const composeEnv = buildComposeEnv(SECRETS, { harnessImage: 'x:local' });
    const ctx = assembleContextPrimitives({
      profile: 'split',
      secrets: SECRETS,
      bootStart: { epochMs: 1000, iso: '1970-01-01T00:00:01.000Z' },
      readyAtMs: 5000,
      composeEnv,
    });
    for (const key of COMPOSE_INTERPOLATION_KEYS) {
      expect(ctx.composeEnv[key]).toBe(composeEnv[key]);
    }
    expect(ctx.composeEnv.COMPOSE_FILE).toBe(COMPOSE_FILE_PATH);
    expect(() => JSON.stringify(ctx)).not.toThrow();
  });

  test('runHarness publishes the same nine values it brought the topology up with', async () => {
    const exec = makeFakeExec((command, args) => {
      const a = joined(args);
      if (a.includes('provision')) {
        return { status: 0, stdout: 'Done.\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const { contextPrimitives } = await runHarness({
      exec,
      profile: 'split',
      secrets: SECRETS,
      harnessImage: 'x:local',
      pollReadyz: async () => ({ readyAtMs: 12345 }),
      stdout: { write() {} },
    });
    // Identical to the env every `docker compose` call in the sequence ran with — not a second map
    // assembled independently, which could resolve a different project than the one that came up.
    const composeCall = exec.calls.find(
      (c) => c.command === 'docker' && c.args.includes('compose'),
    );
    expect(contextPrimitives.composeEnv).toEqual(composeCall.opts.env);
  });
});

describe('stage 1 — Layer A leads the sequence', () => {
  test('runLayerAChecks spawns the api workspace Jest over test/container-split', async () => {
    const exec = makeFakeExec();
    await runLayerAChecks({ exec });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].command).toBe('npx');
    expect(exec.calls[0].args).toEqual([...LAYER_A_JEST_ARGS]);
    // Run FROM the api workspace so the api Jest config (memory-server fixtures, mongosh spawns)
    // applies. It needs no image and no topology, which is what lets it precede bring-up. Asserted
    // by prefix and leaf rather than by a joined string, so the separator is the platform's.
    expect(exec.calls[0].opts.cwd.startsWith(REPO_ROOT)).toBe(true);
    expect(exec.calls[0].opts.cwd.endsWith('api')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Stage 11 — the environment a compose-reading check sees AT CALL TIME.
//
// TOPO-ENV-14 and MONGO-URI-19 spawn `docker compose … config --format json`, whose interpolation
// compose.harness.yml declares with no defaults. Their exec seams call `execFile('docker', argv)` with
// no `env`, so what decides those reads is the REAL environment of the process that spawns docker —
// two hops down from the runner: runner → Layer B Jest → docker.
//
// An earlier fix asserted only that the context bridge CONTAINED the nine, and applied them inside
// Jest with `process.env[key] = value`. The bridge assertion passed and the live run still failed:
// Jest hands each test environment a clone of `process`, so that write never reached the docker child.
// So the assertions below are about the CHILD ENVIRONMENT, not about the bridge — the first pins the
// spawn options, the second walks the real two-hop inheritance with real child processes (no Docker).
// ---------------------------------------------------------------------------------------------
describe('stage 11 — the Layer B child environment carries the nine', () => {
  // Capture the spawn options runLayerBChecks asks for.
  async function layerBSpawnOptions(composeEnv) {
    const calls = [];
    const exec = async (command, args, opts) => {
      calls.push({ command, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    await runLayerBChecks({
      exec,
      contextFile: '/tmp/harness-context.json',
      profile: 'split',
      composeEnv,
    });
    return calls[0].opts;
  }

  test('runLayerBChecks hands the nine (plus COMPOSE_FILE) to the Jest process it spawns', async () => {
    const composeEnv = buildComposeEnv(SECRETS, { harnessImage: 'x:local' });
    const opts = await layerBSpawnOptions(composeEnv);
    for (const key of COMPOSE_INTERPOLATION_KEYS) {
      expect(opts.env[key]).toBe(composeEnv[key]);
    }
    expect(opts.env.COMPOSE_FILE).toBe(COMPOSE_FILE_PATH);
    // The harness's own four are untouched by the merge.
    expect(opts.env.HARNESS_LIVE).toBe('1');
    expect(opts.env.NODE_OPTIONS).toBe('--experimental-vm-modules');
  });

  test('a check spawning docker with no env inherits all nine, two hops down', () => {
    // Hop 1: the Layer B Jest process, started with the env runLayerBChecks asks for merged over the
    // runner's own (what run.mjs's real exec seam does). Hop 2: the `docker` a check spawns with no
    // `env` option at all, which is the shape of every compose-reading seam in checks/. Real child
    // processes, so this asserts the actual inheritance rather than a model of it — and it is `node`,
    // not `docker`: the question is what the environment carries, not what compose does with it.
    const composeEnv = buildComposeEnv(SECRETS, { harnessImage: 'x:local' });
    const layerBEnv = {
      ...process.env,
      NO_COLOR: '1',
      ...composeEnv,
      NODE_OPTIONS: '--experimental-vm-modules',
      HARNESS_LIVE: '1',
      HARNESS_PROFILE: 'split',
    };
    const grandchild = 'process.stdout.write(JSON.stringify(process.env))';
    const hopOne =
      "const { execFileSync } = require('node:child_process');" +
      `process.stdout.write(execFileSync(process.execPath, ['-e', ${JSON.stringify(
        grandchild,
      )}]).toString());`;
    const seen = JSON.parse(
      execFileSync(process.execPath, ['-e', hopOne], {
        env: layerBEnv,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      }),
    );
    // Every interpolation key arrives non-blank at the seam that spawns compose. A blank is the exact
    // shape of the failure: `The "HARNESS_IMAGE" variable is not set. Defaulting to a blank string.`
    const blank = COMPOSE_INTERPOLATION_KEYS.filter((key) => (seen[key] ?? '') === '');
    expect(blank).toEqual([]);
    for (const key of COMPOSE_INTERPOLATION_KEYS) {
      expect(seen[key]).toBe(composeEnv[key]);
    }
    expect(seen.COMPOSE_FILE).toBe(COMPOSE_FILE_PATH);
  });
});

describe('runHarness — the ordered sequence over a fake exec', () => {
  // A fake exec that succeeds at every stage, plus a fake /readyz poller. Records the argv order so
  // the test can assert Layer A first, then image, then mongod, then provision, then bring-up.
  function successExec() {
    return makeFakeExec((command, args) => {
      const a = joined(args);
      if (command === 'npx') return { status: 0 };
      if (command === 'docker' && a.startsWith('image inspect')) return { status: 0 };
      if (command === 'mongosh') return { status: 0 };
      // Every `docker compose …` returns success; the provision run must emit Done. on stdout.
      if (a.includes('run --rm provision') || (a.includes('run') && a.includes('provision'))) {
        return { status: 0, stdout: 'Done.\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
  }

  const pollReadyz = async () => ({ readyAtMs: 12345 });

  test('a clean run returns the context primitives and runs the stages in order', async () => {
    const exec = successExec();
    const { contextPrimitives, image, layerA, abortedBeforeBringup } = await runHarness({
      exec,
      profile: 'split',
      secrets: SECRETS,
      harnessImage: 'x:local',
      pollReadyz,
      now: () => 999,
      stdout: { write() {} },
    });
    // A present image is reused; runHarness now returns the identity record, not a bare tag.
    expect(image.reference).toBe('x:local');
    expect(image.provenance).toBe('reused');
    expect(contextPrimitives.readyAtMs).toBe(12345);
    expect(contextPrimitives.profile).toBe('split');
    expect(layerA.status).toBe(0);
    expect(abortedBeforeBringup).toBe(false);

    // Order: Layer A precedes image inspect, which precedes the mongod-only `compose up`, which
    // precedes provision, which precedes the mongosh snippet, which precedes the full bring-up.
    const labels = exec.calls.map((c) => `${c.command} ${joined(c.args)}`);
    const idxLayerA = labels.findIndex((l) => l.startsWith('npx jest'));
    const idxInspect = labels.findIndex((l) => l.includes('image inspect'));
    const idxMongoUp = labels.findIndex((l) => l.includes('up') && l.includes('mongodb'));
    const idxProvision = labels.findIndex((l) => l.includes('provision'));
    const idxSnippet = labels.findIndex((l) => l.startsWith('mongosh'));
    expect(idxLayerA).toBe(0);
    expect(idxLayerA).toBeLessThan(idxInspect);
    expect(idxInspect).toBeLessThan(idxMongoUp);
    expect(idxMongoUp).toBeLessThan(idxProvision);
    expect(idxProvision).toBeLessThan(idxSnippet);
  });

  test('runHarness spawns Layer B nowhere — Layer B is the caller\u2019s stage 11', async () => {
    const exec = successExec();
    await runHarness({
      exec,
      profile: 'split',
      secrets: SECRETS,
      harnessImage: 'x:local',
      pollReadyz,
      stdout: { write() {} },
    });
    // Exactly one Jest spawn happens inside runHarness: Layer A. Layer B needs the published context
    // bridge, so the caller spawns it after stage 10 — a second `npx jest` here would mean Layer B ran
    // against a context that may not exist.
    const jestCalls = exec.calls.filter((c) => c.command === 'npx');
    expect(jestCalls).toHaveLength(1);
    expect(jestCalls[0].args).toEqual([...LAYER_A_JEST_ARGS]);
  });

  test('a non-zero Layer A ends the run before any Docker command is issued', async () => {
    const exec = makeFakeExec((command) =>
      command === 'npx' ? { status: 1, stdout: '', stderr: 'grant shape drifted' } : undefined,
    );
    const result = await runHarness({
      exec,
      profile: 'split',
      secrets: SECRETS,
      harnessImage: 'x:local',
      pollReadyz,
      stdout: { write() {} },
    });
    expect(result.abortedBeforeBringup).toBe(true);
    expect(result.layerA.status).toBe(1);
    expect(result.contextPrimitives).toBeNull();
    // The point of the ordering: NO Docker time is spent. Not an inspect, not a build, not an `up`.
    expect(exec.calls.map((c) => c.command)).toEqual(['npx']);
  });

  test('a mongod readiness timeout ends the run before provisioning (no script runs)', async () => {
    const exec = makeFakeExec((command, args) => {
      const a = joined(args);
      if (command === 'docker' && a.startsWith('image inspect')) return { status: 0 };
      if (a.includes('up') && a.includes('mongodb')) return { status: 1, stderr: 'timeout' };
      if (a.includes('logs')) return { status: 0, stdout: 'mongod log tail' };
      return { status: 0 };
    });
    await expect(
      runHarness({
        exec,
        profile: 'split',
        secrets: SECRETS,
        harnessImage: 'x:local',
        pollReadyz,
        stdout: { write() {} },
      }),
    ).rejects.toMatchObject({ kind: SETUP_FAILURE_KINDS.MONGO_READINESS_TIMEOUT });
    // No provisioning `run` was attempted after the readiness timeout (Property 9 ordering).
    expect(exec.calls.some((c) => joined(c.args).includes('provision'))).toBe(false);
  });

  test('a provisioning failure ends the run before the root snippet', async () => {
    const exec = makeFakeExec((command, args) => {
      const a = joined(args);
      if (command === 'docker' && a.startsWith('image inspect')) return { status: 0 };
      if (a.includes('provision')) return { status: 1, stdout: '', stderr: 'provision blew up' };
      return { status: 0 };
    });
    await expect(
      runHarness({
        exec,
        profile: 'split',
        secrets: SECRETS,
        harnessImage: 'x:local',
        pollReadyz,
        stdout: { write() {} },
      }),
    ).rejects.toMatchObject({ kind: SETUP_FAILURE_KINDS.PROVISION_FAILED });
    // The mongosh root snippet never ran.
    expect(exec.calls.some((c) => c.command === 'mongosh')).toBe(false);
  });

  test('a bring-up timeout is classified with the unhealthy service named', async () => {
    const exec = makeFakeExec((command, args) => {
      const a = joined(args);
      if (command === 'docker' && a.startsWith('image inspect')) return { status: 0 };
      if (command === 'mongosh') return { status: 0 };
      if (a.includes('run') && a.includes('provision')) return { status: 0, stdout: 'Done.\n' };
      // The mongod-only `up mongodb` succeeds; the full `up` (no service name after up) fails.
      if (a.includes('up') && a.includes('mongodb')) return { status: 0 };
      if (a.includes('up')) return { status: 1, stderr: 'unhealthy' };
      if (a.includes('ps')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            Name: 'harness-proxy',
            Service: 'proxy',
            Health: 'starting',
            State: 'running',
          }),
        };
      }
      if (a.includes('logs')) return { status: 0, stdout: 'proxy log tail' };
      return { status: 0 };
    });
    await expect(
      runHarness({
        exec,
        profile: 'split',
        secrets: SECRETS,
        harnessImage: 'x:local',
        pollReadyz,
        stdout: { write() {} },
      }),
    ).rejects.toMatchObject({ kind: SETUP_FAILURE_KINDS.BRINGUP_TIMEOUT, service: 'proxy' });
  });

  test('a dependency failure is classified as a container failure and tails the container that exited', async () => {
    // The observed failure, driven end to end through the sequence: the auth surface exits 1, so the
    // proxy never starts. The runner must report the container failure (not a 300-second timeout) and
    // must tail the auth surface's log — the one with the reason in it — rather than a sibling that
    // never ran.
    const exec = makeFakeExec((command, args) => {
      const a = joined(args);
      if (command === 'docker' && a.startsWith('image inspect')) return { status: 0 };
      if (command === 'mongosh') return { status: 0 };
      if (a.includes('run') && a.includes('provision')) return { status: 0, stdout: 'Done.\n' };
      if (a.includes('up') && a.includes('mongodb')) return { status: 0 };
      if (a.includes('up')) {
        return {
          status: 1,
          stderr: 'dependency failed to start: container harness-auth-surface exited (1)\n',
        };
      }
      if (a.includes('ps')) {
        return {
          status: 0,
          stdout: [
            JSON.stringify({
              Name: 'harness-auth-surface',
              Service: 'auth-surface',
              Health: '',
              State: 'exited',
              ExitCode: 1,
            }),
            JSON.stringify({
              Name: 'harness-proxy',
              Service: 'proxy',
              Health: '',
              State: 'created',
            }),
          ].join('\n'),
        };
      }
      if (a.includes('logs')) return { status: 0, stdout: 'auth-surface log tail' };
      return { status: 0 };
    });

    await expect(
      runHarness({
        exec,
        profile: 'split',
        secrets: SECRETS,
        harnessImage: 'x:local',
        pollReadyz,
        stdout: { write() {} },
      }),
    ).rejects.toMatchObject({
      kind: SETUP_FAILURE_KINDS.BRINGUP_CONTAINER_FAILED,
      service: 'auth-surface',
      detail: 'auth-surface log tail',
    });

    // The log read targeted the container that actually failed.
    const logCall = exec.calls.find((c) => joined(c.args).includes('logs'));
    expect(logCall.args).toContain('auth-surface');
    expect(logCall.args).not.toContain('proxy');
  });

  test('Layer A\u2019s verdict is published to the caller before any stage that can throw', async () => {
    // A SetupFailure from stages 2-9 unwinds past runHarness's return value, so a caller that reads
    // Layer A's result only from that return value loses twelve decided catalog ids to a bring-up
    // failure. `observed` is the seam that keeps the verdict, and this pins it.
    const exec = makeFakeExec((command, args) => {
      const a = joined(args);
      if (command === 'npx') return { status: 0, stdout: 'layer A ok', stderr: '' };
      if (command === 'docker' && a.startsWith('image inspect')) return { status: 1 };
      if (a.startsWith('build')) return { status: 1, stderr: 'no build' };
      return { status: 0 };
    });
    const observed = {};

    await expect(
      runHarness({
        exec,
        profile: 'split',
        secrets: SECRETS,
        harnessImage: 'x:local',
        pollReadyz,
        stdout: { write() {} },
        observed,
      }),
    ).rejects.toMatchObject({ kind: SETUP_FAILURE_KINDS.IMAGE_UNRESOLVED });

    expect(observed.layerA).toMatchObject({ status: 0, stdout: 'layer A ok' });
  });
});
