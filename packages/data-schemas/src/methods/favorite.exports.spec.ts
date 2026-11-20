import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels, FAVORITE_ITEM_TYPES, MAX_TOOL_FAVORITES } from '..';

it('keeps favorites available through the existing package facade', async () => {
  const server = await MongoMemoryServer.create();
  const instance = new mongoose.Mongoose();
  instance.set('autoIndex', false);
  instance.set('autoCreate', false);
  try {
    await instance.connect(server.getUri());
    const models = createModels(instance);
    await models.ToolFavorite.createIndexes();
    const methods = createMethods(instance);
    const userId = new mongoose.Types.ObjectId().toString();
    const params = { userId, itemType: 'tool', itemId: 'compatibility' } as const;

    expect(MAX_TOOL_FAVORITES).toBe(100);
    expect(FAVORITE_ITEM_TYPES).toEqual(['builtin', 'tool', 'mcp', 'skill']);
    expect(await methods.addToolFavorite(params)).toEqual({ ok: true, added: true });
    expect(await methods.getToolFavorites(userId)).toEqual([
      { itemType: 'tool', itemId: 'compatibility' },
    ]);
    expect(await methods.removeToolFavorite(params)).toEqual({ ok: true, removed: true });
    expect(await methods.deleteUserToolFavorites(userId)).toBe(0);
  } finally {
    await instance.disconnect();
    await server.stop();
  }
});
