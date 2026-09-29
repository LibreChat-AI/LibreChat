const path = require('path');
const mongoose = require('mongoose');
const { spawnSync } = require('child_process');
const { MongoMemoryServer } = require('mongodb-memory-server');

const { MongoClient, ObjectId } = mongoose.mongo;

const SCRIPT = path.resolve(__dirname, '../../../scripts/container-split/migrate.mongo.js');
const SOURCE = 'tokens';
const TARGET = 'authtokens';
const DB_NAME = 'librechat_migration';

/** The four types the migration must leave in `tokens`. */
const OAUTH_TYPES = ['mcp_oauth', 'mcp_oauth_refresh', 'mcp_oauth_client', 'oauth_refresh'];

const hour = 3_600_000;

/**
 * One document per class the migration must move, plus one per class it must
 * leave behind. Each carries distinct field values so a copy that drops or
 * rewrites a field is visible rather than absorbed by a shared shape.
 *
 * The three moving classes differ only in the presence and value of `type`:
 * a real value, no field at all (invites), and an explicit null (legacy shape).
 * That single field is what the migration's exclusion filter turns on.
 */
const buildSeed = () => {
  const createdAt = new Date('2024-03-01T00:00:00.000Z');
  const expiresAt = new Date(createdAt.getTime() + hour);
  const userId = new ObjectId();

  const moving = [
    {
      _id: new ObjectId(),
      userId,
      email: 'reset@example.com',
      token: 'hashed-password-reset-token',
      identifier: null,
      type: 'password_reset',
      createdAt,
      expiresAt,
    },
    {
      _id: new ObjectId(),
      userId,
      email: 'verify@example.com',
      token: 'hashed-email-verification-token',
      type: 'email_verification',
      createdAt,
      expiresAt,
    },
    {
      _id: new ObjectId(),
      email: 'invitee@example.com',
      token: 'hashed-invite-token',
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 24 * hour),
    },
    {
      _id: new ObjectId(),
      userId: new ObjectId(),
      email: null,
      identifier: null,
      type: null,
      token: 'hashed-legacy-token',
      createdAt,
      expiresAt,
    },
  ];

  const staying = OAUTH_TYPES.map((type, index) => ({
    _id: new ObjectId(),
    userId: new ObjectId(),
    type,
    identifier: `mcp-server-${index}`,
    token: `encrypted-${type}-material`,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + (index + 1) * hour),
  }));

  return { moving, staying, all: [...moving, ...staying] };
};

const ids = (docs) => docs.map(({ _id }) => _id.toString()).sort();

/**
 * Probed once at module load: every suite here spawns the same binary, so a
 * probe per test would pay the process cost repeatedly to learn one fact.
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
 * The migration is driven as a real `mongosh` process, so without the binary
 * there is nothing to assert against. Skipping keeps an environment without it
 * from reporting a missing dependency as a migration defect — at the cost that
 * the suites contribute no coverage there, which the warning below makes loud
 * rather than silent.
 */
const describeMigration = MONGOSH_AVAILABLE ? describe : describe.skip;

if (!MONGOSH_AVAILABLE) {
  /**
   * Written to stderr rather than through `console.warn`: Jest buffers a test
   * file's console output and its default reporter discards that buffer for a
   * file whose every test was skipped, which is exactly this case. Going
   * straight to stderr is what keeps the skip in the CI log instead of silent.
   */
  process.stderr.write(
    'SKIPPING migration suites (api/test/migration): `mongosh` was not found on PATH, so ' +
      'scripts/container-split/migrate.mongo.js cannot be executed and these suites assert nothing. ' +
      'Install it with `npm install -g mongosh` to run them.\n',
  );
}

/**
 * Resolving the binary up front turns a missing `mongosh` into one actionable
 * failure rather than an ENOENT per test.
 *
 * Unreachable from a suite wrapped in `describeMigration`, which skips before
 * any fixture starts; it stays for a caller that starts a fixture directly.
 */
const resolveMongosh = () => {
  if (!MONGOSH_AVAILABLE) {
    throw new Error(
      '`mongosh` is required to exercise scripts/container-split/migrate.mongo.js and was not found on PATH. ' +
        'Install it with `npm install -g mongosh`.',
    );
  }
  return MONGOSH_VERSION;
};

/**
 * Spawn `mongosh` on the migration script against `uri`.
 *
 * Returns the exit status and both streams rather than throwing, so a refused
 * operation is an assertable outcome instead of a test error.
 */
const runScript = (uri, { dryRun = false, env = {} } = {}) => {
  const args = [uri, '--norc', '--quiet'];
  if (dryRun) {
    args.push('--eval', 'var DRY_RUN = true');
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
 * An ephemeral database plus a runner for the migration script.
 *
 * The script is driven as a real `mongosh` invocation rather than by
 * re-implementing its filter in the driver: the exclusion filter, the
 * `$setOnInsert` upsert, and the `DRY_RUN` gate are the behavior under test,
 * and a reimplementation would assert the test's own copy of them instead.
 */
const startMigrationFixture = async ({ dbName = DB_NAME } = {}) => {
  const mongoshVersion = resolveMongosh();
  const server = await MongoMemoryServer.create();
  const uri = server.getUri(dbName);
  const client = await MongoClient.connect(uri);
  const db = client.db(dbName);

  const snapshot = async (collection) =>
    db.collection(collection).find({}).sort({ _id: 1 }).toArray();

  return {
    uri,
    db,
    client,
    server,
    mongoshVersion,
    source: db.collection(SOURCE),
    target: db.collection(TARGET),
    snapshot,
    seed: async (documents) => {
      await db.collection(SOURCE).insertMany(documents.map((doc) => ({ ...doc })));
    },
    runMigration: (options) => runScript(uri, options),
    stop: async () => {
      await client.close();
      await server.stop();
    },
  };
};

const ROOT_USER = 'migration_root';
const ROOT_PASSWORD = 'migration-root-password';
const RESTRICTED_DB_NAME = 'librechat_migration_refused';

/**
 * The collection-scoped action lists `scripts/container-split/provision.mongo.js`
 * builds its grants from, kept in agreement with it so a credential here is
 * refused for the same reason a deployed container's credential would be. They
 * are the DocumentDB-portable intersection: `find` is the whole read set, and
 * the write set carries `createIndex` because the provisioned grant does.
 */
const READ_ACTIONS = ['find'];
const WRITE_ACTIONS = ['insert', 'update', 'remove', 'createIndex'];

/**
 * Two credentials, each withholding exactly one of the two privileges the
 * migration needs, and holding everything else it needs. Withholding one at a
 * time is what pins the refusal to the intended operation: a credential missing
 * both would fail on the read and never reach the write.
 *
 * `noSourceRead` cannot read `tokens` — it holds no privilege on that
 * collection at all — while retaining full read-write on `authtokens`.
 *
 * `noTargetWrite` can read both collections and write neither. The upsert needs
 * `update` and `insert`, so withholding both is what refuses it.
 */
const RESTRICTED_GRANTS = {
  noSourceRead: {
    role: 'migrationNoSourceRead',
    user: 'migration_no_source_read',
    password: 'no-source-read-password',
    privileges: (dbName) => [
      {
        resource: { db: dbName, collection: TARGET },
        actions: [...READ_ACTIONS, ...WRITE_ACTIONS],
      },
    ],
  },
  noTargetWrite: {
    role: 'migrationNoTargetWrite',
    user: 'migration_no_target_write',
    password: 'no-target-write-password',
    privileges: (dbName) => [
      { resource: { db: dbName, collection: SOURCE }, actions: READ_ACTIONS },
      { resource: { db: dbName, collection: TARGET }, actions: READ_ACTIONS },
    ],
  },
};

const credentialedUri = (baseUri, { user, password, authSource }) => {
  const url = new URL(baseUri);
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  url.searchParams.set('authSource', authSource);
  return url.toString();
};

/**
 * An ephemeral database with authorization enforced, plus one credential per
 * grant in `RESTRICTED_GRANTS` and an unrestricted root connection for seeding
 * and inspection.
 *
 * MongoDB does the refusing here. Nothing simulates an authorization error:
 * `mongod` runs with `--auth`, each credential carries a real collection-scoped
 * custom role, and the migration is spawned as a real `mongosh` process under
 * that credential. Faking the error would assert the test's own idea of when
 * MongoDB refuses rather than MongoDB's.
 */
const startRestrictedFixture = async ({ dbName = RESTRICTED_DB_NAME } = {}) => {
  const mongoshVersion = resolveMongosh();
  const server = await MongoMemoryServer.create({
    auth: { enable: true, customRootName: ROOT_USER, customRootPwd: ROOT_PASSWORD },
  });
  const baseUri = server.getUri(dbName);
  const client = await MongoClient.connect(
    credentialedUri(baseUri, { user: ROOT_USER, password: ROOT_PASSWORD, authSource: 'admin' }),
  );
  const db = client.db(dbName);

  const grants = Object.values(RESTRICTED_GRANTS);
  for (const grant of grants) {
    await db.command({
      createRole: grant.role,
      privileges: grant.privileges(dbName),
      roles: [],
    });
    await db.command({
      createUser: grant.user,
      pwd: grant.password,
      roles: [{ role: grant.role, db: dbName }],
    });
  }

  const uriFor = (name) => {
    const grant = RESTRICTED_GRANTS[name];
    if (!grant) {
      throw new Error(`Unknown restricted grant: ${name}`);
    }
    return credentialedUri(baseUri, {
      user: grant.user,
      password: grant.password,
      authSource: dbName,
    });
  };

  const snapshot = async (collection) =>
    db.collection(collection).find({}).sort({ _id: 1 }).toArray();

  const insert = async (collection, documents) => {
    if (documents.length === 0) {
      return;
    }
    await db.collection(collection).insertMany(documents.map((doc) => ({ ...doc })));
  };

  return {
    db,
    client,
    server,
    mongoshVersion,
    source: db.collection(SOURCE),
    target: db.collection(TARGET),
    snapshot,
    uriFor,
    /** Seeds `tokens` as root, bypassing the restricted credentials. */
    seed: (documents) => insert(SOURCE, documents),
    /** Seeds `authtokens` as root, standing in for what an earlier run copied. */
    seedTarget: (documents) => insert(TARGET, documents),
    runMigrationAs: (name, options) => runScript(uriFor(name), options),
    stop: async () => {
      await client.close();
      await server.stop();
    },
  };
};

module.exports = {
  DB_NAME,
  MONGOSH_AVAILABLE,
  OAUTH_TYPES,
  RESTRICTED_DB_NAME,
  RESTRICTED_GRANTS,
  SCRIPT,
  SOURCE,
  TARGET,
  buildSeed,
  describeMigration,
  ids,
  startMigrationFixture,
  startRestrictedFixture,
};
