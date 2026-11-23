import mongoose from 'mongoose';
import type { PostgresDatabase, PostgresOptions } from './pool';
import type { PostgresFavoriteBackend } from './backend';
import { createPostgresTestDatabase } from './postgres.helper';
import { createPostgresFavoriteBackend } from './backend';
import { migratePostgres } from './migrations';
import { importFavorites } from './import';

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
const userId = '0123456789abcdef01234567';

postgres('PostgreSQL favorite backend composition', () => {
  let db: PostgresDatabase | undefined;
  let backend: PostgresFavoriteBackend | undefined;
  let options: PostgresOptions;

  beforeEach(async () => {
    ({ db, options } = await createPostgresTestDatabase());
    await migratePostgres(db);
  });

  afterEach(async () => {
    try {
      await backend?.close();
    } finally {
      backend = undefined;
      await db?.close();
      db = undefined;
    }
  });

  async function verifyEmpty(): Promise<void> {
    await importFavorites(
      db!,
      async function* () {
        /* verified empty source */
      },
      { offline: true, batchSize: 1, verifiedEmpty: true },
    );
  }

  async function readiness() {
    return (await db!.query('SELECT * FROM tool_favorite_readiness')).rows;
  }

  it('does not activate verified data when constructed or read before initialization', async () => {
    await verifyEmpty();
    const before = await readiness();
    expect(before).toEqual([expect.objectContaining({ verified: true, activated: false })]);
    backend = createPostgresFavoriteBackend(options);
    expect(await backend.methods.getToolFavorites(userId)).toEqual([]);
    expect(await readiness()).toEqual(before);
  });

  it('initializes verified-empty data by activating readiness without touching Mongo', async () => {
    await verifyEmpty();
    const before = await readiness();
    const connect = jest.spyOn(mongoose, 'connect');
    const collection = jest.spyOn(mongoose.connection, 'collection');
    const model = jest.spyOn(mongoose, 'model');
    backend = createPostgresFavoriteBackend(options);
    await backend.initialize();
    expect(await readiness()).toEqual([{ ...before[0], activated: true }]);
    expect(await backend.methods.getToolFavorites(userId)).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    expect(collection).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it('rejects unverified data without activating it', async () => {
    backend = createPostgresFavoriteBackend(options);
    await expect(backend.initialize()).rejects.toThrow('PostgreSQL favorites data not verified');
    expect(await readiness()).toEqual([
      expect.objectContaining({ verified: false, activated: false }),
    ]);
  });

  it('exposes the native favorite add, read, and removal contract', async () => {
    await verifyEmpty();
    backend = createPostgresFavoriteBackend(options);
    await backend.initialize();
    const favorite = { userId, itemType: 'tool', itemId: 'backend-tool' } as const;
    await expect(backend.methods.addToolFavorite(favorite)).resolves.toEqual({
      ok: true,
      added: true,
    });
    await expect(backend.methods.getToolFavorites(userId)).resolves.toEqual([
      { itemType: 'tool', itemId: 'backend-tool' },
    ]);
    expect((await db!.query('SELECT count(*) FROM tool_favorites')).rows).toEqual([{ count: '1' }]);
    await expect(backend.methods.removeToolFavorite(favorite)).resolves.toEqual({
      ok: true,
      removed: true,
    });
    await expect(backend.methods.getToolFavorites(userId)).resolves.toEqual([]);
  });

  it('closes idempotently and rejects methods and initialization after close', async () => {
    await verifyEmpty();
    backend = createPostgresFavoriteBackend(options);
    await backend.initialize();
    const closing = backend.close();
    expect(backend.close()).toBe(closing);
    await closing;
    await expect(backend.close()).resolves.toBeUndefined();
    await expect(backend.methods.getToolFavorites(userId)).rejects.toThrow('admission');
    await expect(backend.initialize()).rejects.toThrow('admission');
  });

  it('can be closed idempotently after initialization fails', async () => {
    backend = createPostgresFavoriteBackend(options);
    await expect(backend.initialize()).rejects.toThrow('not verified');
    await expect(backend.close()).resolves.toBeUndefined();
    await expect(backend.close()).resolves.toBeUndefined();
    await expect(backend.methods.getToolFavorites(userId)).rejects.toThrow('admission');
  });
});
