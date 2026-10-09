import mongoose from 'mongoose';
import { logger, createModels } from '..';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createToolFavoriteMethods, MAX_TOOL_FAVORITES } from './favorite';

logger.silent = true;

let ToolFavorite: mongoose.Model<unknown>;
let methods: ReturnType<typeof createToolFavoriteMethods>;
let mongoServer: MongoMemoryServer;

const userA = new mongoose.Types.ObjectId().toString();
const userB = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  ToolFavorite = mongoose.models.ToolFavorite;
  await ToolFavorite.syncIndexes();
  methods = createToolFavoriteMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await ToolFavorite.deleteMany({});
});

describe('addToolFavorite', () => {
  test('persists a favorite and getToolFavorites returns the lean projection', async () => {
    const result = await methods.addToolFavorite({
      userId: userA,
      itemType: 'mcp',
      itemId: 'everything',
    });
    expect(result).toEqual({ ok: true, added: true });

    const favorites = await methods.getToolFavorites(userA);
    expect(favorites).toEqual([{ itemType: 'mcp', itemId: 'everything' }]);
  });

  test('is idempotent: double-add keeps one doc and reports added: false', async () => {
    await methods.addToolFavorite({ userId: userA, itemType: 'tool', itemId: 'dalle' });
    const second = await methods.addToolFavorite({
      userId: userA,
      itemType: 'tool',
      itemId: 'dalle',
    });
    expect(second).toEqual({ ok: true, added: false });
    expect(await ToolFavorite.countDocuments({ user: userA })).toBe(1);
  });

  test('rejects an itemType outside the enum', async () => {
    await expect(
      methods.addToolFavorite({
        userId: userA,
        itemType: 'agent' as never,
        itemId: 'x',
      }),
    ).rejects.toThrow();
  });

  test('rejects an itemId longer than 256 characters', async () => {
    await expect(
      methods.addToolFavorite({ userId: userA, itemType: 'tool', itemId: 'x'.repeat(257) }),
    ).rejects.toThrow();
  });

  test('throws a coded error at the cap, but re-adding an existing favorite still succeeds', async () => {
    const docs = Array.from({ length: MAX_TOOL_FAVORITES }, (_, i) => ({
      user: userA,
      itemType: 'tool',
      itemId: `tool-${i}`,
    }));
    await ToolFavorite.insertMany(docs);

    const rejection = methods.addToolFavorite({
      userId: userA,
      itemType: 'tool',
      itemId: 'one-too-many',
    });
    await expect(rejection).rejects.toMatchObject({
      code: 'MAX_FAVORITES_EXCEEDED',
      limit: MAX_TOOL_FAVORITES,
    });

    const existing = await methods.addToolFavorite({
      userId: userA,
      itemType: 'tool',
      itemId: 'tool-0',
    });
    expect(existing).toEqual({ ok: true, added: false });
  });

  test('concurrent duplicate adds do not throw (unique index backstop)', async () => {
    const params = { userId: userA, itemType: 'skill', itemId: 'abc123' } as const;
    const results = await Promise.all([
      methods.addToolFavorite(params),
      methods.addToolFavorite(params),
      methods.addToolFavorite(params),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await ToolFavorite.countDocuments({ user: userA })).toBe(1);
  });
});

describe('removeToolFavorite', () => {
  test('removes a favorite and is idempotent', async () => {
    await methods.addToolFavorite({ userId: userA, itemType: 'builtin', itemId: 'web_search' });

    const removed = await methods.removeToolFavorite({
      userId: userA,
      itemType: 'builtin',
      itemId: 'web_search',
    });
    expect(removed).toEqual({ ok: true, removed: true });

    const again = await methods.removeToolFavorite({
      userId: userA,
      itemType: 'builtin',
      itemId: 'web_search',
    });
    expect(again).toEqual({ ok: true, removed: false });
    expect(await methods.getToolFavorites(userA)).toEqual([]);
  });
});

describe('getToolFavorites', () => {
  test('is isolated per user', async () => {
    await methods.addToolFavorite({ userId: userA, itemType: 'tool', itemId: 'dalle' });
    await methods.addToolFavorite({ userId: userB, itemType: 'mcp', itemId: 'everything' });

    expect(await methods.getToolFavorites(userA)).toEqual([{ itemType: 'tool', itemId: 'dalle' }]);
    expect(await methods.getToolFavorites(userB)).toEqual([
      { itemType: 'mcp', itemId: 'everything' },
    ]);
  });

  test('does not distinguish same itemId across kinds (compound identity)', async () => {
    await methods.addToolFavorite({ userId: userA, itemType: 'tool', itemId: 'shared-id' });
    await methods.addToolFavorite({ userId: userA, itemType: 'skill', itemId: 'shared-id' });

    const favorites = await methods.getToolFavorites(userA);
    expect(favorites).toHaveLength(2);
    expect(new Set(favorites.map((f) => `${f.itemType}:${f.itemId}`))).toEqual(
      new Set(['tool:shared-id', 'skill:shared-id']),
    );
  });
});
