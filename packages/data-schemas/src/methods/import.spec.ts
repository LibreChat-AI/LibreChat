import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE, createConversationImportMethods } from './import';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createManagedMessageId } from '~/utils/managed';
import { createResponseStorage } from './response';
import { createModels } from '~/models';
import { createMethods } from './index';

createModels(mongoose);

describe('conversation import cleanup methods', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('removes only the generated IDs for the authenticated owner and tenant', async () => {
    const methods = createMethods(mongoose);
    const project = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, async () =>
      methods.createChatProject('owner-a', { name: 'Imported chats' }),
    );
    const chatProjectId = project._id!.toString();
    const target = {
      user: 'owner-a',
      conversationId: 'generated-target',
      tenantId: 'tenant-a',
      chatProjectId,
    };
    const records = [
      target,
      { ...target, conversationId: 'untouched-id' },
      { ...target, user: 'owner-b' },
      { ...target, tenantId: 'tenant-b' },
    ];

    await runAsSystem(async () => {
      await mongoose.models.Conversation.insertMany(
        records.map((record) => ({
          ...record,
          endpoint: 'openAI',
          title: record.conversationId,
          createdAt: new Date(
            record.conversationId === target.conversationId
              ? '2026-02-01T00:00:00.000Z'
              : '2026-01-01T00:00:00.000Z',
          ),
          updatedAt: new Date(
            record.conversationId === target.conversationId
              ? '2026-02-01T00:00:00.000Z'
              : '2026-01-01T00:00:00.000Z',
          ),
        })),
      );
      await mongoose.models.Message.insertMany(
        records.map((record, index) => ({
          ...record,
          messageId: `message-${index}`,
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          text: record.conversationId,
        })),
      );
      await mongoose.models.ChatProject.updateOne(
        { _id: project._id },
        {
          $set: {
            conversationCount: 2,
            lastConversationAt: new Date('2026-02-01T00:00:00.000Z'),
            lastConversationId: target.conversationId,
          },
        },
      );
    });

    const storage = createResponseStorage(mongoose);
    for (const [index, record] of records.entries()) {
      const reserved = await tenantStorage.run(
        { tenantId: record.tenantId, userId: record.user },
        () =>
          storage.reserve({
            userId: record.user,
            tenantId: record.tenantId,
            conversationId: record.conversationId,
            responseId: createManagedMessageId(),
            requestKey: `request-${index}`,
            fingerprint: 'request',
            agentId: 'agent',
            requestJSON: '{"input":"private"}',
            parentMessageId: 'root',
          }),
      );
      expect(reserved.ok).toBe(true);
    }

    await tenantStorage.run({ tenantId: target.tenantId, userId: target.user }, async () => {
      const scope = {
        user: target.user,
        conversationIds: [target.conversationId],
        tenantId: target.tenantId,
      };
      await methods.deleteImportedMessages(scope);
      await methods.deleteImportedConversations(scope);
    });

    const remaining = await runAsSystem(async () => {
      const conversations = await mongoose.models.Conversation.find({}).lean();
      const messages = await mongoose.models.Message.find({}).lean();
      const refreshedProject = await mongoose.models.ChatProject.findById(project._id).lean();
      return { conversations, messages, refreshedProject };
    });
    expect(remaining.conversations).toHaveLength(3);
    expect(remaining.messages).toHaveLength(3);
    expect(await runAsSystem(async () => mongoose.models.StoredResponse.countDocuments({}))).toBe(
      3,
    );
    expect(
      remaining.conversations.some(
        (record) =>
          record.user === target.user &&
          record.tenantId === target.tenantId &&
          record.conversationId === target.conversationId,
      ),
    ).toBe(false);
    expect(
      remaining.messages.some(
        (record) =>
          record.user === target.user &&
          record.tenantId === target.tenantId &&
          record.conversationId === target.conversationId,
      ),
    ).toBe(false);
    expect(remaining.refreshedProject).toMatchObject({
      conversationCount: 1,
      lastConversationId: 'untouched-id',
    });
  });

  it('requires an absent tenant field for tenantless cleanup', async () => {
    const methods = createMethods(mongoose);
    const base = { user: 'owner-a', conversationId: 'generated-target' };
    await runAsSystem(async () => {
      await mongoose.models.Conversation.insertMany([
        { ...base, endpoint: 'openAI', title: 'tenantless' },
        { ...base, endpoint: 'openAI', tenantId: 'tenant-a', title: 'tenant' },
      ]);
      await mongoose.models.Message.insertMany([
        { ...base, messageId: 'tenantless-message', text: 'tenantless' },
        { ...base, tenantId: 'tenant-a', messageId: 'tenant-message', text: 'tenant' },
      ]);
    });

    await methods.deleteImportedMessages({
      user: base.user,
      conversationIds: [base.conversationId],
    });
    await methods.deleteImportedConversations({
      user: base.user,
      conversationIds: [base.conversationId],
    });

    const remaining = await runAsSystem(async () => ({
      conversations: await mongoose.models.Conversation.find({}).lean(),
      messages: await mongoose.models.Message.find({}).lean(),
    }));
    expect(remaining.conversations).toHaveLength(1);
    expect(remaining.conversations[0].tenantId).toBe('tenant-a');
    expect(remaining.messages).toHaveLength(1);
    expect(remaining.messages[0].tenantId).toBe('tenant-a');
  });

  it('chunks every cleanup query while retaining its exact owner and tenant scope', async () => {
    const deleteMessages = jest.spyOn(mongoose.models.Message, 'deleteMany');
    const findProjects = jest.spyOn(mongoose.models.Conversation, 'distinct');
    const deleteConversations = jest.spyOn(mongoose.models.Conversation, 'deleteMany');
    const deleteReplies = jest.spyOn(mongoose.models.ChannelReply, 'deleteMany');
    const deleteFeedbackEvents = jest.spyOn(mongoose.models.ChannelFeedbackEvent, 'deleteMany');
    const deleteFeedback = jest.spyOn(mongoose.models.ChannelFeedback, 'deleteMany');
    const methods = createConversationImportMethods(mongoose);
    const conversationIds = Array.from(
      { length: CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE * 2 + 1 },
      (_, index) => `generated-${index}`,
    );
    const scope = { user: 'owner-a', tenantId: 'tenant-a', conversationIds };

    await methods.deleteImportedMessages(scope);
    await methods.deleteImportedConversations(scope);

    const chunks = Array.from({ length: 3 }, (_, index) =>
      conversationIds.slice(
        index * CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE,
        (index + 1) * CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE,
      ),
    );
    for (const [cleanupMock, ownerField, conversationField] of [
      [deleteReplies, 'principalId', 'conversationId'],
      [deleteFeedbackEvents, 'mapping.principalId', 'mapping.conversationId'],
      [deleteFeedback, 'mapping.principalId', 'mapping.conversationId'],
    ] as const) {
      expect(cleanupMock).toHaveBeenCalledTimes(3);
      expect(cleanupMock.mock.calls.map((call) => call[0])).toEqual(
        chunks.map((ids) => ({
          [ownerField]: scope.user,
          tenantId: scope.tenantId,
          [conversationField]: { $in: ids },
        })),
      );
    }
    const expected = chunks.map((ids) => ({
      user: scope.user,
      tenantId: scope.tenantId,
      conversationId: { $in: ids },
    }));
    expect(deleteMessages.mock.calls.map((call) => call[0])).toEqual(expected);
    expect(deleteConversations.mock.calls.map((call) => call[0])).toEqual(expected);
    expect(findProjects.mock.calls.map((call) => call[1])).toEqual(expected);
  });
});
