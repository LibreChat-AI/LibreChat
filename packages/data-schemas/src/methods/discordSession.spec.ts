import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createDiscordBrowserSessionStorage } from './discordSession';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createSessionModel } from '~/models/session';
import { hashToken } from '~/crypto';

const db = new mongoose.Mongoose();
let mongo: MongoMemoryServer;
const userId = '000000000000000000000001';
const tenantId = 'discord-session';
const scoped = <T>(work: () => Promise<T>, tenant = tenantId) =>
  tenantStorage.run({ tenantId: tenant }, work);
const storage = () => createDiscordBrowserSessionStorage(db);
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await db.connect(mongo.getUri());
});
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await createSessionModel(db).deleteMany({});
  });
});
it('binds both refresh-token authentication and callback lookup to the original tenant session', async () => {
  const sessionId = await scoped(async () => {
    const record = await createSessionModel(db).create({
      user: userId,
      tenantId,
      refreshTokenHash: await hashToken('private-refresh-token'),
      expiration: new Date(Date.now() + 60000),
    });
    const read = await storage().read({ userId, refreshToken: 'private-refresh-token' });
    expect(read).toMatchObject({ sessionId: String(record._id), userId, tenantId });
    expect(read).not.toHaveProperty('refreshTokenHash');
    expect(await storage().read({ userId, refreshToken: 'wrong' })).toBeNull();
    expect(
      await storage().read({ userId: '000000000000000000000002', sessionId: String(record._id) }),
    ).toBeNull();
    return String(record._id);
  });
  await scoped(async () => {
    expect(await storage().read({ userId, sessionId })).toBeNull();
  }, 'foreign');
  await scoped(async () => {
    await createSessionModel(db).deleteOne({ _id: sessionId });
    expect(await storage().read({ userId, sessionId })).toBeNull();
  });
});
it('rejects expired and malformed sessions', async () =>
  scoped(async () => {
    const record = await createSessionModel(db).create({
      user: userId,
      tenantId,
      refreshTokenHash: 'hash',
      expiration: new Date(Date.now() - 1000),
    });
    expect(await storage().read({ userId, sessionId: String(record._id) })).toBeNull();
    expect(await storage().read({ userId, sessionId: 'invalid' })).toBeNull();
  }));
