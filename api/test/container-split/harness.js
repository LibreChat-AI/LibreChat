const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { spawnSync } = require('child_process');
const { MongoMemoryServer } = require('mongodb-memory-server');

const { MongoClient } = mongoose.mongo;

/**
 * The unmodified provisioning script is the thing under test. This fixture
 * spawns `mongosh` on it rather than hand-building the roles, because the
 * script's computed privilege set is exactly what the grant-conformance specs
 * read back and assert over. Building the roles by hand here would make every
 * grant assertion a tautology (NG2 — the script is run, never edited).
 */
const SCRIPT = path.resolve(__dirname, '../../../scripts/container-split/provision.mongo.js');

/**
 * The LibreChat database the privileges are scoped to. The script reads the
 * connected database's name with `db.getName()` and scopes every privilege to
 * it, and throws when connected to `admin`, so the spawn must target this
 * database and never `admin`. The roles and users themselves land on `admin`.
 */
const DB_NAME = 'librechat_container_split';
const ADMIN_DB = 'admin';

const ROOT_USER = 'harness_root';

/**
 * The provisioning script's default role and user names. The harness does not
 * override them, so a spec reads the same `librechatAuthSurface` /
 * `librechatApiContainer` names the script writes.
 */
const AUTH_ROLE_NAME = 'librechatAuthSurface';
const AUTH_USER_NAME = 'librechat_auth_surface';
const API_ROLE_NAME = 'librechatApiContainer';
const API_USER_NAME = 'librechat_api_container';

/**
 * The read-only observer credential distinct from either container's grant
 * (Requirement 3.9). Its role and user are created by the fixture's own root
 * snippet (task 1.2), never by the provisioning script (NG2). The name is fixed
 * here so `uriFor('observer')` resolves in the same shape as the other two.
 */
const OBSERVER_ROLE_NAME = 'librechatHarnessObserver';
const OBSERVER_USER_NAME = 'librechat_harness_observer';

/**
 * The ownership matrix, mirrored once. Eight read-write collections carrying
 * the full read+write vocabulary, four read-only collections carrying `find`
 * alone. This is the fixture's single copy of the matrix; the specs read this
 * table rather than each restating it.
 *
 * The action vocabulary is the DocumentDB-portable intersection the script
 * defines: `find` is the whole read set, and the write set carries
 * `createIndex` — but not `createCollection`, which the grant withholds
 * everywhere. Kept in agreement with `provision.mongo.js`; the grant-shape spec
 * asserts the *provisioned* shape against this table rather than against the
 * script's source, so a divergence surfaces as a failure rather than as two
 * edits that agree only with each other.
 */
const READ_ACTIONS = ['find'];
const WRITE_ACTIONS = ['insert', 'update', 'remove', 'createIndex'];

const AUTH_READ_WRITE = [
  'users',
  'sessions',
  'authtokens',
  'balances',
  'bans',
  'groups',
  'refreshtokenbridges',
  'openidrefreshflights',
];

const AUTH_READ_ONLY = ['roles', 'configs', 'systemgrants', 'banners'];

/**
 * The collections a refusal check reads under the Container_1_Grant and then
 * corroborates under the observer. Two disjoint sets, seeded and observed as
 * one.
 *
 * `OUT_OF_GRANT` is the five collections outside the twelve — `GRANT-DENY-READ-03`
 * reads each under the Container_1_Grant and asserts the read is refused. Against
 * an empty collection "returns no document" is vacuously true and a refusal is
 * indistinguishable from emptiness (Property 6), so each is root-seeded below.
 *
 * The four read-only collections are `AUTH_READ_ONLY`: `GRANT-DENY-WRITE-04`
 * attempts a write under the Container_1_Grant, asserts the refusal, then
 * re-reads under the observer to confirm the document is unchanged. A read under
 * the refusing credential would itself be refused and prove nothing, which is
 * why the observer exists.
 *
 * `authtokens` and `bans` are deliberately absent: `GRANT-MATERIALIZE-06`
 * (task 3.5) asserts both materialize on the first write the grant performs, and
 * seeding them would destroy that check. They are also absent from the observer's
 * grant for the same reason — the observer reads only what a refusal check reads.
 */
const OBSERVER_OUT_OF_GRANT = ['conversations', 'messages', 'files', 'tokens', 'keys'];

/**
 * Exactly the collections a refusal check reads — the five outside the twelve
 * plus the four read-only collections, and nothing else. This is both the set
 * root-seeds a document into and the set the observer is granted `find` on, so
 * the observer can read every collection a refusal check inspects and no other
 * (Requirement 3.9: read-only and distinct from the Container_1_Grant).
 */
const OBSERVER_SEEDED_COLLECTIONS = [...OBSERVER_OUT_OF_GRANT, ...AUTH_READ_ONLY];

/**
 * Lexicographic comparator over collection names, by the same `<`/`>` ordering
 * `Array.prototype.sort` applies to strings by default. Named rather than
 * inlined so the three-way result reads as three statements instead of nested
 * conditionals, and locale-independent — `localeCompare` would make the order
 * depend on the runner's locale.
 */
const byCollectionName = (a, b) => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

/**
 * `Map<collectionName, sortedActionList>` — the expected normalized grant. The
 * grant-shape spec normalizes the readback the same way and compares against
 * this map, so ordering never enters the comparison.
 */
const EXPECTED_GRANT = new Map(
  [
    ...AUTH_READ_WRITE.map((collection) => [
      collection,
      [...READ_ACTIONS, ...WRITE_ACTIONS].slice().sort(),
    ]),
    ...AUTH_READ_ONLY.map((collection) => [collection, READ_ACTIONS.slice().sort()]),
  ].sort(([a], [b]) => byCollectionName(a, b)),
);

/**
 * Probed once at module load: every suite spawns the same binary, so a probe
 * per test would pay the process cost repeatedly to learn one fact.
 */
const probeMongosh = () => {
  const probe = spawnSync('mongosh', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    return null;
  }
  return probe.stdout.trim();
};

const MONGOSH_VERSION = probeMongosh();
const MONGOSH_AVAILABLE = MONGOSH_VERSION !== null;

/**
 * `describe` where `mongosh` is installed, `describe.skip` where it is not.
 *
 * The grant is provisioned by a real `mongosh` process, so without the binary
 * there is nothing to assert against. Skipping keeps an environment without it
 * from reporting a missing dependency as a grant defect.
 */
const describeContainerSplit = MONGOSH_AVAILABLE ? describe : describe.skip;

if (!MONGOSH_AVAILABLE) {
  /**
   * Written to stderr rather than through `console.warn`: Jest buffers a test
   * file's console output and its default reporter discards that buffer for a
   * file whose every test was skipped, which is exactly this case. Going
   * straight to stderr is what keeps the skip in the CI log instead of silent.
   */
  process.stderr.write(
    'SKIPPING container-split suites (api/test/container-split): `mongosh` was not found on ' +
      'PATH, so scripts/container-split/provision.mongo.js cannot be executed and these suites ' +
      'assert nothing. Install it with `npm install -g mongosh` to run them.\n',
  );
}

/**
 * Resolving the binary up front turns a missing `mongosh` into one actionable
 * failure rather than an ENOENT per test.
 *
 * Unreachable from a suite wrapped in `describeContainerSplit`, which skips
 * before any fixture starts; it stays for a caller that starts a fixture
 * directly.
 */
const resolveMongosh = () => {
  if (!MONGOSH_AVAILABLE) {
    throw new Error(
      '`mongosh` is required to exercise scripts/container-split/provision.mongo.js and was not ' +
        'found on PATH. Install it with `npm install -g mongosh`.',
    );
  }
  return MONGOSH_VERSION;
};

const credentialedUri = (baseUri, { user, password, authSource }) => {
  const url = new URL(baseUri);
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  url.searchParams.set('authSource', authSource);
  return url.toString();
};

/**
 * Spawn `mongosh` on the provisioning script against `uri`.
 *
 * Passwords arrive through the script's documented `--eval` variables rather
 * than the environment, matching the script's usage. Returns the exit status
 * and both streams rather than throwing, so a refused run — the `admin`
 * connection and equal-password guards — is an assertable outcome instead of a
 * test error.
 */
const runProvision = (uri, { authPassword, apiPassword, dryRun = false, env = {} } = {}) => {
  const args = [uri, '--norc', '--quiet'];

  if (dryRun) {
    args.push('--eval', 'var DRY_RUN = true');
  } else {
    args.push(
      '--eval',
      `var AUTH_PASSWORD = ${JSON.stringify(authPassword)}; ` +
        `var API_PASSWORD = ${JSON.stringify(apiPassword)};`,
    );
  }

  args.push('--file', SCRIPT);

  const result = spawnSync('mongosh', args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

/**
 * A fresh, distinct secret per grant. Generating both per run means a suite
 * never depends on a committed credential, and asserting they differ before the
 * spawn keeps a `crypto.randomBytes` collision — which would mean the generator
 * is broken, not unlucky — from tripping the script's equal-password guard by
 * accident.
 */
const generatePassword = () => crypto.randomBytes(24).toString('hex');

/**
 * An auth-enabled ephemeral database, the two grants provisioned by the real
 * script through real `mongosh`, and per-grant credentialed URIs.
 *
 * The root password is generated per run for the same reason the grant
 * passwords are. The spawn connects to the LibreChat database as root (never
 * `admin` — the script throws there because `db.getName()` scopes every
 * privilege), while the roles and users it creates land on `admin`, which is
 * why every credentialed URI carries `authSource=admin`.
 */
const startProvisionedFixture = async ({ dbName = DB_NAME } = {}) => {
  const mongoshVersion = resolveMongosh();

  const rootPassword = crypto.randomBytes(24).toString('hex');
  const authPassword = generatePassword();
  const apiPassword = generatePassword();
  const observerPassword = generatePassword();

  if (authPassword === apiPassword) {
    throw new Error(
      'Generated auth-surface and API passwords collided. crypto.randomBytes is broken; ' +
        'the two grants must never share a password.',
    );
  }

  const server = await MongoMemoryServer.create({
    auth: { enable: true, customRootName: ROOT_USER, customRootPwd: rootPassword },
  });

  const baseUri = server.getUri(dbName);
  const rootUri = credentialedUri(baseUri, {
    user: ROOT_USER,
    password: rootPassword,
    authSource: ADMIN_DB,
  });

  const client = await MongoClient.connect(rootUri);
  const db = client.db(dbName);
  const adminDb = client.db(ADMIN_DB);

  const provision = runProvision(rootUri, { authPassword, apiPassword });
  if (provision.status !== 0 || !provision.stdout.includes('Done.')) {
    await client.close();
    await server.stop();
    throw new Error(
      'Provisioning script did not complete successfully.\n' +
        `exit: ${provision.status}\n` +
        `stdout:\n${provision.stdout}\n` +
        `stderr:\n${provision.stderr}`,
    );
  }

  /**
   * The read-only observer role and user, built here by the fixture's own root
   * client — never by `provision.mongo.js` (NG2). The script provisions the two
   * container grants; the observer is harness machinery that exists only so a
   * refusal check can confirm a refused write left the target unchanged without
   * looking under either container's credential (Requirement 3.9).
   *
   * The role holds `find` on exactly the collections a refusal check reads and
   * nothing else — no write action anywhere, `authtokens`/`bans` absent, no
   * database-wide or pattern resource. Created on `admin` alongside the two
   * container users so the observer authenticates with `authSource=admin` in the
   * same shape, and named for the LibreChat database in every privilege resource.
   */
  await adminDb.command({
    createRole: OBSERVER_ROLE_NAME,
    privileges: OBSERVER_SEEDED_COLLECTIONS.map((collection) => ({
      resource: { db: dbName, collection },
      actions: [...READ_ACTIONS],
    })),
    roles: [],
  });
  await adminDb.command({
    createUser: OBSERVER_USER_NAME,
    pwd: observerPassword,
    roles: [{ role: OBSERVER_ROLE_NAME, db: ADMIN_DB }],
  });

  /**
   * One root-seeded document per collection a refusal check reads, so a refused
   * read "returns no document" as a consequence of the refusal rather than of an
   * empty collection (Property 6). Seeded as root, bypassing every provisioned
   * grant. `authtokens` and `bans` are deliberately left out — task 3.5 asserts
   * they materialize on first write, and seeding them would destroy that check.
   */
  for (const collection of OBSERVER_SEEDED_COLLECTIONS) {
    await db.collection(collection).insertOne({ _seededBy: 'harness-root', collection });
  }

  const CREDENTIALS = {
    auth: { user: AUTH_USER_NAME, password: authPassword },
    api: { user: API_USER_NAME, password: apiPassword },
    observer: { user: OBSERVER_USER_NAME, password: observerPassword },
  };

  /**
   * A credentialed URI per grant, each carrying `authSource=admin`. Roles and
   * users live on `admin` while privileges name the LibreChat database, so a
   * URI without `authSource=admin` authenticates against the default database
   * and fails.
   *
   * `observer` is a valid target here; its role and user were created above by
   * the fixture's own root client, so it authenticates under a real credential.
   */
  const uriFor = (name) => {
    const credential = CREDENTIALS[name];
    if (!credential) {
      throw new Error(`Unknown grant: ${name}`);
    }
    return credentialedUri(baseUri, {
      user: credential.user,
      password: credential.password,
      authSource: ADMIN_DB,
    });
  };

  return {
    dbName,
    baseUri,
    rootUri,
    client,
    db,
    adminDb,
    server,
    mongoshVersion,
    authPassword,
    apiPassword,
    observerPassword,
    rootPassword,
    provision,
    uriFor,
    /** Re-run the unmodified script, e.g. to exercise idempotent narrowing. */
    runProvision: (options) => runProvision(rootUri, { authPassword, apiPassword, ...options }),
    stop: async () => {
      await client.close();
      await server.stop();
    },
  };
};

module.exports = {
  ADMIN_DB,
  API_ROLE_NAME,
  API_USER_NAME,
  AUTH_READ_ONLY,
  AUTH_READ_WRITE,
  AUTH_ROLE_NAME,
  AUTH_USER_NAME,
  DB_NAME,
  EXPECTED_GRANT,
  MONGOSH_AVAILABLE,
  OBSERVER_OUT_OF_GRANT,
  OBSERVER_ROLE_NAME,
  OBSERVER_SEEDED_COLLECTIONS,
  OBSERVER_USER_NAME,
  READ_ACTIONS,
  ROOT_USER,
  SCRIPT,
  WRITE_ACTIONS,
  credentialedUri,
  describeContainerSplit,
  generatePassword,
  runProvision,
  startProvisionedFixture,
};
