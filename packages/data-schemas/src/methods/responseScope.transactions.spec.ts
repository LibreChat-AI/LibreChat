import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createResponseRetention, createResponseConversationReplacement } from './responseScope';
import { tenantStorage } from '~/config/tenantContext';
import { createResponseStorage } from './response';
import { createModels } from '~/models';

describe('Response transaction owners with secondaryPreferred defaults', () => {
  const db = new mongoose.Mongoose();
  const owner = { userId: 'owner', tenantId: 'tenant' };
  const scoped = <T>(work: () => Promise<T>) =>
    tenantStorage.run({ tenantId: owner.tenantId }, work);
  let mongo: MongoMemoryReplSet;

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri(), { readPreference: 'secondaryPreferred', autoIndex: false });
    createModels(db);
  }, 60000);

  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
  });

  it('reserves, mutates and retains a response through its real owned transactions', async () =>
    scoped(async () => {
      const storage = createResponseStorage(db);
      const result = await storage.reserve({
        ...owner,
        responseId: 'resp_reader_default',
        requestKey: 'reader-default',
        fingerprint: 'same-request',
        agentId: 'agent',
        requestJSON: JSON.stringify({ model: 'agent', input: 'hello', background: true }),
        conversationId: 'conversation',
        parentMessageId: 'root',
      });
      expect(result.ok).toBe(true);
      expect(
        (await storage.requestCancellation(owner, 'resp_reader_default', 123))
          ?.cancellationRequestedAt,
      ).toBe(123);
      const expiry = new Date(Date.now() + 60000);
      await createResponseRetention(db)(owner, 'conversation', expiry);
      expect((await storage.read(owner, 'resp_reader_default'))?.expiredAt).toEqual(expiry);
      expect(await createResponseConversationReplacement(db)(owner, 'conversation')).toBe(false);
      expect(await createResponseConversationReplacement(db)(owner, 'unused-conversation')).toBe(
        true,
      );
    }));
});
