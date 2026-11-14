import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import keyvMongo from './keyvMongo';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

async function waitForIndex(name: string): Promise<Record<string, unknown> | undefined> {
  const logs = mongoose.connection.db!.collection('logs');
  for (let attempt = 0; attempt < 50; attempt++) {
    const found = (await logs.indexes()).find((index) => index.name === name);
    if (found) {
      return found as Record<string, unknown>;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

describe('KeyvMongo logs collection', () => {
  it('indexes lookups by key and expires entries through a TTL index', async () => {
    await keyvMongo.set('ban:1', 'value', 60_000);
    expect(await keyvMongo.get('ban:1')).toBe('value');
    expect(await waitForIndex('key_1')).toBeDefined();
    const expiry = await waitForIndex('expiresAt_1');
    expect(expiry?.expireAfterSeconds).toBe(0);
  });

  it('stores a null expiresAt for entries without a ttl, which the TTL index ignores', async () => {
    const logs = mongoose.connection.db!.collection('logs');
    await keyvMongo.set('no-ttl', 'kept');
    expect(await logs.countDocuments({ key: 'no-ttl' })).toBe(1);
    const stored = await logs.findOne({ key: 'no-ttl' });
    expect(stored?.expiresAt).toBeNull();
  });
});
