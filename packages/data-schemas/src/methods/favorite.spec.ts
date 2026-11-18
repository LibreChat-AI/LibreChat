import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FavoriteHarness } from '~/contracts/favorite';
import { describeFavoriteConformance } from '~/contracts/favorite';
import { createToolFavoriteModel } from '~/models/favorite';
import { createToolFavoriteMethods } from './favorite';
import { tenantStorage } from '~/config/tenantContext';

const instance = new mongoose.Mongoose();
const ToolFavorite = createToolFavoriteModel(instance);
let server: MongoMemoryServer;

const harness: FavoriteHarness = {
  name: 'mongoose',
  users: [new mongoose.Types.ObjectId().toString(), new mongoose.Types.ObjectId().toString()],
  async setup() {
    server = await MongoMemoryServer.create();
    await instance.connect(server.getUri());
    await ToolFavorite.syncIndexes();
    return createToolFavoriteMethods(instance);
  },
  async teardown() {
    await instance.disconnect();
    await server?.stop();
  },
  async reset() {
    jest.restoreAllMocks();
    await ToolFavorite.deleteMany({});
  },
  async seed(favorites) {
    await ToolFavorite.insertMany(
      favorites.map(({ userId, ...fields }) => ({ user: userId, ...fields })),
    );
  },
  inTenant: (tenantId, operation) => tenantStorage.run({ tenantId }, operation),
  failNext(operation, error) {
    const method = {
      read: 'find',
      insert: 'updateOne',
      remove: 'deleteOne',
      erase: 'deleteMany',
    } as const;
    jest.spyOn(ToolFavorite, method[operation]).mockImplementationOnce(() => {
      throw error;
    });
  },
};

describeFavoriteConformance(harness);

describe('favorites Mongo adapter', () => {
  beforeAll(() => harness.setup());
  afterAll(() => harness.teardown());
  beforeEach(() => harness.reset());

  it('enforces compound uniqueness in the database, not only in application checks', async () => {
    const record = { user: harness.users[0], itemType: 'tool', itemId: 'unique' };
    await ToolFavorite.create(record);
    await expect(ToolFavorite.create(record)).rejects.toMatchObject({ code: 11000 });
  });

  it('retains ObjectId input compatibility', async () => {
    const methods = createToolFavoriteMethods(instance);
    const params = {
      userId: new mongoose.Types.ObjectId(harness.users[0]),
      itemType: 'mcp',
      itemId: 'server',
    } as const;
    expect(await methods.addToolFavorite(params)).toEqual({ ok: true, added: true });
    expect(await methods.removeToolFavorite(params)).toEqual({ ok: true, removed: true });
  });

  it('treats a duplicate-key write race as success while keeping one record', async () => {
    const methods = createToolFavoriteMethods(instance);
    const params = { userId: harness.users[0], itemType: 'skill', itemId: 'race' } as const;
    const update = ToolFavorite.collection.updateOne.bind(ToolFavorite.collection);
    jest.spyOn(ToolFavorite.collection, 'updateOne').mockImplementationOnce(async (...args) => {
      await update(...args);
      throw new mongoose.mongo.MongoServerError({ code: 11000, message: 'duplicate key' });
    });
    expect(await methods.addToolFavorite(params)).toEqual({ ok: true, added: true });
    expect(await methods.getToolFavorites(harness.users[0])).toEqual([
      { itemType: 'skill', itemId: 'race' },
    ]);
  });
});
