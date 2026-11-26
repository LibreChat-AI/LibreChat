import mongoose from 'mongoose';
import { MongoServerError } from 'mongodb';
import { RetentionMode } from 'librechat-data-provider';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { resolveInsightsAttributions, insightsIdentityKey } from './insightsAttribution';
import { createInsightsExclusionModel } from '../models/insightsExclusion';
import { createTransactionModel } from '../models/transaction';
import { createConversationMethods } from './conversation';
import { createConversationModel } from '../models/convo';
import { createTransactionMethods } from './transaction';
import { materializeResponseTurn } from './responseTurn';
import { tenantStorage } from '../config/tenantContext';
import { createMessageModel } from '../models/message';
import { createAgentModel } from '../models/agent';
import { createInsightsMethods } from './insights';
import { createUserModel } from '../models/user';
import { createMessageMethods } from './message';

const conversationId = '11111111-1111-4111-8111-111111111111';
const owner = new mongoose.Types.ObjectId();
let server: MongoMemoryReplSet;

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri());
  await Promise.all([
    createConversationModel(mongoose).init(),
    createMessageModel(mongoose).init(),
    createTransactionModel(mongoose).init(),
    createAgentModel(mongoose).init(),
    createUserModel(mongoose).init(),
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})));
});

it('derives immutable root hints for writes, ignores forged hints, and keeps spend of a deleted conversation', async () => {
  await mongoose.models.Conversation.collection.insertOne({
    conversationId,
    user: owner.toString(),
    initial_agent_id: 'agent-a',
    agent_id: 'agent-b',
    createdAt: new Date(),
  });
  const messages = createMessageMethods(mongoose);
  await messages.saveMessage(
    { userId: owner.toString() },
    {
      conversationId,
      messageId: 'reply',
      isCreatedByUser: false,
      tokenCount: 8,
      insightsAgentId: 'forged-agent',
    },
  );
  const transactions = createTransactionMethods(mongoose, {
    getMultiplier: () => 1,
    getCacheMultiplier: () => null,
  });
  await transactions.bulkInsertTransactions([
    {
      user: owner.toString(),
      conversationId,
      messageId: 'reply',
      tokenType: 'completion',
      tokenValue: -8,
      rawAmount: -8,
      model: 'model-a',
      ...{ insightsAgentId: 'forged-agent' },
    },
  ]);
  expect(
    (await mongoose.models.Message.collection.findOne({ messageId: 'reply' }))?.insightsAgentId,
  ).toBe('agent-a');
  expect(
    (await mongoose.models.Transaction.collection.findOne({ messageId: 'reply' }))?.insightsAgentId,
  ).toBe('agent-a');
  const methods = createInsightsMethods(mongoose);
  expect(
    (await methods.getInsights({ agentIds: ['agent-a'], showDetails: false })).summary
      .totalResponses,
  ).toBe(1);
  await mongoose.models.Conversation.deleteMany({});
  await mongoose.models.Message.deleteMany({ conversationId });
  const deleted = await methods.getInsights({ agentIds: ['agent-a'], showDetails: false });
  expect(deleted.summary.totalResponses).toBe(0);
  expect(deleted.summary.spendUSD).toBeGreaterThan(0);
});

it('gives records saved before their conversation the hint once the conversation is created', async () => {
  const messages = createMessageMethods(mongoose);
  const conversations = createConversationMethods(mongoose, messages);
  const transactions = createTransactionMethods(mongoose, {
    getMultiplier: () => 1,
    getCacheMultiplier: () => null,
  });
  const hintOf = async (collection: 'Message' | 'Transaction', messageId: string) =>
    (await mongoose.models[collection].collection.findOne({ messageId }))?.insightsAgentId;

  await messages.saveMessage(
    { userId: owner.toString() },
    { conversationId, messageId: 'first-prompt', isCreatedByUser: true },
  );
  await transactions.bulkInsertTransactions([
    {
      user: owner.toString(),
      conversationId,
      messageId: 'first-prompt',
      tokenType: 'prompt',
      tokenValue: -1,
    },
  ]);
  expect(await hintOf('Message', 'first-prompt')).toBeUndefined();
  expect(await hintOf('Transaction', 'first-prompt')).toBeUndefined();
  await conversations.saveConvo(
    { userId: owner.toString() },
    { conversationId, endpoint: 'agents', agent_id: 'agent-a' },
    { initialAgentId: 'agent-a' },
  );
  expect(await hintOf('Message', 'first-prompt')).toBe('agent-a');
  expect(await hintOf('Transaction', 'first-prompt')).toBe('agent-a');

  await messages.saveMessage(
    { userId: owner.toString() },
    {
      conversationId: '22222222-2222-4222-8222-222222222222',
      messageId: 'plain-prompt',
      isCreatedByUser: true,
    },
  );
  await conversations.saveConvo(
    { userId: owner.toString() },
    { conversationId: '22222222-2222-4222-8222-222222222222', endpoint: 'openAI' },
  );
  expect(await hintOf('Message', 'plain-prompt')).toBeUndefined();

  await mongoose.models.Message.collection.updateOne(
    { messageId: 'first-prompt' },
    { $set: { insightsAgentId: 'kept' } },
  );
  await conversations.saveConvo(
    { userId: owner.toString() },
    { conversationId, endpoint: 'agents', agent_id: 'agent-a', title: 'Renamed' },
  );
  expect(await hintOf('Message', 'first-prompt')).toBe('kept');
});

describe('within a turn', () => {
  const userId = owner.toString();
  const messages = createMessageMethods(mongoose);
  const conversations = createConversationMethods(mongoose, messages);
  const transactions = createTransactionMethods(mongoose, {
    getMultiplier: () => 1,
    getCacheMultiplier: () => null,
  });
  const ephemeral = {
    userId,
    interfaceConfig: { retentionMode: RetentionMode.EPHEMERAL, temporaryChatRetention: 1 },
  };
  const runTurn = (turn: () => Promise<void>) => tenantStorage.run({ userId }, turn);
  const reply = (messageId: string) =>
    messages.saveMessage({ userId }, { conversationId, messageId, isCreatedByUser: false });
  const bill = (messageId: string, context = 'message') =>
    transactions.bulkInsertTransactions([
      { user: userId, conversationId, messageId, tokenType: 'completion', tokenValue: -1, context },
    ]);
  const convert = async () => {
    await conversations.stampForcedRetention(ephemeral, { conversationId });
  };
  const save = () => conversations.saveConvo(ephemeral, { conversationId, endpoint: 'agents' });
  const storedHints = (model: 'Message' | 'Transaction') =>
    mongoose.models[model].collection.distinct('insightsAgentId');

  beforeEach(async () => {
    await mongoose.models.Conversation.collection.insertOne({
      conversationId,
      user: userId,
      initial_agent_id: 'agent-a',
      codeAttachmentEpoch: 1,
      createdAt: new Date(),
    });
  });

  it('shares one lookup between messages and billing', async () => {
    const reads = jest.spyOn(mongoose.models.Conversation, 'find');
    await runTurn(async () => {
      await reply('first');
      await reply('second');
      await bill('second');
      expect(reads).toHaveBeenCalledTimes(1);
    });
    reads.mockRestore();
    expect(await storedHints('Message')).toEqual(['agent-a']);
    expect(await storedHints('Transaction')).toEqual(['agent-a']);
  });

  it.each([
    ['getConvo', () => conversations.getConvo(userId, conversationId)],
    ['searchConversation', () => conversations.searchConversation(conversationId, '-messages')],
    ['an unlimited search', () => conversations.searchConversation(conversationId, null)],
  ])('reuses the chat a request already loaded with %s', async (_loader, load) => {
    const reads = jest.spyOn(mongoose.models.Conversation, 'find');
    await runTurn(async () => {
      const loaded = await load();
      expect(loaded).toMatchObject({ conversationId, user: userId });
      expect(loaded).not.toHaveProperty('initial_agent_id');
      expect(loaded).not.toHaveProperty('codeAttachmentEpoch');
      await reply('reply');
      await bill('reply');
    });
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    expect(await storedHints('Message')).toEqual(['agent-a']);
    expect(await storedHints('Transaction')).toEqual(['agent-a']);
  });

  it('never reuses a chat loaded with only some of its fields', async () => {
    const reads = jest.spyOn(mongoose.models.Conversation, 'find');
    await runTurn(async () => {
      await conversations.searchConversation(conversationId);
      await reply('reply');
    });
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
    expect(await storedHints('Message')).toEqual(['agent-a']);
  });

  it('does not count what a loaded temporary or sub-agent chat saves', async () => {
    const { Conversation } = mongoose.models;
    for (const fields of [{ isTemporary: true }, { subagentThread: { depth: 1 } }]) {
      await Conversation.collection.updateOne({ conversationId }, { $set: fields });
      await runTurn(async () => {
        await conversations.getConvo(userId, conversationId);
        await reply('reply');
        await bill('reply');
      });
      expect(await storedHints('Message')).toEqual(['']);
      expect(await storedHints('Transaction')).toEqual(['']);
      await Conversation.collection.updateOne(
        { conversationId },
        { $unset: { isTemporary: 1, subagentThread: 1 } },
      );
    }
  });

  it('reads the chat again for every save in a context without a user', async () => {
    const reads = jest.spyOn(mongoose.models.Conversation, 'find');
    await tenantStorage.run({ requestId: 'sweep' }, async () => {
      await conversations.getConvo(userId, conversationId);
      await reply('before');
      await mongoose.models.Conversation.collection.updateOne(
        { conversationId },
        { $set: { isTemporary: true } },
      );
      await reply('after');
    });
    expect(reads).toHaveBeenCalledTimes(2);
    reads.mockRestore();
    expect(await storedHints('Message')).toEqual(['', 'agent-a']);
  });

  it('reads a legacy chat without a root agent once and keeps what the migration stored', async () => {
    const { Conversation, Message } = mongoose.models;
    await Conversation.collection.updateOne(
      { conversationId },
      { $unset: { initial_agent_id: 1 }, $set: { agent_id: 'agent-a' } },
    );
    const reads = jest.spyOn(Conversation, 'find');
    await runTurn(async () => {
      await reply('reply');
      await bill('reply');
      await Message.collection.updateOne(
        { messageId: 'reply' },
        { $set: { insightsAgentId: 'agent-a' } },
      );
      await reply('reply');
      await messages.bulkSaveMessages([{ messageId: 'reply', conversationId, user: userId }]);
      expect(reads).toHaveBeenCalledTimes(1);
    });
    reads.mockRestore();
    expect(await storedHints('Message')).toEqual(['agent-a']);
  });

  it('keeps saving, billing and the stored agent when the conversation cannot be read', async () => {
    await runTurn(async () => {
      await reply('known');
      await reply('imported');
    });
    const reads = jest.spyOn(mongoose.models.Conversation, 'find').mockImplementation(() => {
      throw new Error('unavailable');
    });
    await runTurn(async () => {
      await reply('known');
      await messages.bulkSaveMessages([{ messageId: 'imported', conversationId, user: userId }]);
      await reply('new');
      await bill('new');
    });
    reads.mockRestore();
    const { Message, Transaction } = mongoose.models;
    expect(await Message.countDocuments({ messageId: 'new' })).toBe(1);
    expect(await Transaction.countDocuments({ messageId: 'new' })).toBe(1);
    expect(await Message.countDocuments({ insightsAgentId: 'agent-a' })).toBe(2);
  });

  it('never bills a chat that became temporary in its own turn', async () => {
    await runTurn(async () => {
      await reply('reply');
      await bill('before');
      expect(await storedHints('Transaction')).toEqual(['agent-a']);
      await convert();
      expect(await storedHints('Transaction')).toEqual(['']);
      await reply('late');
      await bill('running');
    });
    expect(await storedHints('Transaction')).toEqual(['']);
    expect(await storedHints('Message')).toEqual(['']);
  });

  it('stops counting a chat that its conversation save makes temporary', async () => {
    await runTurn(async () => {
      await reply('reply');
    });
    await runTurn(async () => {
      await save();
    });
    expect(await storedHints('Message')).toEqual(['']);
  });

  it('clears what a running turn saved after another request converted the chat', async () => {
    await runTurn(async () => {
      await reply('reply');
      await bill('before');
      await runTurn(convert);
      expect(await storedHints('Transaction')).toEqual(['']);
      await reply('late');
      await bill('late');
      await save();
    });
    expect(await storedHints('Message')).toEqual(['']);
    expect(await storedHints('Transaction')).toEqual(['']);
  });

  const totals = async () => {
    const insights = createInsightsMethods(mongoose);
    const { summary } = await insights.getInsights({ agentIds: ['agent-a'], showDetails: false });
    return { messages: summary.totalMessages, spend: summary.spendUSD };
  };

  const exclusions = () => createInsightsExclusionModel(mongoose);
  const expire = () =>
    mongoose.models.Conversation.collection.deleteOne({ conversationId, user: userId });
  const saveTemporary = async () => void (await save());

  it.each([
    ['before', 'its retention stamp', convert],
    ['after', 'its retention stamp', convert],
    ['before', 'its conversation save', saveTemporary],
    ['after', 'its conversation save', saveTemporary],
  ])(
    'never counts a late charge saved %s its temporary chat expires, converted by %s',
    async (order, _change, change) => {
      await runTurn(async () => {
        await reply('reply');
        await bill('before');
        await runTurn(change);
        if (order === 'after') await expire();
        await bill('late');
      });
      if (order === 'before') await expire();
      const late = await mongoose.models.Transaction.collection.findOne({ messageId: 'late' });
      expect(late?.insightsAgentId).toBe('agent-a');
      expect(await totals()).toEqual({ messages: 0, spend: null });
    },
  );

  it.each(['Message', 'Transaction'] as const)(
    'never counts what a failed %s cleanup left behind',
    async (model) => {
      const failure = jest
        .spyOn(mongoose.models[model], 'updateMany')
        .mockRejectedValueOnce(new Error('unavailable'));
      await runTurn(async () => {
        await reply('reply');
        await bill('reply');
        await convert();
      });
      failure.mockRestore();
      expect(await storedHints(model)).toEqual(['agent-a']);
      expect(await totals()).toEqual({ messages: 0, spend: null });
    },
  );

  it('records one exclusion per converted chat and nothing more in its later turns', async () => {
    await runTurn(async () => {
      await reply('reply');
      await convert();
      await save();
    });
    expect(await exclusions().countDocuments({ conversationId, user: userId })).toBe(1);
    const writes = [
      jest.spyOn(mongoose.models.Message, 'updateMany'),
      jest.spyOn(mongoose.models.Transaction, 'updateMany'),
      jest.spyOn(exclusions(), 'updateOne'),
    ];
    await runTurn(async () => {
      await conversations.getConvo(userId, conversationId);
      await reply('next');
      await bill('next');
      await save();
      await convert();
    });
    writes.forEach((write) => expect(write).not.toHaveBeenCalled());
    writes.forEach((write) => write.mockRestore());
  });

  it('only excludes the converted chat of its own owner', async () => {
    const other = new mongoose.Types.ObjectId().toString();
    await mongoose.models.Conversation.collection.insertOne({
      conversationId,
      user: other,
      initial_agent_id: 'agent-a',
      createdAt: new Date(),
    });
    await messages.saveMessage(
      { userId: other },
      { conversationId, messageId: 'other', isCreatedByUser: false },
    );
    await runTurn(async () => {
      await reply('reply');
      await runTurn(convert);
      await reply('late');
    });
    expect((await totals()).messages).toBe(1);
  });

  it('still excludes a chat converted days before a late charge in the reported day', async () => {
    const day = 24 * 60 * 60 * 1000;
    await runTurn(async () => {
      await reply('reply');
      await bill('before');
      await runTurn(convert);
      await exclusions().updateMany({}, { $set: { createdAt: new Date(Date.now() - 3 * day) } });
      await bill('late');
    });
    await expire();
    const insights = createInsightsMethods(mongoose);
    const { summary } = await insights.getInsights({
      agentIds: ['agent-a'],
      showDetails: false,
      range: '24h',
    });
    expect(summary.spendUSD).toBeNull();
  });

  it('treats a concurrent conversion of the same chat as already excluded', async () => {
    const race = jest
      .spyOn(exclusions(), 'updateOne')
      .mockRejectedValueOnce(
        new MongoServerError({ message: 'E11000 duplicate key', code: 11000 }),
      );
    await convert();
    race.mockRestore();
    const stored = await mongoose.models.Conversation.collection.findOne({ conversationId });
    expect(stored?.isTemporary).toBe(true);
  });

  const temporary = async () =>
    (await mongoose.models.Conversation.collection.findOne({ conversationId }))?.isTemporary;

  it.each([
    ['its retention stamp', convert],
    ['its conversation save', saveTemporary],
  ])(
    'keeps a chat normal while its exclusion cannot be saved, then excludes it when %s is retried',
    async (_change, change) => {
      await runTurn(async () => {
        await reply('reply');
        await bill('before');
        const failure = jest
          .spyOn(exclusions(), 'updateOne')
          .mockRejectedValueOnce(new Error('unavailable'));
        await change().catch(() => null);
        failure.mockRestore();
        expect(await exclusions().countDocuments({})).toBe(0);
        expect(await temporary()).not.toBe(true);
        await change();
        expect(await temporary()).toBe(true);
        await bill('late');
      });
      expect(await exclusions().countDocuments({ conversationId, user: userId })).toBe(1);
      await expire();
      expect((await totals()).spend).toBeNull();
    },
  );

  it.each([
    ['its retention stamp', 'updateOne', convert],
    ['its conversation save', 'findOneAndUpdate', saveTemporary],
  ] as const)(
    'removes the exclusion when %s fails to convert the chat',
    async (_change, write, change) => {
      await reply('reply');
      const failure = jest
        .spyOn(mongoose.models.Conversation, write)
        .mockRejectedValueOnce(new Error('unavailable'));
      await change().catch(() => null);
      failure.mockRestore();
      expect(await temporary()).not.toBe(true);
      expect(await exclusions().countDocuments({})).toBe(0);
      expect((await totals()).messages).toBe(1);
    },
  );

  it('clears the excluded chats of a large report in bounded batches, without one big filter', async () => {
    const createdAt = new Date();
    const chats = Array.from({ length: 2500 }, (_, index) => `excluded-${index}`);
    await mongoose.models.Message.collection.insertMany(
      chats.map((chat) => ({
        conversationId: chat,
        messageId: chat,
        user: userId,
        insightsAgentId: 'agent-a',
        isCreatedByUser: true,
        createdAt,
      })),
    );
    await exclusions().collection.insertMany(
      chats.map((chat) => ({ conversationId: chat, user: userId, createdAt })),
    );
    const writes = jest.spyOn(mongoose.models.Message, 'updateMany');
    const aggregate = jest.spyOn(mongoose.models.Message, 'aggregate');
    expect((await totals()).messages).toBe(0);
    const filters = writes.mock.calls as unknown as Array<[{ $or: unknown[] }]>;
    expect(filters.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...filters.map(([filter]) => filter.$or.length))).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(aggregate.mock.calls)).not.toContain('$nor');
    [writes, aggregate].forEach((spy) => spy.mockRestore());
  });

  it('leaves no exclusion behind when a conversion is refused', async () => {
    await reply('reply');
    const refused = await conversations.saveConvo(ephemeral, {
      conversationId,
      newConversationId: '22222222-2222-4222-8222-222222222222',
      endpoint: 'agents',
    });
    expect(refused).toEqual({ message: 'Conversation ID cannot be replaced after persistence.' });
    expect(await exclusions().countDocuments({})).toBe(0);
    expect((await totals()).messages).toBe(1);
  });

  it('keeps counting a chat when the dashboard reads during a conversion that then fails', async () => {
    await runTurn(async () => {
      await reply('reply');
      await bill('reply');
    });
    let during = -1;
    const conversion = jest
      .spyOn(mongoose.models.Conversation, 'updateOne')
      .mockImplementationOnce((() =>
        totals().then(({ messages }) => {
          during = messages;
          throw new Error('unavailable');
        })) as never);
    await expect(convert()).rejects.toThrow('unavailable');
    conversion.mockRestore();
    expect(during).toBe(1);
    expect(await exclusions().countDocuments({})).toBe(0);
    expect((await totals()).messages).toBe(1);
    expect(await storedHints('Message')).toEqual(['agent-a']);
    expect(await storedHints('Transaction')).toEqual(['agent-a']);
  });

  it('keeps counting a chat whose deletion failed', async () => {
    await runTurn(async () => {
      await reply('reply');
      await bill('reply');
    });
    const deletion = jest
      .spyOn(mongoose.models.Conversation, 'deleteMany')
      .mockRejectedValueOnce(new Error('unavailable'));
    await expect(conversations.deleteConvos(userId, { conversationId })).rejects.toThrow(
      'unavailable',
    );
    deletion.mockRestore();
    expect(await mongoose.models.Conversation.countDocuments({})).toBe(1);
    expect((await totals()).messages).toBe(1);
    expect(await storedHints('Message')).toEqual(['agent-a']);
  });

  it('stops counting the messages of a deleted chat even when their cleanup fails', async () => {
    await runTurn(async () => {
      await reply('reply');
      await bill('reply');
    });
    const cleanup = jest
      .spyOn(mongoose.models.Message, 'deleteMany')
      .mockRejectedValue(new Error('unavailable'));
    await conversations.deleteConvos(userId, { conversationId });
    cleanup.mockRestore();
    expect(await mongoose.models.Message.countDocuments({})).toBe(1);
    expect((await totals()).messages).toBe(0);
    expect(await storedHints('Transaction')).toEqual(['agent-a']);
  });

  it('only reads the exclusions of chats in the report, by index', async () => {
    await exclusions().collection.insertMany(
      Array.from({ length: 300 }, (_, index) => ({
        conversationId: `other-${index}`,
        user: userId,
        createdAt: new Date(),
      })),
    );
    await reply('reply');
    const reads = jest.spyOn(exclusions(), 'find');
    expect((await totals()).messages).toBe(1);
    const filter = reads.mock.results[0].value.getFilter();
    reads.mockRestore();
    expect(await exclusions().countDocuments(filter)).toBe(0);
    const plan = await exclusions().find(filter).explain();
    expect(JSON.stringify(plan)).toContain('"insights_exclusion"');
  });

  it('adds nothing to the reports while no chat was converted', async () => {
    await reply('reply');
    const aggregate = jest.spyOn(mongoose.models.Message, 'aggregate');
    const reads = jest.spyOn(exclusions(), 'find');
    expect((await totals()).messages).toBe(1);
    expect(JSON.stringify(aggregate.mock.calls)).not.toContain('$nor');
    expect(reads).not.toHaveBeenCalled();
    [aggregate, reads].forEach((spy) => spy.mockRestore());
  });

  it('checks the chats of a large report in bounded batches', async () => {
    await runTurn(async () => {
      await reply('reply');
      await convert();
    });
    const createdAt = new Date();
    await mongoose.models.Message.collection.insertMany(
      Array.from({ length: 2500 }, (_, index) => ({
        conversationId: `chat-${index}`,
        messageId: `chat-${index}`,
        user: userId,
        insightsAgentId: 'agent-a',
        isCreatedByUser: true,
        createdAt,
      })),
    );
    const reads = jest.spyOn(exclusions(), 'find');
    expect((await totals()).messages).toBe(2500);
    const sizes = reads.mock.results.map(
      ({ value }) => value.getFilter().conversationId.$in.length as number,
    );
    reads.mockRestore();
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
  });

  it('creates a chat without an agent without updating its records', async () => {
    const { Conversation, Message, Transaction } = mongoose.models;
    await Conversation.deleteMany({});
    const writes = [jest.spyOn(Message, 'updateMany'), jest.spyOn(Transaction, 'updateMany')];
    const reads = jest.spyOn(Conversation, 'find');
    await runTurn(async () => {
      await reply('prompt');
      await conversations.saveConvo({ userId }, { conversationId, endpoint: 'openAI' });
      await reply('reply');
      await bill('reply');
    });
    writes.forEach((write) => expect(write).not.toHaveBeenCalled());
    expect(reads).toHaveBeenCalledTimes(1);
    [...writes, reads].forEach((spy) => spy.mockRestore());
    expect(await storedHints('Message')).toEqual(['']);
    expect(await storedHints('Transaction')).toEqual(['']);
  });

  it('does not repeat the cleanup of a chat that is already temporary', async () => {
    await runTurn(async () => {
      await reply('first');
      await save();
    });
    const writes = jest.spyOn(mongoose.models.Transaction, 'updateMany');
    await runTurn(async () => {
      await reply('second');
      await bill('second');
      await save();
      await convert();
    });
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
  });

  it('clears again when part of the cleanup failed', async () => {
    const failure = jest
      .spyOn(mongoose.models.Transaction, 'updateMany')
      .mockRejectedValueOnce(new Error('unavailable'));
    await runTurn(async () => {
      await bill('before');
      await convert();
      expect(await storedHints('Transaction')).toEqual(['agent-a']);
      await save();
      expect(await storedHints('Transaction')).toEqual(['']);
    });
    failure.mockRestore();
  });

  it('leaves the same conversation and user of another tenant untouched', async () => {
    await mongoose.models.Conversation.collection.insertOne({
      conversationId,
      user: userId,
      tenantId: 'tenant-b',
      initial_agent_id: 'agent-b',
    });
    await tenantStorage.run({ userId, tenantId: 'tenant-b' }, async () => {
      await reply('other');
      await bill('other');
    });
    await bill('own');
    await convert();
    const { Message, Transaction } = mongoose.models;
    expect(await Transaction.collection.distinct('insightsAgentId', { messageId: 'own' })).toEqual([
      '',
    ]);
    const counted = { tenantId: 'tenant-b', insightsAgentId: 'agent-b' };
    expect(await Message.collection.countDocuments(counted)).toBe(1);
    expect(await Transaction.collection.countDocuments(counted)).toBe(1);
  });
});

describe('a Responses turn saved in a transaction', () => {
  const userId = owner.toString();
  const messages = createMessageMethods(mongoose);
  const conversations = createConversationMethods(mongoose, messages);
  const transactions = createTransactionMethods(mongoose, {
    getMultiplier: () => 1,
    getCacheMultiplier: () => null,
  });
  const bill = () =>
    transactions.bulkInsertTransactions([
      {
        user: userId,
        conversationId,
        messageId: 'reply',
        tokenType: 'completion',
        tokenValue: -1,
        context: 'message',
      },
    ]);
  const counted = async (session: mongoose.ClientSession | null = null) => {
    const { Message, Transaction } = mongoose.models;
    const match = { conversationId, insightsAgentId: 'agent-a' };
    return [
      await Message.countDocuments(match).session(session),
      await Transaction.countDocuments(match).session(session),
    ];
  };
  const commit = ({
    retentionMode,
    inspect,
  }: {
    retentionMode?: RetentionMode;
    inspect?: (session: mongoose.ClientSession) => Promise<void>;
  } = {}) =>
    mongoose.connection.transaction(async (session) => {
      await materializeResponseTurn(mongoose, session, {
        intentJSON: '{}',
        context: { userId, ...(retentionMode && { interfaceConfig: { retentionMode } }) },
        conversation: { conversationId, endpoint: 'agents', agent_id: 'agent-a' },
        initialAgentId: 'agent-a',
        messages: [
          { conversationId, messageId: 'prompt', isCreatedByUser: true, text: 'Question' },
          { conversationId, messageId: 'reply', isCreatedByUser: false, text: 'Answer' },
        ],
      });
      await inspect?.(session);
    });

  it('is counted inside its own transaction, with the usage billed before it', async () => {
    await bill();
    expect(await counted()).toEqual([0, 0]);
    await commit({
      inspect: async (session) => {
        expect(await counted(session)).toEqual([2, 1]);
        expect(await counted()).toEqual([0, 0]);
      },
    });
    expect(await counted()).toEqual([2, 1]);
  });

  it('is cleared inside the transaction that makes its chat temporary', async () => {
    await bill();
    await commit();
    await commit({
      retentionMode: RetentionMode.EPHEMERAL,
      inspect: async (session) => {
        expect(await counted(session)).toEqual([0, 0]);
        expect(await counted()).toEqual([2, 1]);
        const excluded = createInsightsExclusionModel(mongoose);
        expect(await excluded.countDocuments({ conversationId }).session(session)).toBe(1);
        expect(await excluded.countDocuments({ conversationId })).toBe(0);
      },
    });
    expect(await counted()).toEqual([0, 0]);
  });

  it.each(['Message', 'Transaction'])(
    'is not saved without its attribution when the %s write fails, and is counted once repeated',
    async (model) => {
      const { Message, Conversation } = mongoose.models;
      const failure = jest
        .spyOn(mongoose.models[model], 'updateMany')
        .mockRejectedValueOnce(new Error('unavailable'));
      await bill();
      await expect(commit()).rejects.toThrow('unavailable');
      failure.mockRestore();
      expect(await Message.countDocuments({ conversationId })).toBe(0);
      expect(await Conversation.countDocuments({ conversationId })).toBe(0);
      await commit();
      expect(await counted()).toEqual([2, 1]);
    },
  );

  it('leaves no agent behind in the request when its transaction is undone', async () => {
    await tenantStorage.run({ userId }, async () => {
      const undone = commit({ inspect: () => Promise.reject(new Error('undone')) });
      await expect(undone).rejects.toThrow('undone');
      await messages.saveMessage(
        { userId },
        { conversationId, messageId: 'prompt', isCreatedByUser: true },
      );
      await conversations.saveConvo(
        { userId },
        { conversationId, endpoint: 'agents', agent_id: 'agent-b' },
        { initialAgentId: 'agent-b' },
      );
    });
    expect(await mongoose.models.Message.collection.distinct('insightsAgentId')).toEqual([
      'agent-b',
    ]);
  });

  it('shares its agent with the rest of the request once committed', async () => {
    const reads = jest.spyOn(mongoose.models.Conversation, 'find');
    await tenantStorage.run({ userId }, async () => {
      await commit();
      reads.mockClear();
      await bill();
      expect(reads).not.toHaveBeenCalled();
    });
    reads.mockRestore();
    expect(await counted()).toEqual([2, 1]);
  });
});

it('resolves only matching tenant/owner identities and distinguishes unattributed from legacy records', async () => {
  await mongoose.models.Conversation.collection.insertMany([
    {
      conversationId: 'shared',
      user: owner.toString(),
      tenantId: 'tenant-a',
      initial_agent_id: 'agent-a',
    },
    {
      conversationId: 'shared',
      user: owner.toString(),
      tenantId: 'tenant-b',
      initial_agent_id: 'agent-b',
    },
    {
      conversationId: 'unattributed',
      user: owner.toString(),
      initial_agent_id: null,
      agent_id: 'agent-a',
    },
  ]);
  const identities = [
    { conversationId: 'shared', user: owner.toString(), tenantId: 'tenant-a' },
    { conversationId: 'shared', user: owner.toString(), tenantId: 'tenant-b' },
    { conversationId: 'shared', user: owner.toString() },
    { conversationId: 'shared', user: 'outsider', tenantId: 'tenant-a' },
    { conversationId: 'unattributed', user: owner.toString() },
  ];
  const hints = await resolveInsightsAttributions(mongoose, identities);
  expect(identities.map((identity) => hints.get(insightsIdentityKey(identity)))).toEqual([
    'agent-a',
    'agent-b',
    undefined,
    undefined,
    '',
  ]);
});

it('uses the root-period index without reading unrelated agents or old messages', async () => {
  const now = new Date();
  const history = new Date(now.getTime() - 365 * 86400000);
  await mongoose.models.Conversation.collection.insertMany([
    { conversationId, user: owner.toString(), initial_agent_id: 'agent-a', createdAt: history },
    {
      conversationId: 'other',
      user: owner.toString(),
      initial_agent_id: 'agent-b',
      createdAt: history,
    },
  ]);
  await mongoose.models.Message.collection.insertMany([
    {
      conversationId,
      user: owner.toString(),
      messageId: 'recent',
      isCreatedByUser: false,
      createdAt: now,
      insightsAgentId: 'agent-a',
    },
    ...Array.from({ length: 1000 }, (_, i) => ({
      conversationId,
      user: owner.toString(),
      messageId: `old-${i}`,
      createdAt: history,
      insightsAgentId: 'agent-a',
    })),
    ...Array.from({ length: 1000 }, (_, i) => ({
      conversationId,
      user: owner.toString(),
      messageId: `unindexed-${i}`,
      createdAt: now,
    })),
    ...Array.from({ length: 1000 }, (_, i) => ({
      conversationId: 'other',
      user: owner.toString(),
      messageId: `other-${i}`,
      createdAt: now,
      insightsAgentId: 'agent-b',
    })),
  ]);
  const spy = jest.spyOn(mongoose.models.Message, 'aggregate');
  const result = await createInsightsMethods(mongoose).getInsights({
    agentIds: ['agent-a'],
    showDetails: false,
  });
  expect(result.summary.totalMessages).toBe(1);
  const pipeline = spy.mock.calls[0][0];
  if (!pipeline) throw new Error('Missing message query');
  type ExecutionStats = { totalDocsExamined: number };
  const plan: {
    executionStats?: ExecutionStats;
    stages?: Array<{ $cursor?: { executionStats?: ExecutionStats } }>;
  } = await mongoose.models.Message.aggregate(pipeline).explain('executionStats');
  expect(JSON.stringify(plan)).toContain('insights_root_period');
  const examined =
    plan.executionStats?.totalDocsExamined ??
    plan.stages?.find((stage) => stage.$cursor)?.$cursor?.executionStats?.totalDocsExamined;
  expect(examined).toBeDefined();
  expect(examined).toBeLessThan(20);
});
