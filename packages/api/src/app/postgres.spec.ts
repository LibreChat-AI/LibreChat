import pg from 'pg';
import mongoose from 'mongoose';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import {
  createModels,
  createPostgresDatabase,
  fingerprintFavorites,
  readPostgresFavorites,
} from '@librechat/data-schemas';
import { runPostgresCommand } from './postgres';

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
  const connectDb = jest.fn(async () => mongoose.connect(mongo.getUri()));
  const loadCustomConfig = jest.fn(async () => config);
  const run = (args: string[]) =>
    runPostgresCommand({ mongoose, createModels, connectDb, loadCustomConfig, args, env });
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
    'requires offline for %s and cleans up both connections',
    async (command) => {
      const end = jest.spyOn(pg.Pool.prototype, 'end');
      const disconnect = jest.spyOn(mongoose, 'disconnect');
      await expect(run([command])).rejects.toThrow('--offline');
      expect(connectDb).not.toHaveBeenCalled();
      expect(end).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1);
    },
  );
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
    const original = pg.Pool.prototype.end;
    jest.spyOn(pg.Pool.prototype, 'end').mockImplementationOnce(async function (this: pg.Pool) {
      await original.bind(this)();
      throw new Error('cleanup failed');
    });
    const disconnect = jest.spyOn(mongoose, 'disconnect');
    await expect(run(['import'])).rejects.toThrow('--offline');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
  it('disconnects Mongo even when configuration loading fails before a pool exists', async () => {
    loadCustomConfig.mockRejectedValueOnce(new Error('Deployment config unavailable'));
    const disconnect = jest.spyOn(mongoose, 'disconnect');
    await expect(run(['migrate'])).rejects.toThrow('Deployment config unavailable');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
