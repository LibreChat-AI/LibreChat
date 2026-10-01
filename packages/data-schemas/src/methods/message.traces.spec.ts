import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IMessage } from '..';
import { tenantStorage } from '~/config/tenantContext';
import { createMessageMethods } from './message';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const TENANT_A = 'tenant-aaaaaaaaaaaaaaaaaaaa';
const TENANT_B = 'tenant-bbbbbbbbbbbbbbbbbbbb';

let mongoServer: MongoMemoryServer;
let Message: mongoose.Model<IMessage>;
let methods: ReturnType<typeof createMessageMethods>;

function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 8, 1, 12, minutes));
}

/** Inserts raw rows; `isCreatedByUser` gets the schema's default, as a Mongoose write would. */
async function seed(messages: Array<Partial<IMessage>>): Promise<void> {
  await Message.collection.insertMany(
    messages.map((message) => ({ isCreatedByUser: false, ...message })),
  );
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  Message = mongoose.models.Message as mongoose.Model<IMessage>;
  methods = createMessageMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Message.deleteMany({});
});

describe('getConversationTraceRefs', () => {
  it('returns the first message time and sampled responses oldest first', async () => {
    await seed([
      { messageId: 'user-1', conversationId: 'convo', user: 'owner', createdAt: at(1) },
      {
        messageId: 'response-2',
        conversationId: 'convo',
        user: 'owner',
        createdAt: at(4),
        langfuseSampled: true,
      },
      {
        messageId: 'response-1',
        conversationId: 'convo',
        user: 'owner',
        createdAt: at(2),
        langfuseSampled: true,
        langfuseDestinationIds: ['destination-a'],
      },
      {
        messageId: 'response-unsampled',
        conversationId: 'convo',
        user: 'owner',
        createdAt: at(3),
        langfuseSampled: false,
      },
      {
        messageId: 'user-5_',
        conversationId: 'convo',
        user: 'owner',
        createdAt: at(5),
        error: true,
        langfuseSampled: true,
        langfuseRunId: 'run-5',
      },
    ]);

    const refs = await methods.getConversationTraceRefs({ user: 'owner', conversationId: 'convo' });

    expect(refs).toEqual({
      firstMessageAt: at(1),
      sampledMessages: [
        {
          messageId: 'response-1',
          createdAt: at(2),
          orderKey: expect.any(String),
          langfuseDestinationIds: ['destination-a'],
        },
        { messageId: 'response-2', createdAt: at(4), orderKey: expect.any(String) },
        {
          messageId: 'user-5_',
          createdAt: at(5),
          orderKey: expect.any(String),
          langfuseRunId: 'run-5',
        },
      ],
    });
  });

  it('orders responses saved in the same millisecond by id, so every read rebuilds one order', async () => {
    const later = new mongoose.Types.ObjectId('66e2d7a0a1b2c3d4e5f60002');
    const earlier = new mongoose.Types.ObjectId('66e2d7a0a1b2c3d4e5f60001');
    await seed([
      {
        _id: later,
        messageId: 'second',
        conversationId: 'convo',
        user: 'owner',
        createdAt: at(2),
        langfuseSampled: true,
      },
      {
        _id: earlier,
        messageId: 'first',
        conversationId: 'convo',
        user: 'owner',
        createdAt: at(2),
        langfuseSampled: true,
      },
    ] as Array<Partial<IMessage>>);

    const refs = await methods.getConversationTraceRefs({ user: 'owner', conversationId: 'convo' });

    expect(refs.sampledMessages.map(({ messageId }) => messageId)).toEqual(['first', 'second']);
  });

  it('reads a bounded page of sampled responses ending at a position a previous read returned', async () => {
    await seed(
      [1, 2, 3, 4, 5].map((index) => ({
        messageId: `response-${index}`,
        conversationId: 'convo',
        user: 'owner',
        createdAt: at(index),
        langfuseSampled: true,
      })),
    );
    const read = (input: Record<string, unknown>) =>
      methods.getConversationTraceRefs({ user: 'owner', conversationId: 'convo', ...input });
    const ids = (refs: { sampledMessages: Array<{ messageId: string }> }) =>
      refs.sampledMessages.map(({ messageId }) => messageId);

    const newest = await read({ limit: 2 });
    expect(ids(newest)).toEqual(['response-4', 'response-5']);
    const all = await read({});
    const third = all.sampledMessages[2];
    const findOne = jest.spyOn(Message, 'findOne');
    await read({ through: { messageId: third.messageId, orderKey: third.orderKey }, limit: 2 });
    /** One round trip: the only other lookup is the conversation's first message, run alongside. */
    expect(findOne).toHaveBeenCalledTimes(1);
    findOne.mockRestore();
    expect(
      ids(
        await read({ through: { messageId: third.messageId, orderKey: third.orderKey }, limit: 2 }),
      ),
    ).toEqual(['response-2', 'response-3']);
    expect(
      ids(await read({ through: { messageId: 'response-1', orderKey: third.orderKey }, limit: 2 })),
    ).toEqual([]);
    expect(
      ids(await read({ through: { messageId: third.messageId, orderKey: 'forged' }, limit: 2 })),
    ).toEqual([]);
    /** A time past the Date range parses to a number but not to a date; it resumes nothing. */
    const beyondDateRange = `${'z'.repeat(16)}.${third.orderKey?.split('.')[1]}`;
    expect(
      ids(
        await read({
          through: { messageId: third.messageId, orderKey: beyondDateRange },
          limit: 2,
        }),
      ),
    ).toEqual([]);
    expect(ids(await read({ messageId: 'response-2' }))).toEqual(['response-2']);
    expect(ids(await read({ messageId: 'someone-elses-response' }))).toEqual([]);
    expect(ids(all)).toHaveLength(5);
  });

  it('never treats a client-authored row as a sampled response', async () => {
    await seed([
      {
        messageId: 'server-response',
        conversationId: 'convo',
        user: 'owner',
        createdAt: at(1),
        isCreatedByUser: false,
        isUserSubmitted: false,
        langfuseSampled: true,
      },
      {
        messageId: 'forged-victim-response-id',
        conversationId: 'convo',
        user: 'owner',
        createdAt: at(2),
        isCreatedByUser: false,
        isUserSubmitted: true,
        langfuseSampled: true,
      },
    ]);

    const refs = await methods.getConversationTraceRefs({ user: 'owner', conversationId: 'convo' });

    expect(refs.sampledMessages.map(({ messageId }) => messageId)).toEqual(['server-response']);
  });

  it("never returns another user's messages from a conversation with the same id", async () => {
    await seed([
      {
        messageId: 'victim-response',
        conversationId: 'shared-id',
        user: 'victim',
        createdAt: at(0),
        langfuseSampled: true,
      },
      { messageId: 'own-user', conversationId: 'shared-id', user: 'owner', createdAt: at(5) },
    ]);

    const refs = await methods.getConversationTraceRefs({
      user: 'owner',
      conversationId: 'shared-id',
    });

    expect(refs).toEqual({ firstMessageAt: at(5), sampledMessages: [] });
  });

  it('reads only the active tenant', async () => {
    await tenantStorage.run({ tenantId: TENANT_A }, () =>
      Message.create({
        messageId: 'tenant-a-response',
        conversationId: 'convo',
        user: 'owner',
        langfuseSampled: true,
      }),
    );
    await tenantStorage.run({ tenantId: TENANT_B }, () =>
      Message.create({
        messageId: 'tenant-b-response',
        conversationId: 'convo',
        user: 'owner',
        langfuseSampled: true,
      }),
    );

    const refs = await tenantStorage.run({ tenantId: TENANT_B }, () =>
      methods.getConversationTraceRefs({
        user: 'owner',
        conversationId: 'convo',
        tenantId: TENANT_B,
      }),
    );

    expect(refs.sampledMessages.map(({ messageId }) => messageId)).toEqual(['tenant-b-response']);
  });

  it('scopes to the given tenant even without request tenant context', async () => {
    await seed([
      { messageId: 'tenantless', conversationId: 'convo', user: 'owner', langfuseSampled: true },
      {
        messageId: 'tenant-a',
        conversationId: 'convo',
        user: 'owner',
        tenantId: TENANT_A,
        langfuseSampled: true,
      },
    ]);

    const tenantless = await methods.getConversationTraceRefs({
      user: 'owner',
      conversationId: 'convo',
    });
    const scoped = await methods.getConversationTraceRefs({
      user: 'owner',
      conversationId: 'convo',
      tenantId: TENANT_A,
    });
    const tenantlessExists = await methods.hasSampledTraceMessage({
      user: 'owner',
      conversationId: 'convo',
      destinationIds: [],
    });
    await Message.deleteMany({ tenantId: { $exists: false } });
    const tenantlessAfter = await methods.hasSampledTraceMessage({
      user: 'owner',
      conversationId: 'convo',
      destinationIds: [],
    });

    expect(tenantless.sampledMessages.map(({ messageId }) => messageId)).toEqual(['tenantless']);
    expect(scoped.sampledMessages.map(({ messageId }) => messageId)).toEqual(['tenant-a']);
    expect(tenantlessExists).toBe(true);
    expect(tenantlessAfter).toBe(false);
  });
});

describe('hasSampledTraceMessage', () => {
  const sampled = (messageId: string, overrides: Partial<IMessage> = {}): Partial<IMessage> => ({
    messageId,
    conversationId: 'convo',
    user: 'owner',
    createdAt: at(1),
    langfuseSampled: true,
    isCreatedByUser: false,
    ...overrides,
  });

  it('finds a newer response held by a readable destination after older ones went elsewhere', async () => {
    await seed([
      sampled('old', { createdAt: at(1), langfuseDestinationIds: ['retired'] }),
      sampled('new', { createdAt: at(9), langfuseDestinationIds: ['current'] }),
    ]);

    await expect(
      methods.hasSampledTraceMessage({
        user: 'owner',
        conversationId: 'convo',
        destinationIds: ['current'],
      }),
    ).resolves.toBe(true);
    await expect(
      methods.hasSampledTraceMessage({
        user: 'owner',
        conversationId: 'convo',
        destinationIds: ['elsewhere'],
      }),
    ).resolves.toBe(false);
  });

  it('counts a response with no recorded destinations for any destination', async () => {
    await seed([sampled('unrecorded')]);

    await expect(
      methods.hasSampledTraceMessage({
        user: 'owner',
        conversationId: 'convo',
        destinationIds: [],
      }),
    ).resolves.toBe(true);
  });

  it('ignores unsampled responses, an empty destination record, other users and client-authored rows', async () => {
    await seed([
      sampled('unsampled', { langfuseSampled: false }),
      sampled('recorded-none', { langfuseDestinationIds: [] }),
      sampled('someone-else', { user: 'victim' }),
      sampled('forged-by-client', { isUserSubmitted: true }),
      sampled('user-turn', { isCreatedByUser: true }),
    ]);

    await expect(
      methods.hasSampledTraceMessage({
        user: 'owner',
        conversationId: 'convo',
        destinationIds: ['current'],
      }),
    ).resolves.toBe(false);
  });
});
