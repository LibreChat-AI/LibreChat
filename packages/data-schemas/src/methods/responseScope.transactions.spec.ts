import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createResponseRetention,
  createResponseConversationReplacement,
  closeResponseScopes,
} from './responseScope';
import { tenantStorage } from '~/config/tenantContext';
import { createResponseStorage } from './response';
import { createModels } from '~/models';

describe('Response transaction owners with secondaryPreferred defaults', () => {
  const db = new mongoose.Mongoose();
  const owner = { userId: 'owner', tenantId: 'tenant' };
  const scoped = <T>(work: () => Promise<T>) =>
    tenantStorage.run({ tenantId: owner.tenantId }, work);
  let mongo: MongoMemoryReplSet;
  let secondary: mongoose.mongo.MongoClient;

  async function withReplicationPaused<T>(work: () => Promise<T>): Promise<T> {
    await db.connection
      .db!.collection('replication_barrier')
      .insertOne({}, { writeConcern: { w: 'majority' } });
    const admin = secondary.db('admin');
    const configured = await admin.command({
      configureFailPoint: 'stopReplProducer',
      mode: 'alwaysOn',
    });
    try {
      await admin.command({
        waitForFailPoint: 'stopReplProducer',
        timesEntered: configured.count + 1,
        maxTimeMS: 10000,
      });
      return await work();
    } finally {
      await admin.command({ configureFailPoint: 'stopReplProducer', mode: 'off' });
    }
  }

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      replSet: { count: 2 },
      instanceOpts: [
        { args: ['--setParameter', 'enableTestCommands=1'] },
        { args: ['--setParameter', 'enableTestCommands=1'] },
      ],
    });
    await db.connect(mongo.getUri(), {
      readPreference: 'secondaryPreferred',
      autoIndex: false,
      writeConcern: { w: 1 },
    });
    createModels(db);
    await Promise.all(
      [
        'StoredResponse',
        'ResponseScope',
        'ChannelReply',
        'ChannelFeedback',
        'ChannelFeedbackEvent',
      ].map((name) => db.model(name).createCollection()),
    );
    await db.model('StoredResponse').createIndexes();
    const hello = await db.connection
      .db!.admin()
      .command({ hello: 1 }, { readPreference: 'primary' });
    const address = (hello.hosts as string[]).find((host) => host !== hello.primary);
    if (!address) throw new Error('Missing secondary fixture');
    secondary = new mongoose.mongo.MongoClient(`mongodb://${address}`, {
      directConnection: true,
      readPreference: 'secondary',
    });
    await secondary.connect();
  }, 60000);

  afterAll(async () => {
    await secondary?.close();
    await db.disconnect();
    await mongo?.stop();
  });

  it('reserves, mutates and retains a response through its real owned transactions', async () =>
    scoped(() =>
      withReplicationPaused(async () => {
        const storage = createResponseStorage(db);
        const result = await storage.reserve({
          ...owner,
          dispatch: true,
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
          await secondary
            .db(db.connection.name)
            .collection(db.model('StoredResponse').collection.name)
            .findOne({ responseId: 'resp_reader_default' }),
        ).toBeNull();
        expect(
          await storage.settleDispatch(owner, 'resp_reader_default', {
            kind: 'create',
            id: 'resp_reader_default',
          }),
        ).toBe(true);
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
      }),
    ));

  it('observes closure even while the secondary still exposes the live response', async () =>
    scoped(async () => {
      const storage = createResponseStorage(db);
      await storage.reserve({
        ...owner,
        responseId: 'resp_closure',
        requestKey: 'closure',
        fingerprint: 'closure',
        agentId: 'agent',
        requestJSON: '{}',
        conversationId: 'closed-conversation',
        parentMessageId: 'root',
      });
      await withReplicationPaused(async () => {
        await closeResponseScopes(db, owner, ['closed-conversation']);
        expect(
          await secondary
            .db(db.connection.name)
            .collection(db.model('StoredResponse').collection.name)
            .findOne({ responseId: 'resp_closure' }),
        ).not.toBeNull();
        expect(await storage.read(owner, 'resp_closure')).toBeNull();
        expect((await storage.readCleanupIdentity(owner, 'resp_closure'))?.retirement).toBe(
          'conversation_deleted',
        );
      });
    }));
});
