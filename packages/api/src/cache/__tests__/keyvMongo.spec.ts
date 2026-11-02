import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import keyvMongo from '../keyvMongo';

type Store = typeof keyvMongo;
const KeyvMongo = keyvMongo.constructor as new (options: { collection: string }) => Store;

let mongoServer: MongoMemoryServer;

async function keyIndexNames(collection: string): Promise<string[]> {
  const indexes = await mongoose.connection.db!.collection(collection).indexes();
  return indexes.filter((index) => index.key.key === 1).map((index) => index.name ?? '');
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
});

afterEach(async () => {
  await mongoose.disconnect();
});

afterAll(async () => {
  await mongoServer.stop();
});

describe('KeyvMongo key index', () => {
  it('indexes the store by key once it is first used', async () => {
    await mongoose.connect(mongoServer.getUri());
    const store = new KeyvMongo({ collection: 'keyv_indexed' });

    await store.set('ban:user-1', 'value');

    await waitFor(async () => (await keyIndexNames('keyv_indexed')).length === 1);
    await expect(store.get('ban:user-1')).resolves.toBe('value');
  });

  it('builds no index when the deployment disables auto indexing', async () => {
    await mongoose.connect(mongoServer.getUri(), { autoIndex: false });
    const store = new KeyvMongo({ collection: 'keyv_unindexed' });

    await store.set('ban:user-1', 'value');
    await new Promise((resolve) => setTimeout(resolve, 200));

    await expect(keyIndexNames('keyv_unindexed')).resolves.toEqual([]);
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the key index');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
