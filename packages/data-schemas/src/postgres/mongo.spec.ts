import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createToolFavoriteModel } from '~/models/favorite';
import toolFavoriteSchema from '~/schema/favorite';
import { createMongoFavoriteStore } from './mongo';

async function rows(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const row of source) result.push(row);
  return result;
}

describe('CLI Mongo favorite snapshots', () => {
  let server: MongoMemoryServer;
  const database = new mongoose.Mongoose();
  beforeAll(async () => {
    server = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  }, 90000);
  beforeEach(async () => {
    await database.connect(server.getUri(), { autoCreate: false, autoIndex: false });
    await database.connection.dropDatabase();
  });
  afterEach(async () => {
    await database.disconnect();
  });
  afterAll(async () => {
    await server.stop();
  });
  it('reads missing collections without DDL, model registration, or inherited schema options', async () => {
    const previous = {
      autoCreate: toolFavoriteSchema.get('autoCreate'),
      autoIndex: toolFavoriteSchema.get('autoIndex'),
      autoSearchIndex: toolFavoriteSchema.get('autoSearchIndex'),
    };
    toolFavoriteSchema.set('autoCreate', true);
    toolFavoriteSchema.set('autoIndex', true);
    toolFavoriteSchema.set('autoSearchIndex', true);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const store = createMongoFavoriteStore(database);
        expect(await rows(store.source())).toEqual([]);
        expect(database.modelNames()).toEqual([]);
        expect(await database.connection.db!.listCollections().toArray()).toEqual([]);
        await database.disconnect();
        await database.connect(server.getUri(), { autoCreate: false, autoIndex: false });
      }
    } finally {
      toolFavoriteSchema.set('autoCreate', previous.autoCreate);
      toolFavoriteSchema.set('autoIndex', previous.autoIndex);
      toolFavoriteSchema.set('autoSearchIndex', previous.autoSearchIndex);
    }
  });
  it('uses the data-schema collection name and preserves raw documents and indexes', async () => {
    const metadata = new mongoose.Mongoose();
    metadata.set('autoCreate', false);
    metadata.set('autoIndex', false);
    const name = createToolFavoriteModel(metadata).collection.name;
    const collection = database.connection.collection(name);
    const row = {
      _id: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      tenantId: 'tenant-one',
      itemType: 'tool',
      itemId: 'favorite',
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-02'),
    };
    await collection.insertOne(row);
    const before = await database.connection.db!.listCollections().toArray();
    const indexes = await collection.indexes();
    const store = createMongoFavoriteStore(database);
    expect(await rows(store.source())).toEqual([
      {
        id: row._id.toHexString(),
        userId: row.user.toHexString(),
        tenantId: row.tenantId,
        itemType: row.itemType,
        itemId: row.itemId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    ]);
    expect(await collection.find().toArray()).toEqual([row]);
    expect(await collection.indexes()).toEqual(indexes);
    expect(await database.connection.db!.listCollections().toArray()).toEqual(before);
    expect(database.modelNames()).toEqual([]);
  });
  it('can replace a missing collection with an empty snapshot using only explicit staging DDL', async () => {
    const store = createMongoFavoriteStore(database);
    const staging = await store.stage();
    expect(await rows(staging.source())).toEqual([]);
    const staged = await database.connection.db!.listCollections().toArray();
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toContain('_reconcile_');
    await staging.replace();
    const replaced = await database.connection.db!.listCollections().toArray();
    expect(replaced).toHaveLength(1);
    expect(replaced[0].name).toBe(staged[0].name.split('_reconcile_')[0]);
    expect(await rows(store.source())).toEqual([]);
    expect(database.modelNames()).toEqual([]);
  });
});
