import pg from 'pg';
import mongoose from 'mongoose';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import {
  createModels,
  createMongoFavoriteStore,
  createPostgresDatabase,
  fingerprintFavorites,
  readPostgresFavorites,
} from '@librechat/data-schemas';
import type { MongoFavoriteStore } from '@librechat/data-schemas';
import { runPostgresCommand } from './postgres';

describe('PostgreSQL command arguments', () => {
  const favorites: MongoFavoriteStore = {
    source: async function* () {},
    stage: jest.fn(),
  };
  const disconnectDb = jest.fn(async () => undefined);

  const commands = ['migrate', 'import', 'verify', 'reconcile-mongo'];
  const flags = ['--offline', '--dry-run', '--verified-empty'];
  const combinations = commands.flatMap((command) =>
    Array.from({ length: 8 }, (_, mask) => ({
      args: [command, ...flags.filter((_flag, bit) => (mask & (1 << bit)) !== 0)],
    })),
  );
  it.each(combinations)('validates $args before configuration or connections', async ({ args }) => {
    const [command, ...flags] = args;
    const unsupported =
      (command === 'migrate' && flags.length > 0) ||
      (command === 'verify' && flags.some((flag) => flag !== '--offline')) ||
      (command === 'reconcile-mongo' && flags.includes('--verified-empty'));
    const missingOffline = command !== 'migrate' && !flags.includes('--offline');
    const sentinel = new Error('configuration not loaded');
    const loadCustomConfig = jest.fn().mockRejectedValue(sentinel);
    const connectDb = jest.fn();
    const end = jest.spyOn(pg.Pool.prototype, 'end');
    const operation = runPostgresCommand({
      createDatabase: createPostgresDatabase,
      favorites,
      disconnectDb,
      connectDb,
      loadCustomConfig,
      args,
      env: {},
    });
    if (unsupported) await expect(operation).rejects.toThrow('Usage:');
    else if (missingOffline) await expect(operation).rejects.toThrow('pass --offline');
    else await expect(operation).rejects.toBe(sentinel);
    expect(loadCustomConfig).toHaveBeenCalledTimes(unsupported || missingOffline ? 0 : 1);
    expect(connectDb).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
  it.each([
    { args: [] },
    { args: ['unknown'] },
    { args: ['__proto__'] },
    { args: ['constructor'] },
    ...commands.map((command) => ({ args: [command, '--unknown'] })),
    ...commands.map((command) => ({ args: [command, '--offline', '--offline'] })),
  ])('rejects unknown commands, flags, and duplicates: $args', async ({ args }) => {
    const loadCustomConfig = jest.fn();
    const connectDb = jest.fn();
    await expect(
      runPostgresCommand({
        createDatabase: createPostgresDatabase,
        favorites,
        disconnectDb,
        connectDb,
        loadCustomConfig,
        args,
        env: {},
      }),
    ).rejects.toThrow('Usage:');
    expect(loadCustomConfig).not.toHaveBeenCalled();
    expect(connectDb).not.toHaveBeenCalled();
  });
});

const realPostgres = process.env.PG_TEST_URL ? describe : describe.skip;
realPostgres('PostgreSQL CLI with real Mongo and PostgreSQL', () => {
  const schema = `favorites_cli_${randomBytes(6).toString('hex')}`;
  const baseUrl = process.env.PG_TEST_URL ?? '';
  const url = new URL(baseUrl || 'postgresql://postgres@localhost/postgres');
  url.searchParams.set('options', `-c search_path=${schema}`);
  const env = { PG_TEST_URL: url.toString() };
  const config = {
    persistence: { favorites: 'postgres', postgres: { connectionStringEnv: 'PG_TEST_URL' } },
  };
  const options = {
    connectionString: env.PG_TEST_URL,
    max: 2,
    maxWaiting: 10,
    acquireTimeoutMs: 1000,
    queryTimeoutMs: 5000,
    idleTimeoutMs: 1000,
  };
  const admin = createPostgresDatabase({ ...options, connectionString: baseUrl });
  const db = createPostgresDatabase(options);
  let mongo: MongoMemoryServer;
  const connectDb = jest.fn(async () =>
    mongoose.connect(mongo.getUri(), { autoCreate: false, autoIndex: false }),
  );
  const disconnectDb = () => mongoose.disconnect();
  const favorites = createMongoFavoriteStore(mongoose);
  const loadCustomConfig = jest.fn(async () => config);
  const run = (args: string[]) =>
    runPostgresCommand({
      createDatabase: createPostgresDatabase,
      favorites,
      connectDb,
      disconnectDb,
      loadCustomConfig,
      args,
      env,
    });
  const collection = () => createModels(mongoose).ToolFavorite.collection;
  const reconnect = () => mongoose.connect(mongo.getUri());
  const uid = new mongoose.Types.ObjectId('0123456789abcdef01234567');
  const row = (index: number) => ({
    _id: new mongoose.Types.ObjectId(index.toString(16).padStart(24, '0')),
    user: uid,
    tenantId: index % 2 ? 'tenant-one' : null,
    itemType: 'tool',
    itemId: `tool-${index}`,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-02T00:00:00.000Z'),
  });
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  }, 90_000);
  beforeEach(async () => {
    jest.clearAllMocks();
    await run(['migrate']);
    await db.query('TRUNCATE tool_favorites, tool_favorite_erasure');
    await db.query(
      'UPDATE tool_favorite_readiness SET verified=false, activated=false, checkpoint=NULL, snapshot=NULL, imported=0',
    );
    await reconnect();
    await collection().deleteMany({});
    await collection().createIndex({ user: 1, itemType: 1, itemId: 1 }, { unique: true });
    await collection().createIndex({ tenantId: 1 });
    await mongoose.disconnect();
    connectDb.mockClear();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  });
  it('imports and reconciles through plain snapshot, staging, and lifecycle interfaces', async () => {
    const snapshot = {
      id: row(1)._id.toHexString(),
      userId: uid.toHexString(),
      tenantId: 'tenant-one',
      itemType: 'tool',
      itemId: 'portable-store',
      createdAt: row(1).createdAt,
      updatedAt: row(1).updatedAt,
    } as const;
    const source = async function* () {
      yield snapshot;
    };
    const insert = jest.fn(async () => undefined);
    const replace = jest.fn(async () => undefined);
    const discard = jest.fn(async () => undefined);
    const store: MongoFavoriteStore = {
      source,
      stage: jest.fn(async () => ({ source, insert, replace, discard })),
    };
    const connect = jest.fn(async () => undefined);
    const disconnect = jest.fn(async () => undefined);
    const createDatabase = jest.fn(createPostgresDatabase);
    for (const command of ['import', 'verify', 'reconcile-mongo']) {
      await runPostgresCommand({
        createDatabase,
        favorites: store,
        connectDb: connect,
        disconnectDb: disconnect,
        loadCustomConfig,
        args: [command, '--offline'],
        env,
      });
    }
    expect(createDatabase).toHaveBeenCalledTimes(3);
    expect(createDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ connectionString: env.PG_TEST_URL }),
    );
    expect(connect.mock.calls).toEqual([[], [], []]);
    expect(disconnect).toHaveBeenCalledTimes(3);
    expect(store.stage).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith([snapshot]);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
    expect(connectDb).not.toHaveBeenCalled();
  });
  it('runs the actual migrate entrypoint with MONGO_URI unset', () => {
    const scratchRoot = resolve(__dirname, '../../../../node_modules/.cache/pg-lifecycle');
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(resolve(scratchRoot, 'cli-'));
    try {
      const configPath = resolve(scratch, 'config.yaml');
      writeFileSync(
        configPath,
        'version: 1.3.1\npersistence:\n  favorites: postgres\n  postgres:\n    connectionStringEnv: PG_TEST_URL\n',
      );
      const script = resolve(__dirname, '../../../../config/postgres.js');
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `delete process.env.MONGO_URI; process.argv = ['node', ${JSON.stringify(script)}, 'migrate']; require(${JSON.stringify(script)});`,
        ],
        {
          cwd: scratch,
          env: { ...process.env, ...env, CONFIG_PATH: configPath },
          encoding: 'utf8',
          timeout: 15000,
          killSignal: 'SIGKILL',
        },
      );
      expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({
        status: 0,
        error: undefined,
        stderr: '',
      });
      expect(child.stdout).toContain('PostgreSQL schema migrated');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  it.each([
    { args: ['import', '--offline', '--dry-run'], seeded: true },
    { args: ['import', '--offline', '--dry-run', '--verified-empty'], seeded: false },
    { args: ['reconcile-mongo', '--offline', '--dry-run'], seeded: true },
    { args: ['reconcile-mongo', '--offline', '--dry-run'], seeded: false },
    { args: ['import', '--offline'], seeded: true },
    { args: ['verify', '--offline'], seeded: true },
    { args: ['reconcile-mongo', '--offline'], seeded: true },
  ])(
    'isolates actual CLI $args from Mongo schema initialization (seeded=$seeded)',
    async ({ args, seeded }) => {
      const native = await mongoose
        .createConnection(mongo.getUri(`cli_${randomBytes(6).toString('hex')}`), {
          autoCreate: false,
          autoIndex: false,
        })
        .asPromise();
      const scratchRoot = resolve(__dirname, '../../../../node_modules/.cache/pg-lifecycle');
      mkdirSync(scratchRoot, { recursive: true });
      const scratch = mkdtempSync(resolve(scratchRoot, 'cli-'));
      const favorites = native.collection(collection().name);
      const mongoSnapshot = async () => {
        const collections = await native.db!.listCollections().toArray();
        return Promise.all(
          collections
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(async (metadata) => ({
              metadata,
              indexes: await native.collection(metadata.name).indexes(),
              rows: await native.collection(metadata.name).find().sort({ _id: 1 }).toArray(),
            })),
        );
      };
      const postgresSnapshot = async () => {
        const tables = await db.query<{ tablename: string }>(
          'SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename',
        );
        return {
          columns: (
            await db.query(
              'SELECT * FROM information_schema.columns WHERE table_schema=current_schema() ORDER BY table_name,ordinal_position',
            )
          ).rows,
          indexes: (
            await db.query(
              'SELECT * FROM pg_indexes WHERE schemaname=current_schema() ORDER BY tablename,indexname',
            )
          ).rows,
          tables: await Promise.all(
            tables.rows.map(async ({ tablename }) => ({
              tablename,
              rows: (await db.query(`SELECT * FROM "${tablename}" ORDER BY 1`)).rows,
            })),
          ),
        };
      };
      try {
        if (seeded) await favorites.insertOne(row(1));
        if (args[0] !== 'import') {
          await db.query(
            'INSERT INTO tool_favorites(id,user_id,tenant_id,item_type,item_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              row(1)._id.toHexString(),
              uid.toHexString(),
              row(1).tenantId,
              'tool',
              row(1).itemId,
              row(1).createdAt,
              row(1).updatedAt,
            ],
          );
          const snapshot = await fingerprintFavorites(readPostgresFavorites(db, 250));
          await db.query(
            'UPDATE tool_favorite_readiness SET verified=true,activated=true,snapshot=$1',
            [snapshot.digest],
          );
        }
        const beforeMongo = await mongoSnapshot();
        const beforePostgres = await postgresSnapshot();
        const configPath = resolve(scratch, 'config.yaml');
        writeFileSync(
          configPath,
          'version: 1.3.1\npersistence:\n  favorites: postgres\n  postgres:\n    connectionStringEnv: PG_TEST_URL\n',
        );
        const guardPath = resolve(scratch, 'guard.cjs');
        writeFileSync(
          guardPath,
          `
const assert = require('node:assert/strict');
const mongoose = require(${JSON.stringify(require.resolve('mongoose'))});
const connect = mongoose.connect.bind(mongoose);
mongoose.connect = (uri, options) => {
  assert.equal(options.autoCreate, false);
  assert.equal(options.autoIndex, false);
  return connect(uri, options);
};
mongoose.model = () => { throw new Error('CLI registered a connected model'); };
process.on('beforeExit', () => {
  assert.deepEqual(mongoose.modelNames(), []);
  assert.equal(Object.keys(require.cache).some(path => path.endsWith('/api/db/index.js')), false);
});
`,
        );
        const child = await promisify(execFile)(
          process.execPath,
          ['--require', guardPath, resolve(__dirname, '../../../../config/postgres.js'), ...args],
          {
            cwd: scratch,
            env: {
              ...process.env,
              ...env,
              CONFIG_PATH: configPath,
              MONGO_URI: mongo.getUri(native.name),
              MONGO_AUTO_CREATE: 'true',
              MONGO_AUTO_INDEX: 'true',
            },
            encoding: 'utf8',
            timeout: 15000,
            killSignal: 'SIGKILL',
          },
        );
        expect(child.stderr).toBe('');
        const afterMongo = await mongoSnapshot();
        if (args[0] === 'reconcile-mongo' && !args.includes('--dry-run')) {
          expect(afterMongo).toHaveLength(1);
          const before = beforeMongo[0].metadata;
          const after = afterMongo[0].metadata;
          if (!('info' in before) || !before.info || !('info' in after) || !after.info) {
            throw new Error('Full Mongo collection metadata is required');
          }
          expect(after.info.uuid).not.toEqual(before.info.uuid);
          before.info.uuid = after.info.uuid;
        }
        expect(afterMongo).toEqual(beforeMongo);
        if (args[0] !== 'import' || args.includes('--dry-run')) {
          expect(await postgresSnapshot()).toEqual(beforePostgres);
        } else {
          expect((await db.query('SELECT count(*) FROM tool_favorites')).rows[0].count).toBe('1');
        }
      } finally {
        await native.dropDatabase();
        await native.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
  it('rejects a migration dry run before creating any schema objects or opening connections', async () => {
    const emptySchema = `favorites_dry_run_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${emptySchema}`);
    const target = new URL(baseUrl);
    target.searchParams.set('options', `-c search_path=${emptySchema}`);
    const end = jest.spyOn(pg.Pool.prototype, 'end');
    loadCustomConfig.mockClear();
    try {
      const result = await runPostgresCommand({
        createDatabase: createPostgresDatabase,
        favorites,
        disconnectDb,
        connectDb,
        loadCustomConfig,
        args: ['migrate', '--dry-run'],
        env: { PG_TEST_URL: target.toString() },
      }).then(
        () => 'success',
        (error: Error) => error.message,
      );
      const objects = await admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [
        emptySchema,
      ]);
      expect(objects.rows).toEqual([]);
      expect(result).toContain('Usage:');
      expect(loadCustomConfig).not.toHaveBeenCalled();
      expect(connectDb).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
    } finally {
      await admin.query(`DROP SCHEMA ${emptySchema} CASCADE`);
    }
  });
  it('migrates without connecting Mongo and releases its pool', async () => {
    const end = jest.spyOn(pg.Pool.prototype, 'end');
    await run(['migrate']);
    expect(connectDb).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(loadCustomConfig).toHaveBeenCalledWith(false, {
      mode: 'reload',
      storageSelection: true,
    });
  });
  it.each(['import', 'verify', 'reconcile-mongo'])(
    'requires offline for %s before opening connections',
    async (command) => {
      const end = jest.spyOn(pg.Pool.prototype, 'end');
      const disconnect = jest.spyOn(mongoose, 'disconnect');
      await expect(run([command])).rejects.toThrow('--offline');
      expect(connectDb).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
      expect(disconnect).toHaveBeenCalledTimes(1);
    },
  );
  it('validates an import dry run without changing data or readiness', async () => {
    await reconnect();
    await collection().insertMany([row(1), row(2)]);
    const original = await collection().find().sort({ _id: 1 }).toArray();
    await mongoose.disconnect();
    const state = await db.query('SELECT * FROM tool_favorite_readiness');
    await run(['import', '--offline', '--dry-run']);
    expect((await db.query('SELECT * FROM tool_favorites')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM tool_favorite_readiness')).rows).toEqual(state.rows);
    await reconnect();
    expect(await collection().find().sort({ _id: 1 }).toArray()).toEqual(original);
  });
  it('imports and verifies identity, tenant and dates, then reconciles deletes and preserves indexes without changing authority', async () => {
    await reconnect();
    await collection().insertMany([row(1), row(2)]);
    const indexes = await collection().indexes();
    await mongoose.disconnect();
    await run(['import', '--offline']);
    await run(['verify', '--offline']);
    const expected = await fingerprintFavorites(readPostgresFavorites(db, 250));
    await db.query('DELETE FROM tool_favorites WHERE id=$1', [row(1)._id.toHexString()]);
    const state = await db.query('SELECT * FROM tool_favorite_readiness');
    await expect(run(['verify', '--offline'])).rejects.toThrow('differ');
    await run(['reconcile-mongo', '--offline', '--dry-run']);
    await reconnect();
    expect(await collection().countDocuments()).toBe(2);
    await mongoose.disconnect();
    await run(['reconcile-mongo', '--offline']);
    await run(['verify', '--offline']);
    await reconnect();
    expect(await collection().findOne({ _id: row(1)._id })).toBeNull();
    expect(await collection().findOne({ _id: row(2)._id })).toEqual(row(2));
    expect(await collection().indexes()).toEqual(indexes);
    expect(
      await mongoose.connection.db!.listCollections({ name: /_reconcile_/ }).toArray(),
    ).toEqual([]);
    expect((await db.query('SELECT * FROM tool_favorite_readiness')).rows).toEqual(state.rows);
    expect(expected.count).toBe(2);
  });
  it.each(['schema-only', 'partial', 'missing-marker'] as const)(
    'refuses destructive reconciliation from %s PostgreSQL without modifying Mongo',
    async (state) => {
      await reconnect();
      await collection().insertMany([row(1), row(2)]);
      const original = await collection().find().sort({ _id: 1 }).toArray();
      const indexes = await collection().indexes();
      await mongoose.disconnect();
      if (state !== 'schema-only') {
        await run(['import', '--offline']);
        await db.query('DELETE FROM tool_favorites WHERE id=$1', [row(2)._id.toHexString()]);
        await db.query('UPDATE tool_favorite_readiness SET verified=false,checkpoint=$1', [
          row(1)._id.toHexString(),
        ]);
      }
      if (state === 'missing-marker') await db.query('DELETE FROM tool_favorite_readiness');
      const authority = await db.query('SELECT * FROM tool_favorite_readiness');
      for (const flags of [[], ['--dry-run']]) {
        await expect(run(['reconcile-mongo', '--offline', ...flags])).rejects.toThrow(
          'not verified',
        );
        await reconnect();
        expect(await collection().find().sort({ _id: 1 }).toArray()).toEqual(original);
        expect(await collection().indexes()).toEqual(indexes);
        expect(
          await mongoose.connection.db!.listCollections({ name: /_reconcile_/ }).toArray(),
        ).toEqual([]);
        await mongoose.disconnect();
      }
      expect((await db.query('SELECT * FROM tool_favorite_readiness')).rows).toEqual(
        authority.rows,
      );
      if (state === 'missing-marker')
        await db.query('INSERT INTO tool_favorite_readiness(singleton) VALUES(true)');
    },
  );
  it('allows verified activated PostgreSQL to reconcile subsequent deletions, including an empty snapshot', async () => {
    await reconnect();
    await collection().insertOne(row(1));
    await mongoose.disconnect();
    await run(['import', '--offline']);
    await db.query('UPDATE tool_favorite_readiness SET activated=true');
    await db.query('DELETE FROM tool_favorites');
    await run(['reconcile-mongo', '--offline']);
    await reconnect();
    expect(await collection().countDocuments()).toBe(0);
    expect((await db.query('SELECT verified,activated FROM tool_favorite_readiness')).rows).toEqual(
      [{ verified: true, activated: true }],
    );
  });
  it('refuses a same-count corrupted staging snapshot, retains Mongo, and removes staging', async () => {
    await reconnect();
    await collection().insertOne(row(1));
    await mongoose.disconnect();
    await run(['import', '--offline']);
    const original = mongoose.connection.collection.bind(mongoose.connection);
    const staging = jest
      .spyOn(mongoose.connection, 'collection')
      .mockImplementation((name, options) => {
        const target = original(name, options);
        if (name.includes('_reconcile_')) {
          const insert = target.insertMany.bind(target);
          jest.spyOn(target, 'insertMany').mockImplementation(async (docs, options) => {
            const result = await insert(docs, options);
            await target.updateOne({}, { $set: { itemId: 'corrupt' } });
            return result;
          });
        }
        return target;
      });
    await expect(run(['reconcile-mongo', '--offline'])).rejects.toThrow(
      'changed during reconciliation',
    );
    staging.mockRestore();
    await reconnect();
    expect(await collection().findOne({ _id: row(1)._id })).toEqual(row(1));
    expect(
      await mongoose.connection.db!.listCollections({ name: /_reconcile_/ }).toArray(),
    ).toEqual([]);
  });
  it('rechecks PostgreSQL readiness before Mongo replacement and discards untrusted staging', async () => {
    await reconnect();
    await collection().insertOne(row(1));
    await mongoose.disconnect();
    await run(['import', '--offline']);
    const original = mongoose.connection.collection.bind(mongoose.connection);
    jest.spyOn(mongoose.connection, 'collection').mockImplementation((name, options) => {
      const target = original(name, options);
      if (name.includes('_reconcile_')) {
        const insert = target.insertMany.bind(target);
        jest.spyOn(target, 'insertMany').mockImplementation(async (docs, options) => {
          const result = await insert(docs, options);
          await db.query('UPDATE tool_favorite_readiness SET verified=false');
          return result;
        });
      }
      return target;
    });
    await expect(run(['reconcile-mongo', '--offline'])).rejects.toThrow('not verified');
    jest.restoreAllMocks();
    await reconnect();
    expect(await collection().findOne({ _id: row(1)._id })).toEqual(row(1));
    expect(
      await mongoose.connection.db!.listCollections({ name: /_reconcile_/ }).toArray(),
    ).toEqual([]);
  });
  it('does not race a migration or import holding the same schema authority', async () => {
    await reconnect();
    await collection().insertOne(row(1));
    await mongoose.disconnect();
    await run(['import', '--offline']);
    await db.session(async (session) => {
      await session.query('SELECT pg_advisory_lock(17490261,hashtext(current_schema()))');
      try {
        await expect(run(['reconcile-mongo', '--offline'])).rejects.toThrow(
          'Another favorite migration',
        );
      } finally {
        await session.query('SELECT pg_advisory_unlock(17490261,hashtext(current_schema()))');
      }
    });
    await reconnect();
    expect(await collection().findOne({ _id: row(1)._id })).toEqual(row(1));
  });
  it('reports cleanup failure after a successful command instead of silently succeeding', async () => {
    const original = pg.Pool.prototype.end;
    jest.spyOn(pg.Pool.prototype, 'end').mockImplementationOnce(async function (this: pg.Pool) {
      await original.bind(this)();
      throw new Error('cleanup failed');
    });
    const disconnect = jest.spyOn(mongoose, 'disconnect');
    await expect(run(['migrate'])).rejects.toThrow('command cleanup failed');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
  it.each([{ user: null }, { tenantId: 42 }, { createdAt: null }, { updatedAt: 'invalid' }])(
    'closes pools and Mongo after malformed source validation without exposing the record: %j',
    async (invalid) => {
      await reconnect();
      await collection().insertOne({ ...row(1), ...invalid });
      await mongoose.disconnect();
      const end = jest.spyOn(pg.Pool.prototype, 'end');
      const disconnect = jest.spyOn(mongoose, 'disconnect');
      await expect(run(['import', '--offline'])).rejects.toThrow(
        'Invalid favorite snapshot record',
      );
      expect(end).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect((await db.query('SELECT count(*) FROM tool_favorites')).rows[0].count).toBe('0');
    },
  );
  it('keeps the operational error when pool shutdown also fails, and still disconnects Mongo', async () => {
    await reconnect();
    await collection().insertOne({ ...row(1), user: null });
    await mongoose.disconnect();
    const original = pg.Pool.prototype.end;
    jest.spyOn(pg.Pool.prototype, 'end').mockImplementationOnce(async function (this: pg.Pool) {
      await original.bind(this)();
      throw new Error('cleanup failed');
    });
    const disconnect = jest.spyOn(mongoose, 'disconnect');
    await expect(run(['import', '--offline'])).rejects.toThrow('Invalid favorite snapshot record');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
  it('disconnects Mongo even when configuration loading fails before a pool exists', async () => {
    loadCustomConfig.mockRejectedValueOnce(new Error('Deployment config unavailable'));
    const disconnect = jest.spyOn(mongoose, 'disconnect');
    await expect(run(['migrate'])).rejects.toThrow('Deployment config unavailable');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
