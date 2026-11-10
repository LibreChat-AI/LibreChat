import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createPostgresDatabase, migratePostgres, importFavorites } from '@librechat/data-schemas';
import type { ToolFavoriteMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { createFavoriteRuntime, getPersistenceConfig } from './persistence';
import { createToolFavoritesHandlers } from '~/favorites/handlers';
import { createCustomConfigLoader } from './loader';

const mongo: ToolFavoriteMethods = {
  getToolFavorites: jest.fn().mockResolvedValue([]),
  addToolFavorite: jest.fn().mockResolvedValue({ ok: true, added: true }),
  removeToolFavorite: jest.fn().mockResolvedValue({ ok: true, removed: true }),
  deleteUserToolFavorites: jest.fn().mockResolvedValue(2),
};

describe('favorites process lifecycle', () => {
  it('retains a captured method across initialization and erases through the selected domain', async () => {
    const runtime = createFavoriteRuntime(mongo, {});
    const captured = runtime.methods.deleteUserToolFavorites;
    await expect(captured('user')).rejects.toThrow('not initialized');
    await runtime.initialize(undefined);
    expect(await captured('user')).toBe(2);
    await runtime.close();
    await expect(captured('user')).rejects.toThrow('not initialized');
    await expect(runtime.initialize(undefined)).rejects.toThrow('closed');
  });
  it('keeps the optional Mongo cancellation hook a no-op without changing captured references', async () => {
    const runtime = createFavoriteRuntime(mongo, {});
    const cancel = runtime.methods.cancelUserToolFavoriteDeletion!;
    await expect(cancel('user', 'attempt')).rejects.toThrow('not initialized');
    await runtime.initialize(undefined);
    await expect(cancel('user', 'attempt')).resolves.toBeUndefined();
    await runtime.close();
    await expect(cancel('user', 'attempt')).rejects.toThrow('not initialized');
  });
  it('fails closed on invalid explicit storage config and missing DSN', async () => {
    await expect(
      createFavoriteRuntime(mongo, {}).initialize({ favorites: 'invalid' }),
    ).rejects.toThrow('Invalid');
    await expect(
      createFavoriteRuntime(mongo, {}).initialize({
        favorites: 'postgres',
        postgres: { connectionStringEnv: 'PG_DSN' },
      }),
    ).rejects.toThrow('missing');
  });
  it('selects once for a process lifetime, never a request or config reload', async () => {
    const runtime = createFavoriteRuntime(mongo, {});
    await runtime.initialize(undefined);
    await runtime.initialize({ favorites: 'postgres' });
    expect(await runtime.methods.getToolFavorites('user')).toEqual([]);
    await runtime.close();
  });
  it('extracts only deployment persistence and rejects malformed deployment data', () => {
    expect(getPersistenceConfig(null)).toBeUndefined();
    expect(getPersistenceConfig({ persistence: { favorites: 'mongo' } })).toEqual({
      favorites: 'mongo',
    });
    expect(() => getPersistenceConfig('invalid')).toThrow();
  });
});

describe('storage selection source handling', () => {
  const create = (loadLocal: () => unknown) =>
    createCustomConfigLoader({
      defaultConfigPath: 'librechat.yaml',
      loadLocal,
      redactConfig: (config) => config,
    });
  it('permits an absent default file, but never malformed YAML or an explicit missing source', async () => {
    const original = process.env.CONFIG_PATH;
    delete process.env.CONFIG_PATH;
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    try {
      await expect(create(() => missing)(false, { storageSelection: true })).resolves.toBeNull();
      await expect(
        create(() => new Error('malformed'))(false, { storageSelection: true }),
      ).rejects.toThrow('unavailable');
      await expect(
        create(() => Object.assign(new Error('unreadable'), { code: 'EACCES' }))(false, {
          storageSelection: true,
        }),
      ).rejects.toThrow('unavailable');
      process.env.CONFIG_PATH = 'explicit.yaml';
      await expect(create(() => missing)(false, { storageSelection: true })).rejects.toThrow(
        'unavailable',
      );
    } finally {
      if (original == null) {
        delete process.env.CONFIG_PATH;
      } else {
        process.env.CONFIG_PATH = original;
      }
    }
  });
  it('refuses invalid persistence even with CONFIG_BYPASS_VALIDATION', async () => {
    const original = process.env.CONFIG_BYPASS_VALIDATION;
    process.env.CONFIG_BYPASS_VALIDATION = 'true';
    try {
      await expect(
        create(() => ({ version: '1.3.1', persistence: { favorites: 'postgress' } }))(false),
      ).rejects.toThrow('Invalid persistence');
    } finally {
      if (original == null) {
        delete process.env.CONFIG_BYPASS_VALIDATION;
      } else {
        process.env.CONFIG_BYPASS_VALIDATION = original;
      }
    }
  });
});

const realPostgres = process.env.PG_TEST_URL ? describe : describe.skip;
realPostgres('selected PostgreSQL lifecycle and HTTP boundary', () => {
  const env = { PG_TEST_URL: process.env.PG_TEST_URL };
  const config = {
    favorites: 'postgres',
    postgres: { connectionStringEnv: 'PG_TEST_URL', acquireTimeoutMs: 1000, queryTimeoutMs: 5000 },
  };
  const options = {
    connectionString: process.env.PG_TEST_URL ?? '',
    max: 2,
    maxWaiting: 10,
    acquireTimeoutMs: 1000,
    queryTimeoutMs: 5000,
    idleTimeoutMs: 1000,
  };
  const schema = `favorites_lifecycle_${randomBytes(6).toString('hex')}`;
  const admin = createPostgresDatabase(options);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(options.connectionString);
    url.searchParams.set('options', `-c search_path=${schema}`);
    options.connectionString = url.toString();
    env.PG_TEST_URL = options.connectionString;
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  });
  it('refuses schema-only data, releases failed pools, and serves captured HTTP handlers after verification', async () => {
    const db = createPostgresDatabase(options);
    try {
      await migratePostgres(db);
      await db.query('TRUNCATE tool_favorites, tool_favorite_erasure');
      await db.query(
        'UPDATE tool_favorite_readiness SET verified=false, activated=false, checkpoint=NULL, snapshot=NULL',
      );
      const end = jest.spyOn(pg.Pool.prototype, 'end');
      const failed = createFavoriteRuntime(mongo, env);
      await expect(failed.initialize(config)).rejects.toThrow('initialization failed');
      expect(end).toHaveBeenCalled();
      await failed.close();
      await importFavorites(db, async function* () {}, {
        offline: true,
        batchSize: 10,
        verifiedEmpty: true,
      });
      const runtime = createFavoriteRuntime(mongo, env);
      const handlers = createToolFavoritesHandlers(runtime.methods);
      await runtime.initialize(config);
      const uid = '0123456789abcdef01234567';
      const req = {
        user: { id: uid },
        params: { itemType: 'tool', itemId: 'native' },
      } as ServerRequest;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response;
      try {
        await handlers.addToolFavorite(req, res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ itemType: 'tool', itemId: 'native' });
        expect(await runtime.methods.deleteUserToolFavorites(uid)).toBe(1);
        expect(await runtime.methods.getToolFavorites(uid)).toEqual([]);
        await db.query('ALTER TABLE tool_favorites RENAME TO unavailable_favorites');
        await handlers.listToolFavorites(req, res);
        expect(res.status).toHaveBeenLastCalledWith(500);
        expect(res.json).toHaveBeenLastCalledWith({ message: 'Failed to retrieve favorites' });
        await db.query('ALTER TABLE unavailable_favorites RENAME TO tool_favorites');
        await expect(
          runtime.methods.addToolFavorite({ userId: uid, itemType: 'tool', itemId: 'late' }),
        ).rejects.toThrow('erasure');
      } finally {
        await runtime.close();
        await expect(runtime.methods.getToolFavorites(uid)).rejects.toThrow('not initialized');
      }
    } finally {
      await db.close();
    }
  });
  it('fails startup on a selected PostgreSQL outage without using Mongo', async () => {
    const end = jest.spyOn(pg.Pool.prototype, 'end');
    const runtime = createFavoriteRuntime(mongo, {
      PG_TEST_URL: 'postgresql://postgres@127.0.0.1:1/postgres',
    });
    await expect(runtime.initialize(config)).rejects.toThrow('initialization failed');
    expect(end).toHaveBeenCalled();
    await expect(runtime.methods.getToolFavorites('user')).rejects.toThrow('not initialized');
    await runtime.close();
  });
  it('does not publish methods when shutdown races initialization', async () => {
    const runtime = createFavoriteRuntime(mongo, env);
    const initializing = runtime.initialize(config);
    const stopping = runtime.close();
    await expect(initializing).rejects.toThrow('initialization failed');
    await stopping;
    await expect(runtime.methods.getToolFavorites('user')).rejects.toThrow('not initialized');
    expect(runtime.close()).toBe(stopping);
  });
});
