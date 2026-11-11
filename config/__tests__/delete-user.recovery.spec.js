const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const schemas = require('@librechat/data-schemas');
const api = require('@librechat/api');

const realPostgres = process.env.PG_TEST_URL ? describe : describe.skip;
realPostgres('delete-user CLI durable erasure recovery', () => {
  const schema = `cli_erasure_${randomUUID().replace(/-/g, '')}`;
  const config = {
    persistence: { favorites: 'postgres', postgres: { connectionStringEnv: 'PG_TEST_URL' } },
  };
  const options = {
    connectionString: process.env.PG_TEST_URL ?? '',
    max: 2,
    maxWaiting: 10,
    acquireTimeoutMs: 1000,
    queryTimeoutMs: 5000,
    idleTimeoutMs: 1000,
  };
  let mongo;
  let admin;
  let db;
  const source = fs
    .readFileSync(path.resolve(__dirname, '../delete-user.js'), 'utf8')
    .replace(/^#!.*\n/, '');
  const execute = vm.runInThisContext(
    `(function(require, __dirname, process, console, Date) { ${source}\n})`,
    { filename: 'delete-user-recovery-cli.js' },
  );
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    schemas.createModels(mongoose);
    await mongoose.connect(mongo.getUri());
    admin = schemas.createPostgresDatabase(options);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(options.connectionString);
    url.searchParams.set('options', `-c search_path=${schema}`);
    options.connectionString = url.toString();
    db = schemas.createPostgresDatabase(options);
    await schemas.migratePostgres(db);
    await schemas.importFavorites(db, async function* () {}, {
      offline: true,
      verifiedEmpty: true,
      batchSize: 10,
    });
  });
  afterEach(async () => {
    await db.query('DROP TRIGGER IF EXISTS reject_cancel ON tool_favorite_erasure');
    await db.query('DROP FUNCTION IF EXISTS reject_cancel()');
  });
  afterAll(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
    await mongoose.disconnect();
    await mongo.stop();
  });
  async function runCli(
    email,
    now,
    { failCascade = true, failAdopt = false, failCancel = false } = {},
  ) {
    const runtime = api.createFavoriteRuntime(
      schemas.createToolFavoriteMethods(mongoose),
      {
        PG_TEST_URL: options.connectionString,
      },
      schemas.createPostgresFavoriteBackend,
    );
    const methods = schemas.createMethods(mongoose, { toolFavorites: runtime.methods });
    const suspend = jest.spyOn(methods, 'suspendUserSchedulesForDeletion');
    if (failAdopt)
      jest
        .spyOn(methods, 'getAgentTriggerUserDeletionAttemptId')
        .mockRejectedValueOnce(new Error('identity read unavailable'));
    const disconnect = jest.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined);
    class Clock extends Date {
      constructor(value) {
        super(value === undefined ? now : value);
      }
    }
    const quiet = Object.assign(
      Object.create(console),
      Object.fromEntries(['purple', 'green', 'yellow', 'error'].map((name) => [name, jest.fn()])),
    );
    const code = await new Promise((resolve) => {
      const modules = {
        mongoose,
        'module-alias': () => undefined,
        '@librechat/data-schemas': schemas,
        '@librechat/api': {
          ...api,
          createStreamServices: () => ({ isRedis: false }),
          waitForKeyvRedisClient: async () => undefined,
          initializeFileStorage: () => undefined,
          openCheckpointDeletion: async () => ({
            remember: async () => undefined,
            cleanup: async () => undefined,
            acknowledge: async () => undefined,
          }),
          deleteAllSharedLinksWithCleanup: async () => {
            if (failCascade) throw new Error('shared links unavailable');
          },
          revokeUserCodeEnvironmentWorkers: async () => 0,
        },
        '~/models': {
          ...methods,
          initializeFavorites: async (value) => {
            await runtime.initialize(value.persistence);
            if (failCancel) await installFault();
          },
          closeFavorites: async () => {
            if (failCancel) await removeFault();
            await runtime.close();
          },
        },
        '~/config': {},
        '~/cache/getLogStores': () => undefined,
        '~/server/services/Config': { getAppConfig: async () => ({}) },
        '~/server/services/Config/loadCustomConfig': async () => config,
        '~/server/services/Files/process': {
          processDeleteRequest: async () => ({ deletedFileIds: [], failedFileIds: [] }),
        },
        '~/server/services/Config/getCachedTools': { invalidateCachedTools: async () => undefined },
        './helpers': { askQuestion: async () => 'y', silentExit: resolve },
        './connect': async () => undefined,
      };
      execute(
        (name) => (Object.hasOwn(modules, name) ? modules[name] : require(name)),
        path.resolve(__dirname, '..'),
        { argv: ['node', 'delete-user.js', email] },
        quiet,
        Clock,
      );
    });
    disconnect.mockRestore();
    return { code, suspend };
  }
  async function owned(id) {
    return mongoose.models.User.findById(id)
      .select('+agentTriggerDeletionStartedAt +agentTriggerDeletionAttemptId')
      .lean();
  }
  async function installFault() {
    await db.query(
      `CREATE FUNCTION reject_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cancel unavailable'; END $$`,
    );
    await db.query(
      'CREATE TRIGGER reject_cancel BEFORE DELETE ON tool_favorite_erasure FOR EACH ROW EXECUTE FUNCTION reject_cancel()',
    );
  }
  async function removeFault() {
    await db.query('DROP TRIGGER reject_cancel ON tool_favorite_erasure');
    await db.query('DROP FUNCTION reject_cancel()');
  }
  it.each([
    { outcome: 'cancel', origin: 'system' },
    { outcome: 'commit', origin: 'system' },
    { outcome: 'cancel', origin: 'tenant' },
    { outcome: 'commit', origin: 'tenant' },
  ])(
    'adopts the canonical UUID from $origin through real offline CLI recovery and then $outcome',
    async ({ outcome, origin }) => {
      const id = new mongoose.Types.ObjectId();
      const email = `${id}@example.com`;
      await mongoose.models.User.create({
        _id: id,
        email,
        provider: 'local',
        ...(origin === 'tenant' ? { tenantId: 'tenant-a' } : {}),
      });
      const time = Date.now();
      const stale = 15 * 60_000 + 1;
      const priorToken = randomUUID();
      if (origin === 'tenant') {
        const priorMethods = schemas.createMethods(mongoose);
        await schemas.runAsSystem(() =>
          priorMethods.beginAgentTriggerUserDeletion(
            id.toString(),
            new Date(time - stale),
            priorToken,
          ),
        );
        await schemas.tenantStorage.run({ tenantId: 'tenant-a' }, () =>
          schemas
            .createPostgresFavoriteMethods(db)
            .deleteUserToolFavorites(id.toString(), priorToken),
        );
      }
      const first = await runCli(email, time, { failCancel: true });
      expect(first.code).toBe(1);
      const original = await owned(id);
      const token = original.agentTriggerDeletionAttemptId;
      expect(token).toMatch(/^[0-9a-f-]{36}$/);
      if (origin === 'tenant') expect(token).toBe(priorToken);
      // A takeover that loses its identity read must retain the adopted identity and owner.
      if (outcome === 'cancel') {
        expect((await runCli(email, time + stale, { failAdopt: true })).code).toBe(1);
        expect((await owned(id)).agentTriggerDeletionAttemptId).toBe(token);
        expect((await runCli(email, time + 2 * stale, { failCancel: true })).code).toBe(1);
        expect((await owned(id)).agentTriggerDeletionAttemptId).toBe(token);
      }
      const result = await runCli(email, time + 3 * stale, { failCascade: outcome === 'cancel' });
      expect(result.code).toBe(outcome === 'cancel' ? 1 : 0);
      expect(result.suspend.mock.calls[0][1]).not.toBe(first.suspend.mock.calls[0][1]);
      expect(result.suspend.mock.calls[0][1]).not.toBe(token);
      const methods = schemas.createMethods(mongoose);
      expect(
        await methods.cancelAgentTriggerUserDeletion(
          id.toString(),
          original.agentTriggerDeletionStartedAt,
          token,
        ),
      ).toBe(false);
      const restarted = api.createFavoriteRuntime(
        methods,
        {
          PG_TEST_URL: options.connectionString,
        },
        schemas.createPostgresFavoriteBackend,
      );
      try {
        await restarted.initialize(config.persistence);
        const addFavorite = () =>
          restarted.methods.addToolFavorite({
            userId: id.toString(),
            itemType: 'tool',
            itemId: 'after-recovery',
          });
        const add =
          origin === 'tenant'
            ? schemas.tenantStorage.run({ tenantId: 'tenant-a' }, addFavorite)
            : addFavorite();
        if (outcome === 'cancel') {
          expect((await owned(id)).agentTriggerDeletionStartedAt).toBeUndefined();
          expect((await owned(id)).agentTriggerDeletionAttemptId).toBeUndefined();
          await expect(add).resolves.toEqual({ ok: true, added: true });
          expect(
            (
              await db.query(
                'SELECT scope FROM tool_favorite_erasure WHERE user_id=$1 AND attempt_id=$2',
                [id.toString(), token],
              )
            ).rows,
          ).toEqual([]);
        } else {
          expect(await owned(id)).toBeNull();
          await expect(add).rejects.toThrow('erasure');
        }
      } finally {
        await restarted.close();
      }
    },
  );
});
