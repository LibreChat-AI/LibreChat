import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { backgroundResultMetadata, Constants, RetentionMode } from 'librechat-data-provider';
import type { AppConfig, IMessage } from '..';
import {
  createMessageMethods,
  CLIENT_MESSAGE_SELECT,
  SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT,
  SUBAGENT_TRANSCRIPT_PAGE_LIMIT,
  SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT,
} from './message';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createModels } from '../models';
import logger from '~/config/winston';

const waitForTimestampTick = () => new Promise((resolve) => setTimeout(resolve, 2));

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let Message: mongoose.Model<IMessage>;
let saveMessage: ReturnType<typeof createMessageMethods>['saveMessage'];
let getMessages: ReturnType<typeof createMessageMethods>['getMessages'];
let getMessagesForSubagentThreadView: ReturnType<
  typeof createMessageMethods
>['getMessagesForSubagentThreadView'];
let listSubagentTasksForThreads: ReturnType<
  typeof createMessageMethods
>['listSubagentTasksForThreads'];
let updateMessage: ReturnType<typeof createMessageMethods>['updateMessage'];
let updateToolCallResult: ReturnType<typeof createMessageMethods>['updateToolCallResult'];
let deleteMessages: ReturnType<typeof createMessageMethods>['deleteMessages'];
let bulkSaveMessages: ReturnType<typeof createMessageMethods>['bulkSaveMessages'];
let updateMessageText: ReturnType<typeof createMessageMethods>['updateMessageText'];
let deleteMessagesSince: ReturnType<typeof createMessageMethods>['deleteMessagesSince'];
let recordMessage: ReturnType<typeof createMessageMethods>['recordMessage'];
let claimSubagentTaskResult: ReturnType<typeof createMessageMethods>['claimSubagentTaskResult'];
let recordSubagentTaskControlReceipt: ReturnType<
  typeof createMessageMethods
>['recordSubagentTaskControlReceipt'];
let getSubagentTaskControlReceipt: ReturnType<
  typeof createMessageMethods
>['getSubagentTaskControlReceipt'];
let getSubagentTaskControlReplay: ReturnType<
  typeof createMessageMethods
>['getSubagentTaskControlReplay'];
let releaseSubagentTaskResultClaim: ReturnType<
  typeof createMessageMethods
>['releaseSubagentTaskResultClaim'];
let claimBackgroundToolResults: ReturnType<
  typeof createMessageMethods
>['claimBackgroundToolResults'];
let releaseBackgroundToolResultClaims: ReturnType<
  typeof createMessageMethods
>['releaseBackgroundToolResultClaims'];

function rejectUpdateArrays(beforeUpdate?: () => Promise<void>) {
  const originalFindOneAndUpdate = Message.collection.findOneAndUpdate.bind(Message.collection);
  return jest.spyOn(Message.collection, 'findOneAndUpdate').mockImplementation(async (...args) => {
    if (Array.isArray(args[1])) {
      throw new Error('Compatibility guard rejected an update array');
    }
    await beforeUpdate?.();
    return originalFindOneAndUpdate(...args);
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  const models = createModels(mongoose);
  Object.assign(mongoose.models, models);
  Message = mongoose.models.Message;

  const methods = createMessageMethods(mongoose);
  saveMessage = methods.saveMessage;
  getMessages = methods.getMessages;
  getMessagesForSubagentThreadView = methods.getMessagesForSubagentThreadView;
  listSubagentTasksForThreads = methods.listSubagentTasksForThreads;
  updateMessage = methods.updateMessage;
  updateToolCallResult = methods.updateToolCallResult;
  deleteMessages = methods.deleteMessages;
  bulkSaveMessages = methods.bulkSaveMessages;
  updateMessageText = methods.updateMessageText;
  deleteMessagesSince = methods.deleteMessagesSince;
  recordMessage = methods.recordMessage;
  claimSubagentTaskResult = methods.claimSubagentTaskResult;
  recordSubagentTaskControlReceipt = methods.recordSubagentTaskControlReceipt;
  getSubagentTaskControlReceipt = methods.getSubagentTaskControlReceipt;
  getSubagentTaskControlReplay = methods.getSubagentTaskControlReplay;
  releaseSubagentTaskResultClaim = methods.releaseSubagentTaskResultClaim;
  claimBackgroundToolResults = methods.claimBackgroundToolResults;
  releaseBackgroundToolResultClaims = methods.releaseBackgroundToolResultClaims;

  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Message Operations', () => {
  let mockCtx: {
    userId: string;
    isTemporary?: boolean;
    expiredAt?: Date;
    interfaceConfig?: AppConfig['interfaceConfig'];
  };
  let mockMessageData: Partial<IMessage> = {
    messageId: 'msg123',
    conversationId: uuidv4(),
    text: 'Hello, world!',
    user: 'user123',
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Clear database
    await Message.deleteMany({});
    await mongoose.models.Conversation.deleteMany({});

    mockCtx = {
      userId: 'user123',
      interfaceConfig: {
        temporaryChatRetention: 24, // Default 24 hours
      },
    };

    mockMessageData = {
      messageId: 'msg123',
      conversationId: uuidv4(),
      text: 'Hello, world!',
      user: 'user123',
    };
  });

  describe('saveMessage', () => {
    it('should save a message for an authenticated user', async () => {
      const result = await saveMessage(mockCtx, mockMessageData);

      expect(result?.messageId).toBe('msg123');
      expect(result?.user).toBe('user123');
      expect(result?.text).toBe('Hello, world!');

      // Verify the message was actually saved to the database
      const savedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' });
      expect(savedMessage).toBeTruthy();
      expect(savedMessage?.text).toBe('Hello, world!');
      expect(savedMessage?.isUserSubmitted).toBeUndefined();
    });

    it('round-trips context usage metadata without narrowing tool fields or unknown data', async () => {
      const contextUsage = {
        runId: 'run-context-rich',
        breakdown: {
          messageTokens: 120,
          toolMessageTokens: 18,
          toolMessageTokenCounts: { search: 11, read_file: 4 },
          sdkExtension: {
            providerOnly: true,
            nested: { invocationOverhead: 3, labels: ['retained'] },
          },
        },
        sdkExtension: {
          source: 'retained-snapshot-field',
          nested: { calibration: { mode: 'provider' } },
        },
      };
      const knownZero = {
        ...contextUsage,
        breakdown: {
          ...contextUsage.breakdown,
          toolMessageTokens: 0,
          toolMessageTokenCounts: { search: 0 },
        },
      };
      const {
        toolMessageTokens: _missingToolMessageTokens,
        toolMessageTokenCounts: _missingToolMessageTokenCounts,
        ...missingBreakdown
      } = contextUsage.breakdown;
      const missing = { ...contextUsage, breakdown: missingBreakdown };

      await Promise.all([
        saveMessage(mockCtx, {
          ...mockMessageData,
          messageId: 'msg-context-rich',
          metadata: { contextUsage },
        }),
        saveMessage(mockCtx, {
          ...mockMessageData,
          messageId: 'msg-context-zero',
          metadata: { contextUsage: knownZero },
        }),
        saveMessage(mockCtx, {
          ...mockMessageData,
          messageId: 'msg-context-missing',
          metadata: { contextUsage: missing },
        }),
      ]);

      const persisted = await Message.find({
        user: 'user123',
        messageId: { $in: ['msg-context-rich', 'msg-context-zero', 'msg-context-missing'] },
      }).lean();
      const byId = new Map(persisted.map((message) => [message.messageId, message]));

      expect(byId.get('msg-context-rich')?.metadata?.contextUsage).toEqual(contextUsage);
      expect(byId.get('msg-context-zero')?.metadata?.contextUsage).toEqual(knownZero);
      expect(byId.get('msg-context-missing')?.metadata?.contextUsage).toEqual(missing);

      const zeroBreakdown = (
        byId.get('msg-context-zero')?.metadata?.contextUsage as typeof knownZero
      ).breakdown;
      expect(zeroBreakdown.toolMessageTokens).toBe(0);
      expect(Object.prototype.hasOwnProperty.call(zeroBreakdown, 'toolMessageTokens')).toBe(true);

      const missingBreakdownRecord = (
        byId.get('msg-context-missing')?.metadata?.contextUsage as typeof missing
      ).breakdown;
      expect(
        Object.prototype.hasOwnProperty.call(missingBreakdownRecord, 'toolMessageTokens'),
      ).toBe(false);
      expect(missingBreakdownRecord.sdkExtension).toEqual(contextUsage.breakdown.sdkExtension);
      expect(
        (byId.get('msg-context-rich')?.metadata?.contextUsage as typeof contextUsage).sdkExtension
          .nested,
      ).toEqual({ calibration: { mode: 'provider' } });
    });

    it('unsets a previously stored context meta in the same update as the terminal save', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        contextMeta: {
          calibrationRatio: 1.2,
          encoding: 'claude',
          fading: { v: 1, budgetTokens: 50_000, masked: true },
        },
      });
      const partial = await Message.findOne({ messageId: 'msg123', user: 'user123' });
      expect(partial?.contextMeta?.fading?.budgetTokens).toBe(50_000);

      const findOneAndUpdate = jest.spyOn(Message, 'findOneAndUpdate');
      const updateOne = jest.spyOn(Message, 'updateOne');
      try {
        const result = await saveMessage(mockCtx, {
          ...mockMessageData,
          text: 'Completed',
          contextMeta: null,
        });

        expect(result?.contextMeta).toBeUndefined();
        expect(result?.text).toBe('Completed');
        expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(findOneAndUpdate).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ $unset: { contextMeta: 1 } }),
          expect.anything(),
        );
        expect(updateOne).not.toHaveBeenCalled();
      } finally {
        findOneAndUpdate.mockRestore();
        updateOne.mockRestore();
      }
      const completed = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(completed).not.toHaveProperty('contextMeta');
      expect(completed?.text).toBe('Completed');
    });

    it('unsets a stored context meta atomically through the provenance merge as well', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        contextMeta: { calibrationRatio: 1.2, encoding: 'claude' },
      });

      const findOneAndUpdate = jest.spyOn(Message, 'findOneAndUpdate');
      try {
        const result = await saveMessage(mockCtx, {
          ...mockMessageData,
          isCreatedByUser: false,
          isUserSubmitted: true,
          userSubmittedPaths: ['/content/0/text'],
          contextMeta: null,
        });

        expect(result?.contextMeta).toBeUndefined();
        expect(result?.userSubmittedPaths).toEqual(['/content/0/text']);
        expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(findOneAndUpdate).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ $unset: { contextMeta: 1 } }),
          expect.anything(),
        );
      } finally {
        findOneAndUpdate.mockRestore();
      }
      const completed = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(completed).not.toHaveProperty('contextMeta');
      expect(completed?.isUserSubmitted).toBe(true);
    });

    it('should persist optional user-submitted provenance independently of message role', async () => {
      const result = await saveMessage(mockCtx, {
        ...mockMessageData,
        isCreatedByUser: false,
        isUserSubmitted: true,
        userSubmittedPaths: ['/content/0/text'],
      });

      expect(result?.isCreatedByUser).toBe(false);
      expect(result?.isUserSubmitted).toBe(true);
      expect(result?.userSubmittedPaths).toEqual(['/content/0/text']);

      const savedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' });
      expect(savedMessage?.isCreatedByUser).toBe(false);
      expect(savedMessage?.isUserSubmitted).toBe(true);
      expect(savedMessage?.userSubmittedPaths).toEqual(['/content/0/text']);
    });

    it('stamps native model output without overriding explicit provenance', async () => {
      const result = await saveMessage(mockCtx, {
        ...mockMessageData,
        isCreatedByUser: false,
      });

      expect(result?.isUserSubmitted).toBe(false);

      const explicitlySubmitted = await saveMessage(mockCtx, {
        ...mockMessageData,
        messageId: 'msg-explicit-submitted',
        isCreatedByUser: false,
        isUserSubmitted: true,
      });
      expect(explicitlySubmitted?.isUserSubmitted).toBe(true);

      const pathScoped = await saveMessage(mockCtx, {
        ...mockMessageData,
        messageId: 'msg-path-scoped',
        isCreatedByUser: false,
        userSubmittedPaths: ['/content/0/text'],
      });
      expect(pathScoped?.isUserSubmitted).toBe(false);
      expect(pathScoped?.userSubmittedPaths).toEqual(['/content/0/text']);
    });

    it('bounds and validates stored user-submitted provenance paths', async () => {
      const submittedPaths = [
        'not-a-pointer',
        ...Array.from({ length: 300 }, (_, index) => `/content/${index}/text`),
      ];

      const result = await saveMessage(mockCtx, {
        ...mockMessageData,
        isCreatedByUser: false,
        userSubmittedPaths: submittedPaths,
      });

      expect(result?.userSubmittedPaths).toHaveLength(256);
      expect(result?.userSubmittedPaths).not.toContain('not-a-pointer');
      expect(result?.userSubmittedPaths?.[0]).toBe('/content/0/text');
      expect(result?.isUserSubmitted).toBe(true);
    });

    it('validates and atomically preserves exact HITL field provenance', async () => {
      const first = await saveMessage(mockCtx, {
        ...mockMessageData,
        isCreatedByUser: false,
        content: [
          {
            type: 'tool_call',
            tool_call: { id: 'tool-1', output: 'Human response' },
          },
        ],
        userSubmittedMessageFieldPaths: [
          { path: '/content/0/tool_call/output', field: 'answer' },
          { path: '/content/0/tool_call/output', field: 'answer' },
          { path: 'not-a-pointer', field: 'decision_reason' },
        ],
      });

      expect(first?.userSubmittedMessageFieldPaths).toEqual([
        expect.objectContaining({ path: '/content/0/tool_call/output', field: 'answer' }),
      ]);

      await updateMessage(mockCtx.userId, {
        messageId: 'msg123',
        userSubmittedMessageFieldPaths: [
          { path: '/content/0/tool_call/output', field: 'decision_response' },
        ],
      });

      const stored = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(stored?.userSubmittedMessageFieldPaths).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '/content/0/tool_call/output', field: 'answer' }),
          expect.objectContaining({
            path: '/content/0/tool_call/output',
            field: 'decision_response',
          }),
        ]),
      );
      expect(stored?.userSubmittedMessageFieldPaths).toHaveLength(2);
    });

    it('adds semantic steer paths without replacing existing field provenance', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        isCreatedByUser: false,
        userSubmittedPaths: ['/text'],
      });

      const result = await saveMessage(mockCtx, {
        ...mockMessageData,
        isCreatedByUser: false,
        content: [
          { type: 'text', text: 'Model response' },
          { type: 'steer', steer: 'User direction' },
        ],
      });

      expect(result?.userSubmittedPaths).toEqual(expect.arrayContaining(['/text', '/content/1']));
      expect(result?.userSubmittedPaths).toHaveLength(2);
    });

    it('saves provenance when update arrays are rejected at the collection boundary', async () => {
      const findOneAndUpdate = rejectUpdateArrays();

      await saveMessage(mockCtx, {
        ...mockMessageData,
        isCreatedByUser: false,
        userSubmittedPaths: ['/text'],
      });

      expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
      const update = findOneAndUpdate.mock.calls[0][1];
      expect(update).toEqual(expect.objectContaining({ $set: expect.any(Object) }));
    });

    it('merges provenance from concurrent first saves', async () => {
      await Message.syncIndexes();

      await Promise.all([
        saveMessage(mockCtx, {
          ...mockMessageData,
          isCreatedByUser: false,
          text: 'First writer',
          userSubmittedPaths: ['/text'],
        }),
        saveMessage(mockCtx, {
          ...mockMessageData,
          isCreatedByUser: false,
          content: [{ type: 'text', text: 'Second writer' }],
          userSubmittedPaths: ['/content/0/text'],
        }),
      ]);

      const savedMessages = await Message.find({ messageId: 'msg123', user: 'user123' }).lean();
      expect(savedMessages).toHaveLength(1);
      const [savedMessage] = savedMessages;
      expect(savedMessage?.userSubmittedPaths).toEqual(
        expect.arrayContaining(['/text', '/content/0/text']),
      );
      expect(savedMessage?.userSubmittedPaths).toHaveLength(2);
    });

    it('persists dollar-prefixed message values literally while merging provenance', async () => {
      const created = await saveMessage(mockCtx, {
        ...mockMessageData,
        text: '$PATH',
        content: [{ type: 'text', text: '$CONTENT' }],
        userSubmittedPaths: ['/text', '/content/0/text'],
      });

      expect(created?.text).toBe('$PATH');
      expect(created?.content).toEqual([expect.objectContaining({ text: '$CONTENT' })]);

      const updated = await updateMessage(mockCtx.userId, {
        messageId: 'msg123',
        text: '$UPDATED_PATH',
        content: [{ type: 'text', text: '$UPDATED_CONTENT' }],
        userSubmittedPaths: ['/text', '/content/0/text'],
      });

      expect(updated?.text).toBe('$UPDATED_PATH');
      expect(
        await Message.findOne({ messageId: 'msg123', user: 'user123' })
          .lean()
          .then((message) => message?.content),
      ).toEqual([expect.objectContaining({ text: '$UPDATED_CONTENT' })]);
    });

    it('should throw an error for unauthenticated user', async () => {
      mockCtx.userId = null as unknown as string;
      await expect(saveMessage(mockCtx, mockMessageData)).rejects.toThrow('User not authenticated');
    });

    it('should handle invalid conversation ID gracefully', async () => {
      mockMessageData.conversationId = 'invalid-id';
      const result = await saveMessage(mockCtx, mockMessageData);
      expect(result).toBeUndefined();
    });

    it('should not log message params for invalid conversation IDs', async () => {
      mockMessageData.conversationId = 'invalid-id';
      mockMessageData.text = 'Sensitive prompt text';

      await saveMessage(mockCtx, mockMessageData, { context: 'message-save-test' });

      expect(logger.warn).toHaveBeenCalledWith(
        'Invalid conversation ID: invalid-id (context: message-save-test)',
      );
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe('bulkSaveMessages', () => {
    it('preserves unknown provenance when cloning an unmarked assistant row', async () => {
      const conversationId = uuidv4();
      await bulkSaveMessages([
        {
          user: 'user123',
          messageId: 'bulk-unmarked-assistant',
          conversationId,
          isCreatedByUser: false,
        },
        {
          user: 'user123',
          messageId: 'bulk-user-submitted',
          conversationId,
          isCreatedByUser: false,
          isUserSubmitted: true,
        },
      ]);

      const rows = await Message.find({ conversationId }).lean();
      expect(
        rows.find(({ messageId }) => messageId === 'bulk-unmarked-assistant'),
      ).not.toHaveProperty('isUserSubmitted');
      expect(
        rows.find(({ messageId }) => messageId === 'bulk-user-submitted')?.isUserSubmitted,
      ).toBe(true);
    });

    it('caps exact field provenance without promoting model output to whole-message provenance', async () => {
      const conversationId = uuidv4();
      await bulkSaveMessages([
        {
          user: 'user123',
          messageId: 'bulk-exact-overflow',
          conversationId,
          isCreatedByUser: false,
          userSubmittedMessageFieldPaths: Array.from({ length: 300 }, (_, index) => ({
            path: `/decision/${index}`,
            field: 'decision_response' as const,
          })),
        },
      ]);

      const row = await Message.findOne({ messageId: 'bulk-exact-overflow' }).lean();
      expect(row?.userSubmittedMessageFieldPaths).toHaveLength(257);
      expect(row).not.toHaveProperty('isUserSubmitted');
    });
  });

  describe('recordMessage', () => {
    it('stamps native model output without overriding explicit provenance', async () => {
      const conversationId = uuidv4();
      const modelOutput = await recordMessage({
        user: 'user123',
        messageId: 'record-model-output',
        conversationId,
        isCreatedByUser: false,
      });
      expect(modelOutput?.isUserSubmitted).toBe(false);

      const explicitlySubmitted = await recordMessage({
        user: 'user123',
        messageId: 'record-user-submitted',
        conversationId,
        isCreatedByUser: false,
        isUserSubmitted: true,
      });
      expect(explicitlySubmitted?.isUserSubmitted).toBe(true);
    });
  });

  it('preserves unknown provenance when message savers update legacy assistant rows', async () => {
    const conversationId = uuidv4();
    const messageIds = ['legacy-save', 'legacy-bulk', 'legacy-record'];
    await Message.collection.insertMany(
      messageIds.map((messageId) => ({
        user: 'user123',
        messageId,
        conversationId,
        isCreatedByUser: false,
        text: 'Legacy assistant output',
      })),
    );

    await saveMessage(mockCtx, {
      messageId: 'legacy-save',
      conversationId,
      isCreatedByUser: false,
      text: 'Updated assistant output',
    });
    await bulkSaveMessages([
      {
        user: 'user123',
        messageId: 'legacy-bulk',
        conversationId,
        isCreatedByUser: false,
        text: 'Updated assistant output',
      },
    ]);
    await recordMessage({
      user: 'user123',
      messageId: 'legacy-record',
      conversationId,
      isCreatedByUser: false,
      text: 'Updated assistant output',
    });

    const rows = await Message.find({ messageId: { $in: messageIds } }).lean();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).not.toHaveProperty('isUserSubmitted');
    }
  });

  describe('updateMessageText', () => {
    it('should update message text for the authenticated user', async () => {
      // First save a message
      await saveMessage(mockCtx, mockMessageData);

      // Then update it
      await updateMessageText(mockCtx.userId, { messageId: 'msg123', text: 'Updated text' });

      // Verify the update
      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' });
      expect(updatedMessage?.text).toBe('Updated text');
    });
  });

  describe('updateMessage', () => {
    it('should update a message for the authenticated user', async () => {
      // First save a message
      await saveMessage(mockCtx, mockMessageData);

      const result = await updateMessage(mockCtx.userId, {
        messageId: 'msg123',
        text: 'Updated text',
      });

      expect(result?.messageId).toBe('msg123');
      expect(result?.text).toBe('Updated text');

      // Verify in database
      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' });
      expect(updatedMessage?.text).toBe('Updated text');
    });

    it('atomically merges provenance from concurrent edits to distinct fields', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        isCreatedByUser: false,
        content: [{ type: 'text', text: 'Model content' }],
      });

      await Promise.all([
        updateMessage(mockCtx.userId, {
          messageId: 'msg123',
          text: 'Human-edited text',
          userSubmittedPaths: ['/text'],
        }),
        updateMessage(mockCtx.userId, {
          messageId: 'msg123',
          content: [{ type: 'text', text: 'Human-edited content' }],
          userSubmittedPaths: ['/content/0/text'],
        }),
      ]);

      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(updatedMessage?.text).toBe('Human-edited text');
      expect(updatedMessage?.content).toEqual([
        expect.objectContaining({ type: 'text', text: 'Human-edited content' }),
      ]);
      expect(updatedMessage?.userSubmittedPaths).toEqual(
        expect.arrayContaining(['/text', '/content/0/text']),
      );
      expect(updatedMessage?.userSubmittedPaths).toHaveLength(2);
    });

    it('retries a stale provenance snapshot without dropping either writer', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        isCreatedByUser: false,
        content: [{ type: 'text', text: 'Model content' }],
      });

      let injectedConcurrentWrite = false;
      const findOneAndUpdate = rejectUpdateArrays(async () => {
        if (injectedConcurrentWrite) {
          return;
        }
        injectedConcurrentWrite = true;
        await Message.collection.updateOne(
          { messageId: 'msg123', user: 'user123' },
          { $set: { userSubmittedPaths: ['/content/0/text'] } },
        );
      });

      await updateMessage(mockCtx.userId, {
        messageId: 'msg123',
        text: 'Human-edited text',
        userSubmittedPaths: ['/text'],
      });

      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
      expect(updatedMessage?.userSubmittedPaths).toEqual(
        expect.arrayContaining(['/content/0/text', '/text']),
      );
      expect(updatedMessage?.userSubmittedPaths).toHaveLength(2);
      for (const [, update] of findOneAndUpdate.mock.calls) {
        expect(update).toEqual(expect.objectContaining({ $set: expect.any(Object) }));
      }
    });

    it('atomically caps repeated provenance unions and promotes overflow to whole-message provenance', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        isCreatedByUser: false,
        content: [{ type: 'text', text: 'Model content' }],
      });

      await Promise.all([
        updateMessage(mockCtx.userId, {
          messageId: 'msg123',
          userSubmittedPaths: Array.from({ length: 200 }, (_, index) => `/path/${index}`),
          userSubmittedMessageFieldPaths: Array.from({ length: 200 }, (_, index) => ({
            path: `/decision/${index}`,
            field: 'decision_response' as const,
          })),
        }),
        updateMessage(mockCtx.userId, {
          messageId: 'msg123',
          userSubmittedPaths: Array.from({ length: 200 }, (_, index) => `/path/${index + 200}`),
          userSubmittedMessageFieldPaths: Array.from({ length: 200 }, (_, index) => ({
            path: `/decision/${index + 200}`,
            field: 'decision_response' as const,
          })),
        }),
      ]);

      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(updatedMessage?.userSubmittedPaths).toHaveLength(256);
      expect(updatedMessage?.userSubmittedMessageFieldPaths).toHaveLength(257);
      expect(updatedMessage?.isUserSubmitted).toBe(true);
    });

    it('keeps repeated exact-field overflow scoped instead of promoting the whole message', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        isCreatedByUser: false,
        content: [{ type: 'text', text: 'Model content' }],
      });

      await updateMessage(mockCtx.userId, {
        messageId: 'msg123',
        userSubmittedMessageFieldPaths: Array.from({ length: 200 }, (_, index) => ({
          path: `/decision/${index}`,
          field: 'decision_response' as const,
        })),
      });
      await updateMessage(mockCtx.userId, {
        messageId: 'msg123',
        userSubmittedMessageFieldPaths: Array.from({ length: 200 }, (_, index) => ({
          path: `/decision/${index + 200}`,
          field: 'decision_response' as const,
        })),
      });

      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(updatedMessage?.userSubmittedPaths).toHaveLength(0);
      expect(updatedMessage?.userSubmittedMessageFieldPaths).toHaveLength(257);
      expect(updatedMessage?.isUserSubmitted).toBe(false);
    });

    it('returns the generation-time Langfuse routing decisions with feedback updates', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        langfuseSampled: true,
        langfuseDestinationIds: ['destination-1'],
        langfuseRunId: 'run-1',
      });

      const result = await updateMessage(mockCtx.userId, {
        messageId: 'msg123',
        feedback: { rating: 'thumbsUp', tag: undefined },
      });

      expect(result?.langfuseSampled).toBe(true);
      expect(result?.langfuseDestinationIds).toEqual(['destination-1']);
      expect(result?.langfuseRunId).toBe('run-1');
    });

    it('should throw an error if message is not found', async () => {
      await expect(
        updateMessage(mockCtx.userId, { messageId: 'nonexistent', text: 'Test' }),
      ).rejects.toThrow('Message not found or user not authorized.');
    });
  });

  describe('updateToolCallResult', () => {
    const toolCallContent = () => [
      { type: 'text', text: 'intro' },
      {
        type: 'tool_call',
        tool_call: {
          id: 'call_bg',
          name: 'execute_code',
          args: '{"lang":"py","code":"print(1)"}',
          output: '{"background_task_id":"task-1"}',
          progress: 1,
        },
      },
      {
        type: 'tool_call',
        tool_call: { id: 'call_other', name: 'execute_code', args: '{}', output: 'untouched' },
      },
    ];

    it('patches only the matching tool_call part and appends attachments atomically', async () => {
      await saveMessage(mockCtx, { ...mockMessageData, content: toolCallContent() });

      const result = await updateToolCallResult({
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_bg',
        output: 'stdout:\nhello',
        attachments: [{ file_id: 'f1', toolCallId: 'call_bg' }],
      });
      expect(result).toEqual({ matched: true, unfinished: false });

      const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      const content = saved?.content as Array<{
        type: string;
        tool_call?: { id: string; output?: string };
      }>;
      expect(content[1].tool_call?.output).toBe('stdout:\nhello');
      expect(content[2].tool_call?.output).toBe('untouched');
      expect(saved?.attachments).toEqual([{ file_id: 'f1', toolCallId: 'call_bg' }]);
    });

    describe('a step id the persisted part lost', () => {
      const conversationId = () => mockMessageData.conversationId as string;
      const partOutputs = async () => {
        const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
        return (
          saved?.content as Array<{ tool_call?: { id: string; stepId?: string; output?: string } }>
        )
          .filter((part) => part.tool_call != null)
          .map((part) => [
            part.tool_call?.id,
            part.tool_call?.stepId ?? null,
            part.tool_call?.output,
          ]);
      };

      it('patches the one part a resumed turn saved without its step id', async () => {
        await saveMessage(mockCtx, { ...mockMessageData, content: toolCallContent() });

        const result = await updateToolCallResult({
          userId: 'user123',
          messageId: 'msg123',
          conversationId: conversationId(),
          toolCallId: 'call_bg',
          stepId: 'step_before_pause',
          output: 'stdout:\nfinished during the pause',
          attachments: [{ file_id: 'report', toolCallId: 'call_bg' }],
        });

        expect(result).toEqual({ matched: true, unfinished: false });
        expect(await partOutputs()).toEqual([
          ['call_bg', null, 'stdout:\nfinished during the pause'],
          ['call_other', null, 'untouched'],
        ]);
        const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
        expect(saved?.attachments).toEqual([{ file_id: 'report', toolCallId: 'call_bg' }]);
      });

      it('still prefers the part whose step id matches exactly', async () => {
        await saveMessage(mockCtx, {
          ...mockMessageData,
          content: [
            {
              type: 'tool_call',
              tool_call: { id: 'call_0', name: 'execute_code', output: 'stepless' },
            },
            {
              type: 'tool_call',
              tool_call: { id: 'call_0', name: 'execute_code', stepId: 'step_b', output: 'handle' },
            },
          ],
        });

        await updateToolCallResult({
          userId: 'user123',
          messageId: 'msg123',
          conversationId: conversationId(),
          toolCallId: 'call_0',
          stepId: 'step_b',
          output: 'settled',
        });

        expect(await partOutputs()).toEqual([
          ['call_0', null, 'stepless'],
          ['call_0', 'step_b', 'settled'],
        ]);
      });

      it.each([
        { file_id: 'shared-file' },
        { filepath: '/api/files/code/download/session/shared-file' },
      ])('preserves sibling step attachments when merging %j', async (fileKey) => {
        const siblingAttachment = {
          ...fileKey,
          toolCallId: 'call_bg',
          agentId: 'agent-a',
          stepId: 'step_b',
        };
        const attachment = { ...siblingAttachment, stepId: 'step_a' };
        await saveMessage(mockCtx, {
          ...mockMessageData,
          content: [
            ...toolCallContent(),
            {
              type: 'tool_call',
              agentId: 'agent-a',
              tool_call: { id: 'call_bg', stepId: 'step_b', output: 'sibling' },
            },
          ],
          attachments: [siblingAttachment],
        });
        const patch = {
          userId: 'user123',
          messageId: 'msg123',
          conversationId: conversationId(),
          toolCallId: 'call_bg',
          agentId: 'agent-a',
          stepId: 'step_a',
          output: 'settled',
          attachments: [attachment],
        };

        expect(await updateToolCallResult(patch)).toEqual({ matched: true, unfinished: false });
        expect(await updateToolCallResult(patch)).toEqual({ matched: true, unfinished: false });

        const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
        expect(saved?.attachments).toEqual([siblingAttachment, attachment]);
        expect((await partOutputs())[2]).toEqual(['call_bg', 'step_b', 'sibling']);
      });

      it('retries the exact part after attachment contention without patching its stepless sibling', async () => {
        const stepless = {
          type: 'tool_call',
          agentId: 'agent-a',
          tool_call: { id: 'call_bg', output: 'stepless' },
        };
        await saveMessage(mockCtx, {
          ...mockMessageData,
          content: [
            stepless,
            {
              type: 'tool_call',
              agentId: 'agent-a',
              tool_call: { id: 'call_bg', stepId: 'step_b', output: 'handle' },
            },
          ],
          attachments: [],
        });
        const patch = {
          userId: 'user123',
          messageId: 'msg123',
          conversationId: conversationId(),
          toolCallId: 'call_bg',
          stepId: 'step_b',
          agentId: 'agent-a',
          output: 'settled',
          attachments: [{ file_id: 'result', toolCallId: 'call_bg', stepId: 'step_b' }],
          backgroundTask: {
            taskId: 'task-b',
            toolName: 'execute_code',
            status: 'completed' as const,
            settledAt: new Date(),
            resultClaim: {
              kind: 'manual' as const,
              claimId: 'poll-b',
              claimedAt: new Date(),
            },
          },
        };
        const original = Message.collection.findOneAndUpdate.bind(Message.collection);
        let collisions = 0;
        const spy = jest
          .spyOn(Message.collection, 'findOneAndUpdate')
          .mockImplementation(async (...args) => {
            if (Object.prototype.hasOwnProperty.call(args[0], 'attachments') && collisions < 8) {
              collisions += 1;
              await Message.updateOne(
                { messageId: 'msg123', user: 'user123' },
                { $push: { attachments: { file_id: `concurrent-${collisions}` } } },
              );
            }
            return original(...args);
          });
        try {
          expect(await updateToolCallResult(patch)).toEqual({ matched: false, unfinished: false });
          expect(collisions).toBe(8);
          const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
          expect(saved?.content?.[0]).toEqual(stepless);
          expect(saved?.attachments).toHaveLength(8);
        } finally {
          spy.mockRestore();
        }

        expect(await updateToolCallResult(patch)).toEqual({ matched: true, unfinished: false });
        const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
        expect(saved?.content?.[0]).toEqual(stepless);
        expect(saved?.content?.[1]).toMatchObject({
          tool_call: { output: 'settled', backgroundTask: patch.backgroundTask },
        });
        expect(saved?.attachments).toHaveLength(9);
      });

      describe.each([false, true])('fallback with attachments: %s', (withAttachments) => {
        it.each(['exact', 'ambiguous', 'unfinished', 'claimed'])(
          'leaves a concurrent %s change intact and retryable',
          async (change) => {
            await saveMessage(mockCtx, { ...mockMessageData, content: toolCallContent() });
            const claim = { kind: 'manual', claimId: 'concurrent-poll', claimedAt: new Date() };
            const original = Message.collection.findOneAndUpdate.bind(Message.collection);
            let raced = false;
            let concurrentContent: IMessage['content'];
            const spy = jest
              .spyOn(Message.collection, 'findOneAndUpdate')
              .mockImplementation(async (...args) => {
                if (
                  !raced &&
                  (Array.isArray(args[0].content) ||
                    args[0].content?.$elemMatch?.['tool_call.stepId'] === null)
                ) {
                  raced = true;
                  const filter = { messageId: 'msg123', user: 'user123' };
                  if (change === 'unfinished') {
                    await Message.updateOne(filter, { $set: { unfinished: true } });
                  } else if (change === 'claimed') {
                    await Message.updateOne(filter, {
                      $set: { 'content.1.tool_call.backgroundTask.resultClaim': claim },
                    });
                  } else {
                    await Message.updateOne(filter, {
                      $push: {
                        content: {
                          type: 'tool_call',
                          tool_call: {
                            id: 'call_bg',
                            output: 'concurrent',
                            ...(change === 'exact' ? { stepId: 'step_a' } : {}),
                          },
                        },
                      },
                    });
                  }
                  concurrentContent = (
                    await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean()
                  )?.content;
                }
                return original(...args);
              });
            try {
              const result = await updateToolCallResult({
                userId: 'user123',
                messageId: 'msg123',
                conversationId: conversationId(),
                toolCallId: 'call_bg',
                stepId: 'step_a',
                output: 'settled',
                ...(withAttachments
                  ? { attachments: [{ file_id: 'result', toolCallId: 'call_bg' }] }
                  : {}),
                backgroundTask: {
                  taskId: 'task-a',
                  toolName: 'execute_code',
                  status: 'completed',
                  settledAt: new Date(),
                  resultClaim: { kind: 'wakeup', claimId: 'wakeup-a', claimedAt: new Date() },
                },
              });
              expect(raced).toBe(true);
              expect(result).toEqual({ matched: false, unfinished: false });
              const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
              expect(saved?.content).toEqual(concurrentContent);
              expect(saved?.attachments ?? []).toEqual([]);
            } finally {
              spy.mockRestore();
            }
          },
        );
      });

      it.each([undefined, null, { kind: 'manual', claimId: 'existing', claimedAt: new Date() }])(
        'atomically settles a fallback while preserving claim ownership: %j',
        async (resultClaim) => {
          await saveMessage(mockCtx, {
            ...mockMessageData,
            content: [
              {
                type: 'tool_call',
                tool_call: {
                  id: 'call_bg',
                  stepId: null,
                  output: 'handle',
                  backgroundTask: { resultClaim },
                },
              },
            ],
          });
          const backgroundTask = {
            taskId: 'task-a',
            toolName: 'execute_code',
            status: 'completed' as const,
            settledAt: new Date(),
            resultClaim: { kind: 'wakeup' as const, claimId: 'new', claimedAt: new Date() },
          };
          expect(
            await updateToolCallResult({
              userId: 'user123',
              messageId: 'msg123',
              conversationId: conversationId(),
              toolCallId: 'call_bg',
              stepId: 'step_a',
              output: 'settled',
              backgroundTask,
            }),
          ).toEqual({ matched: true, unfinished: false });
          const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
          expect(saved?.content?.[0]).toMatchObject({
            tool_call: {
              stepId: null,
              output: 'settled',
              backgroundTask: {
                ...backgroundTask,
                resultClaim: resultClaim ?? backgroundTask.resultClaim,
              },
            },
          });
        },
      );

      it.each([
        { partAgent: 'agent-a', callAgent: 'agent-b', matched: true },
        { partAgent: 'agent-b', callAgent: 'agent-a', matched: false },
        { partAgent: null, callAgent: 'agent-a', matched: true },
        { partAgent: null, callAgent: 'agent-b', matched: false },
        { partAgent: null, callAgent: null, matched: true },
      ])(
        'keeps agent ownership when falling back: %j',
        async ({ partAgent, callAgent, matched }) => {
          await saveMessage(mockCtx, {
            ...mockMessageData,
            content: [
              {
                type: 'tool_call',
                agentId: partAgent,
                tool_call: { id: 'call_bg', agentId: callAgent, stepId: null, output: 'handle' },
              },
              {
                type: 'tool_call',
                agentId: 'agent-b',
                tool_call: { id: 'call_bg', stepId: 'step_a', output: 'sibling' },
              },
            ],
          });
          expect(
            await updateToolCallResult({
              userId: 'user123',
              messageId: 'msg123',
              conversationId: conversationId(),
              toolCallId: 'call_bg',
              agentId: 'agent-a',
              stepId: 'step_a',
              output: 'settled',
            }),
          ).toEqual({ matched, unfinished: false });
          expect(await partOutputs()).toEqual([
            ['call_bg', null, matched ? 'settled' : 'handle'],
            ['call_bg', 'step_a', 'sibling'],
          ]);
        },
      );

      it('does not guess on a row the turn is still writing', async () => {
        await saveMessage(mockCtx, {
          ...mockMessageData,
          unfinished: true,
          content: toolCallContent(),
        });

        const result = await updateToolCallResult({
          userId: 'user123',
          messageId: 'msg123',
          conversationId: conversationId(),
          toolCallId: 'call_bg',
          stepId: 'step_not_saved_yet',
          output: 'settled',
        });

        expect(result).toEqual({ matched: false, unfinished: false });
        expect((await partOutputs())[0]).toEqual([
          'call_bg',
          null,
          '{"background_task_id":"task-1"}',
        ]);
      });

      it('leaves an ambiguous repeated call id unmatched rather than guessing', async () => {
        await saveMessage(mockCtx, {
          ...mockMessageData,
          content: [
            {
              type: 'tool_call',
              tool_call: { id: 'call_0', name: 'execute_code', output: 'first' },
            },
            {
              type: 'tool_call',
              tool_call: { id: 'call_0', name: 'execute_code', output: 'second' },
            },
          ],
        });

        const result = await updateToolCallResult({
          userId: 'user123',
          messageId: 'msg123',
          conversationId: conversationId(),
          toolCallId: 'call_0',
          stepId: 'step_lost',
          output: 'settled',
        });

        expect(result).toEqual({ matched: false, unfinished: false });
        expect(await partOutputs()).toEqual([
          ['call_0', null, 'first'],
          ['call_0', null, 'second'],
        ]);
      });
    });

    it('appends to existing attachments instead of replacing them', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: toolCallContent(),
        attachments: [{ file_id: 'existing' }] as unknown as IMessage['attachments'],
      });

      await updateToolCallResult({
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_bg',
        attachments: [{ file_id: 'f2' }],
      });

      const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(saved?.attachments).toEqual([{ file_id: 'existing' }, { file_id: 'f2' }]);
    });

    it('is idempotent: re-applying the same patch does not duplicate attachments', async () => {
      await saveMessage(mockCtx, { ...mockMessageData, content: toolCallContent() });

      const patch = {
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_bg',
        output: 'stdout:\nhello',
        attachments: [{ file_id: 'f1', toolCallId: 'call_bg' }],
      };
      await updateToolCallResult(patch);
      await updateToolCallResult(patch);

      const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(saved?.attachments).toEqual([{ file_id: 'f1', toolCallId: 'call_bg' }]);
      const content = saved?.content as Array<{ tool_call?: { output?: string } }>;
      expect(content[1].tool_call?.output).toBe('stdout:\nhello');
    });

    it('dedupes download-fallback attachments (no file_id) by filepath on re-apply', async () => {
      await saveMessage(mockCtx, { ...mockMessageData, content: toolCallContent() });

      const patch = {
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_bg',
        attachments: [
          {
            filepath: '/api/files/code/download/sess-1/f1',
            filename: 'big.zip',
            toolCallId: 'call_bg',
          },
          { file_id: 'f2', toolCallId: 'call_bg' },
        ],
      };
      await updateToolCallResult(patch);
      await updateToolCallResult(patch);

      const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(saved?.attachments).toEqual([
        {
          filepath: '/api/files/code/download/sess-1/f1',
          filename: 'big.zip',
          toolCallId: 'call_bg',
        },
        { file_id: 'f2', toolCallId: 'call_bg' },
      ]);
    });

    it('returns false when the message row does not exist yet (caller retries)', async () => {
      const result = await updateToolCallResult({
        userId: 'user123',
        messageId: 'missing-msg',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_bg',
        output: 'stdout',
      });
      expect(result.matched).toBe(false);
    });

    it('scopes the patch by agentId when provider ids repeat across agents', async () => {
      /* Handoff runs append multiple agents' parts to ONE response message,
       * and provider ids like call_0 repeat per model response. */
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: [
          {
            type: 'tool_call',
            agentId: 'agent_a',
            tool_call: { id: 'call_0', name: 'execute_code', output: 'handle-a' },
          },
          {
            type: 'tool_call',
            agentId: 'agent_b',
            tool_call: { id: 'call_0', name: 'execute_code', output: 'handle-b' },
          },
        ],
      });

      const result = await updateToolCallResult({
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_0',
        agentId: 'agent_b',
        output: 'stdout-b',
      });
      expect(result.matched).toBe(true);

      const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      const content = saved?.content as Array<{ tool_call?: { output?: string } }>;
      expect(content[0].tool_call?.output).toBe('handle-a');
      expect(content[1].tool_call?.output).toBe('stdout-b');
    });

    it('patches only the matching run step when one agent repeats a provider id', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: [
          {
            type: 'tool_call',
            agentId: 'agent_a',
            tool_call: { id: 'call_0', stepId: 'step-1', name: 'slow_tool', output: 'handle-1' },
          },
          {
            type: 'tool_call',
            agentId: 'agent_a',
            tool_call: { id: 'call_0', stepId: 'step-2', name: 'slow_tool', output: 'handle-2' },
          },
        ],
      });

      const result = await updateToolCallResult({
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_0',
        stepId: 'step-2',
        agentId: 'agent_a',
        output: 'terminal-2',
        backgroundTask: {
          taskId: 'task-2',
          toolName: 'slow_tool',
          status: 'completed',
          settledAt: new Date(),
        },
      });
      expect(result).toEqual({ matched: true, unfinished: false });

      const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      const content = saved?.content as Array<{
        tool_call?: { output?: string; backgroundTask?: { taskId?: string } };
      }>;
      expect(content[0].tool_call).toMatchObject({ output: 'handle-1' });
      expect(content[0].tool_call?.backgroundTask).toBeUndefined();
      expect(content[1].tool_call).toMatchObject({
        output: 'terminal-2',
        backgroundTask: { taskId: 'task-2' },
      });
    });

    it('reports no match when the targeted tool-call part is absent', async () => {
      /** The call was saved under a different, stamped step: a real mismatch, not
       * a part that lost its step id. */
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: toolCallContent().map((part) =>
          part.tool_call?.id === 'call_bg'
            ? { ...part, tool_call: { ...part.tool_call, stepId: 'other-step' } }
            : part,
        ),
      });

      await expect(
        updateToolCallResult({
          userId: 'user123',
          messageId: 'msg123',
          conversationId: mockMessageData.conversationId as string,
          toolCallId: 'call_bg',
          stepId: 'missing-step',
          output: 'must not persist',
        }),
      ).resolves.toEqual({ matched: false, unfinished: false });
    });

    it('flags unfinished partial rows so callers keep re-applying until finalize', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: toolCallContent(),
        unfinished: true,
      } as Parameters<typeof saveMessage>[1]);

      const result = await updateToolCallResult({
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_bg',
        output: 'stdout:\nhello',
      });
      /** The patch still lands (idempotent), but the finalize save will
       *  overwrite this partial row with in-memory content. */
      expect(result).toEqual({ matched: true, unfinished: true });
    });

    it('persists a terminal background receipt without replacing its existing claim', async () => {
      const content = toolCallContent();
      (content[1].tool_call as Record<string, unknown>).backgroundTask = {
        version: 1,
        taskId: 'task-1',
        toolName: 'execute_code',
        status: 'completed',
        settledAt: new Date('2026-08-30T12:00:00Z'),
        resultClaim: {
          kind: 'manual',
          claimId: 'manual-1',
          claimedAt: new Date('2026-08-30T12:00:01Z'),
        },
      };
      await saveMessage(mockCtx, { ...mockMessageData, content });

      await updateToolCallResult({
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_bg',
        output: 'terminal output',
        backgroundTask: {
          taskId: 'task-1',
          toolName: 'execute_code',
          status: 'completed',
          settledAt: new Date('2026-08-30T12:00:02Z'),
          resultClaim: {
            kind: 'wakeup',
            claimId: 'wakeup-1',
            claimedAt: new Date('2026-08-30T12:00:02Z'),
          },
        },
      });

      const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      const task = (
        saved?.content?.[1] as {
          tool_call?: { backgroundTask?: Record<string, unknown> };
        }
      ).tool_call?.backgroundTask;
      expect(task).toMatchObject({
        version: 1,
        taskId: 'task-1',
        status: 'completed',
        resultClaim: { kind: 'manual', claimId: 'manual-1' },
      });
    });

    it('stamps a supplied claim only on a part that carries none', async () => {
      await saveMessage(mockCtx, { ...mockMessageData, content: toolCallContent() });

      await updateToolCallResult({
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_bg',
        backgroundTask: {
          taskId: 'task-1',
          toolName: 'execute_code',
          status: 'completed',
          settledAt: new Date('2026-08-30T12:00:02Z'),
          resultClaim: {
            kind: 'wakeup',
            claimId: 'wakeup-1',
            claimedAt: new Date('2026-08-30T12:00:02Z'),
          },
        },
      });

      const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      const task = (
        saved?.content?.[1] as {
          tool_call?: { backgroundTask?: Record<string, unknown> };
        }
      ).tool_call?.backgroundTask;
      expect(task).toMatchObject({
        taskId: 'task-1',
        resultClaim: { kind: 'wakeup', claimId: 'wakeup-1' },
      });
    });

    it('reports exhausted attachment-merge contention as unmatched instead of throwing', async () => {
      await saveMessage(mockCtx, { ...mockMessageData, content: toolCallContent() });
      const Message = mongoose.models.Message;
      const casSpy = jest.spyOn(Message.collection, 'findOneAndUpdate').mockResolvedValue(null);
      try {
        /** A throw here escapes the settle retry loop and lands on ambiguous
         * failure handling that can retire the completion; contention must
         * surface as a retryable unmatched result. */
        await expect(
          updateToolCallResult({
            userId: 'user123',
            messageId: 'msg123',
            conversationId: mockMessageData.conversationId as string,
            toolCallId: 'call_bg',
            output: 'settled output',
            attachments: [{ file_id: 'file-contended', toolCallId: 'call_bg' }],
          }),
        ).resolves.toEqual({ matched: false, unfinished: false });
        expect(casSpy.mock.calls.length).toBeGreaterThanOrEqual(8);
      } finally {
        casSpy.mockRestore();
      }
    });

    it('disarms a previously armed completion wakeup when the new receipt omits it', async () => {
      const content = toolCallContent();
      (content[1].tool_call as Record<string, unknown>).backgroundTask = {
        version: 1,
        taskId: 'task-1',
        toolName: 'execute_code',
        status: 'completed',
        settledAt: new Date('2026-08-30T12:00:00Z'),
        completionWakeup: true,
      };
      await saveMessage(mockCtx, { ...mockMessageData, content });

      await updateToolCallResult({
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_bg',
        backgroundTask: {
          taskId: 'task-1',
          toolName: 'execute_code',
          status: 'error',
          settledAt: new Date('2026-08-30T12:00:02Z'),
        },
      });

      const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      const task = (
        saved?.content?.[1] as {
          tool_call?: { backgroundTask?: Record<string, unknown> };
        }
      ).tool_call?.backgroundTask;
      expect(task).toMatchObject({ taskId: 'task-1', status: 'error' });
      expect(task).not.toHaveProperty('completionWakeup');
    });

    it('lets a same-generation manual poll claim an anchored terminal receipt', async () => {
      const settledAt = new Date('2026-09-22T09:00:00.000Z');
      await saveMessage(mockCtx, {
        ...mockMessageData,
        unfinished: true,
        content: [
          {
            type: 'tool_call',
            agentId: 'agent-a',
            tool_call: {
              id: 'call-same-generation',
              name: 'slow_tool',
              output: 'settled output',
              backgroundTask: {
                version: 1,
                taskId: 'task-same-generation',
                toolName: 'slow_tool',
                status: 'completed',
                settledAt,
                completionWakeup: true,
              },
            },
          },
        ],
      });

      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-same-generation',
          kind: 'wakeup',
          claimId: 'automatic-delivery',
        }),
      ).resolves.toEqual({ status: 'not_ready' });
      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-same-generation',
          kind: 'manual',
          claimId: 'manual-poll',
        }),
      ).resolves.toEqual({ status: 'not_ready' });
      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-same-generation',
          kind: 'manual',
          claimId: 'manual-poll',
          allowUnfinished: true,
        }),
      ).resolves.toEqual({
        status: 'acquired',
        results: [
          {
            taskId: 'task-same-generation',
            toolCallId: 'call-same-generation',
            toolName: 'slow_tool',
            status: 'completed',
            output: 'settled output',
            agentId: 'agent-a',
            /** Carried through so a poll can report when the task settled. */
            settledAt,
          },
        ],
      });
    });

    it('restores same-generation claim ownership after the final response save', async () => {
      const terminalContent = [
        {
          type: 'tool_call',
          tool_call: {
            id: 'call-finalize-race',
            name: 'mutating_tool',
            output: 'mutation completed',
            backgroundTask: {
              version: 1,
              taskId: 'task-finalize-race',
              toolName: 'mutating_tool',
              status: 'completed',
              settledAt: new Date(),
              completionWakeup: true,
            },
          },
        },
      ];
      await saveMessage(mockCtx, {
        ...mockMessageData,
        unfinished: true,
        content: terminalContent,
      });
      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-finalize-race',
          kind: 'manual',
          claimId: 'manual-owner',
          generationId: 'response-finalize-owner',
          allowUnfinished: true,
        }),
      ).resolves.toMatchObject({ status: 'acquired' });

      /** The final in-memory response did not observe the concurrent claim and
       * rewrites the content part without it. The detached persistence retry
       * must restore the mirrored owner before the receipt can be replayed. */
      await saveMessage(mockCtx, {
        ...mockMessageData,
        unfinished: false,
        content: terminalContent,
      });
      await updateToolCallResult({
        userId: 'user123',
        conversationId: mockMessageData.conversationId as string,
        messageId: 'msg123',
        toolCallId: 'call-finalize-race',
        output: 'mutation completed',
        backgroundTask: {
          taskId: 'task-finalize-race',
          toolName: 'mutating_tool',
          status: 'completed',
          settledAt: new Date(),
          completionWakeup: true,
          resultClaim: {
            kind: 'manual',
            claimId: 'manual-owner',
            claimedAt: new Date(),
            generationId: 'response-finalize-owner',
          },
        },
      });

      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-finalize-race',
          kind: 'manual',
          claimId: 'competing-owner',
        }),
      ).resolves.toEqual({
        status: 'claimed',
        claim: {
          kind: 'manual',
          claimId: 'manual-owner',
          generationId: 'response-finalize-owner',
        },
      });
    });

    it('recovers an unclaimed terminal receipt by task id after process-local state is lost', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: [
          {
            type: 'tool_call',
            agentId: 'agent-a',
            tool_call: {
              id: 'call-recovered',
              name: 'slow_tool',
              output: 'durable result',
              backgroundTask: {
                version: 1,
                taskId: 'task-recovered',
                toolName: 'slow_tool',
                status: 'completed',
                settledAt: new Date(),
              },
            },
          },
        ],
      });

      const recovery = {
        status: 'acquired',
        messageId: 'msg123',
        results: [
          {
            taskId: 'task-recovered',
            toolCallId: 'call-recovered',
            toolName: 'slow_tool',
            status: 'completed',
            output: 'durable result',
            agentId: 'agent-a',
            settledAt: expect.any(Date),
          },
        ],
      };
      const recover = () =>
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          taskId: 'task-recovered',
          agentId: 'agent-a',
          kind: 'manual',
          claimId: 'recovery-poll',
          generationId: 'response-recovery-owner',
        });
      await expect(recover()).resolves.toEqual(recovery);
      await expect(recover()).resolves.toEqual(recovery);
      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          taskId: 'task-recovered',
          agentId: 'agent-a',
          kind: 'manual',
          claimId: 'competing-poll',
        }),
      ).resolves.toEqual({
        status: 'claimed',
        messageId: 'msg123',
        claim: {
          kind: 'manual',
          claimId: 'recovery-poll',
          generationId: 'response-recovery-owner',
        },
      });
      await expect(
        claimBackgroundToolResults({
          userId: 'another-user',
          conversationId: mockMessageData.conversationId as string,
          taskId: 'task-recovered',
          kind: 'manual',
          claimId: 'cross-user-poll',
        }),
      ).resolves.toEqual({ status: 'not_found' });
    });

    it('reports an exact durable launch handle as outcome unknown after executor loss', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: [
          {
            type: 'tool_call',
            agentId: 'agent-a',
            tool_call: {
              id: 'call-lost',
              name: 'mutating_tool',
              output: JSON.stringify({
                background_task_id: 'task-lost',
                tool: 'mutating_tool',
                status: 'running',
                message: 'Use check_background_task to poll.',
              }),
            },
          },
        ],
      });

      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          taskId: 'task-lost',
          agentId: 'agent-a',
          kind: 'manual',
          claimId: 'recovery-poll',
        }),
      ).resolves.toEqual({ status: 'outcome_unknown', toolName: 'mutating_tool' });
      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          taskId: 'task-lost',
          agentId: 'agent-b',
          kind: 'manual',
          claimId: 'wrong-agent-poll',
        }),
      ).resolves.toEqual({ status: 'not_found' });
    });

    it('leaves a durable subagent handle to the routed subagent store', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'call-subagent',
              name: 'subagent',
              output: JSON.stringify({
                background_task_id: 'task-subagent',
                subagent_thread_id: 'thread-subagent',
                tool: 'subagent',
                subagent_type: 'researcher',
                status: 'running',
                progress: 0,
              }),
            },
          },
        ],
      });

      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          taskId: 'task-subagent',
          kind: 'manual',
          claimId: 'subagent-poll',
        }),
      ).resolves.toEqual({ status: 'not_found' });
    });

    it('claims a terminal result whose persisted claim stamp is a stored null', async () => {
      /** A full-row save can persist `resultClaim: null`, and the
       * subfield-preserving settle write keeps it where the old whole-object
       * rewrite dropped it. Every layer must read that as unclaimed — a
       * `$exists: false` fence would strand the part as terminal but
       * permanently unclaimable. */
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'call-null-claim',
              name: 'slow_tool',
              output: 'done',
              backgroundTask: {
                version: 1,
                taskId: 'task-null-claim',
                toolName: 'slow_tool',
                status: 'completed',
                settledAt: new Date(),
                completionWakeup: true,
                resultClaim: null,
              },
            },
          },
        ],
      });

      /** The stored stamp must actually BE null, or this test proves nothing. */
      const stored = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      const storedTask = (
        stored?.content?.[0] as { tool_call?: { backgroundTask?: Record<string, unknown> } }
      ).tool_call?.backgroundTask;
      expect(storedTask).toHaveProperty('resultClaim', null);

      const claim = await claimBackgroundToolResults({
        userId: 'user123',
        conversationId: mockMessageData.conversationId as string,
        messageId: 'msg123',
        taskId: 'task-null-claim',
        kind: 'wakeup',
        claimId: 'delivery-null',
      });
      expect(claim.status).toBe('acquired');
    });

    it('claims a cancelled ordinary background-tool result as terminal evidence', async () => {
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'call-cancelled-tool',
              name: 'bash_tool',
              output: 'Background task cancellation requested',
              backgroundTask: {
                version: 1,
                taskId: 'task-cancelled-tool',
                toolName: 'bash_tool',
                status: 'error',
                cancelled: true,
                settledAt: new Date(),
                completionWakeup: true,
              },
            },
          },
        ],
      });

      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-cancelled-tool',
          kind: 'wakeup',
          claimId: 'delivery-cancelled-tool',
        }),
      ).resolves.toEqual({
        status: 'acquired',
        results: [
          {
            taskId: 'task-cancelled-tool',
            toolCallId: 'call-cancelled-tool',
            toolName: 'bash_tool',
            status: 'cancelled',
            output: 'Background task cancellation requested',
            settledAt: expect.any(Date),
          },
        ],
      });
    });

    it('elects one result consumer and batches terminal siblings for a wakeup', async () => {
      const terminal = (id: string, taskId: string, output: string) => ({
        type: 'tool_call',
        agentId: 'agent-a',
        tool_call: {
          id,
          name: 'slow_tool',
          output,
          backgroundTask: {
            version: 1,
            taskId,
            toolName: 'slow_tool',
            status: 'completed',
            settledAt: new Date(),
            completionWakeup: true,
          },
        },
      });
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: [terminal('call-1', 'task-1', 'one'), terminal('call-2', 'task-2', 'two')],
      });

      const wakeup = await claimBackgroundToolResults({
        userId: 'user123',
        conversationId: mockMessageData.conversationId as string,
        messageId: 'msg123',
        taskId: 'task-1',
        kind: 'wakeup',
        claimId: 'delivery-1',
      });
      expect(wakeup).toEqual({
        status: 'acquired',
        results: [
          {
            taskId: 'task-1',
            toolCallId: 'call-1',
            toolName: 'slow_tool',
            status: 'completed',
            output: 'one',
            agentId: 'agent-a',
            settledAt: expect.any(Date),
          },
          {
            taskId: 'task-2',
            toolCallId: 'call-2',
            toolName: 'slow_tool',
            status: 'completed',
            output: 'two',
            agentId: 'agent-a',
            settledAt: expect.any(Date),
          },
        ],
      });
      await Message.updateOne(
        { messageId: 'msg123', user: 'user123' },
        { $push: { content: terminal('call-3', 'task-3', 'three') } },
      );
      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-1',
          kind: 'wakeup',
          claimId: 'delivery-1',
        }),
      ).resolves.toEqual(wakeup);
      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-2',
          kind: 'manual',
          claimId: 'poll-1',
        }),
      ).resolves.toEqual({
        status: 'claimed',
        claim: { kind: 'wakeup', claimId: 'delivery-1' },
      });
      /** V1 producers have no completionReceipt marker, but the V1 resolver
       * acquires resultClaim before delivery. A later batch must exclude it. */
      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-3',
          kind: 'wakeup',
          claimId: 'delivery-2',
        }),
      ).resolves.toMatchObject({
        status: 'acquired',
        results: [{ taskId: 'task-3', output: 'three' }],
      });
    });

    it.each([true, false])(
      'keeps independent receipt ownership out of message batches (root=%s)',
      async (receiptRoot) => {
        const terminal = (taskId: string, receipt: boolean) => ({
          type: 'tool_call',
          tool_call: {
            id: taskId,
            output: taskId,
            backgroundTask: {
              taskId,
              toolName: 'tool',
              status: 'completed',
              completionWakeup: true,
              ...(receipt ? { completionReceipt: true } : {}),
            },
          },
        });
        await saveMessage(mockCtx, {
          ...mockMessageData,
          content: [
            terminal('root', receiptRoot),
            terminal('independent', true),
            terminal('message-only', false),
          ],
        });
        const input = {
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'root',
          kind: 'wakeup' as const,
          claimId: 'delivery',
          limit: 16,
        };
        const claim = await claimBackgroundToolResults(input);
        expect(claim.status).toBe('acquired');
        if (claim.status !== 'acquired') throw new Error('Expected acquired claim');
        expect(claim.results.map((r) => r.taskId)).toEqual(
          receiptRoot ? ['root'] : ['root', 'message-only'],
        );
        await expect(claimBackgroundToolResults({ ...input, limit: 1 })).resolves.toEqual(claim);
        await expect(
          claimBackgroundToolResults({ ...input, taskId: 'independent', claimId: 'other' }),
        ).resolves.toMatchObject({
          status: 'acquired',
          results: [{ taskId: 'independent' }],
        });
      },
    );

    it('bounds escaped metadata before claiming and freezes membership across competing same-owner preparations', async () => {
      const ids = Array.from({ length: 16 }, (_, i) => `${i}${'\u0001'.repeat(250)}`);
      const terminal = (id: string) => ({
        type: 'tool_call',
        tool_call: {
          id,
          output: 'done',
          backgroundTask: {
            taskId: id,
            toolName: '\u0001'.repeat(256),
            status: 'completed',
            completionWakeup: true,
          },
        },
      });
      await saveMessage(mockCtx, { ...mockMessageData, content: ids.map(terminal) });
      const input = {
        userId: 'user123',
        conversationId: mockMessageData.conversationId as string,
        messageId: 'msg123',
        taskId: ids[15],
        kind: 'wakeup' as const,
        claimId: 'delivery',
        limit: 16,
        maxMetadataChars: 16 * 1024 - 256,
      };
      const attempts = await Promise.all([
        claimBackgroundToolResults(input),
        claimBackgroundToolResults(input),
      ]);
      const claim = attempts.find((result) => result.status === 'acquired');
      if (claim?.status !== 'acquired') throw new Error('No claim elected');
      expect(claim.results.some((r) => r.taskId === ids[15])).toBe(true);
      expect(claim.results.length).toBeLessThan(16);
      expect(
        JSON.stringify(claim.results.map(backgroundResultMetadata)).length,
      ).toBeLessThanOrEqual(input.maxMetadataChars);
      await Message.updateOne(
        { messageId: 'msg123', user: 'user123' },
        { $push: { content: terminal('late') } },
      );
      await expect(claimBackgroundToolResults({ ...input, limit: 1 })).resolves.toEqual(claim);
      await expect(
        claimBackgroundToolResults({ ...input, taskId: 'late', claimId: 'later' }),
      ).resolves.toMatchObject({ status: 'acquired' });
    });

    it('revalidates each sibling inside the atomic batch claim', async () => {
      const terminal = (taskId: string) => ({
        type: 'tool_call',
        tool_call: {
          id: `call-${taskId}`,
          name: 'slow_tool',
          output: taskId,
          backgroundTask: {
            version: 1,
            taskId,
            toolName: 'slow_tool',
            status: 'completed',
            settledAt: new Date(),
            completionWakeup: true,
          },
        },
      });
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: [terminal('root'), terminal('stale-sibling')],
      });
      const originalFindOneAndUpdate = Message.collection.findOneAndUpdate.bind(Message.collection);
      const claimWrite = jest
        .spyOn(Message.collection, 'findOneAndUpdate')
        .mockImplementationOnce(async (...args) => {
          await Message.collection.updateOne(
            { user: 'user123', messageId: 'msg123' },
            { $set: { 'content.1.tool_call.backgroundTask.status': 'running' } },
          );
          return originalFindOneAndUpdate(...args);
        });

      try {
        await expect(
          claimBackgroundToolResults({
            userId: 'user123',
            conversationId: mockMessageData.conversationId as string,
            messageId: 'msg123',
            taskId: 'root',
            kind: 'wakeup',
            claimId: 'delivery-root',
          }),
        ).resolves.toMatchObject({
          status: 'acquired',
          results: [expect.objectContaining({ taskId: 'root' })],
        });
      } finally {
        claimWrite.mockRestore();
      }

      const saved = await Message.findOne({ user: 'user123', messageId: 'msg123' }).lean();
      expect(saved?.content?.[1]).not.toHaveProperty('tool_call.backgroundTask.resultClaim');
    });

    it('does not batch a terminal sibling that elected poll-only delivery', async () => {
      const terminal = (taskId: string, completionWakeup: boolean) => ({
        type: 'tool_call',
        tool_call: {
          id: `call-${taskId}`,
          name: 'slow_tool',
          output: taskId,
          backgroundTask: {
            version: 1,
            taskId,
            toolName: 'slow_tool',
            status: 'completed',
            settledAt: new Date(),
            ...(completionWakeup ? { completionWakeup: true } : {}),
          },
        },
      });
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: [terminal('wakeup', true), terminal('poll-only', false)],
      });

      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'wakeup',
          kind: 'wakeup',
          claimId: 'delivery-1',
        }),
      ).resolves.toMatchObject({
        status: 'acquired',
        results: [expect.objectContaining({ taskId: 'wakeup' })],
      });
      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'poll-only',
          kind: 'manual',
          claimId: 'poll-1',
        }),
      ).resolves.toMatchObject({
        status: 'acquired',
        results: [expect.objectContaining({ taskId: 'poll-only' })],
      });
    });

    it('uses nested tool-call agent identity when batching sibling results', async () => {
      const backgroundTask = (taskId: string) => ({
        version: 1,
        taskId,
        toolName: 'slow_tool',
        status: 'completed',
        settledAt: new Date(),
        completionWakeup: true,
      });
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: [
          {
            type: 'tool_call',
            agentId: 'agent-a',
            tool_call: {
              id: 'call-a',
              name: 'slow_tool',
              output: 'a',
              backgroundTask: backgroundTask('task-a'),
            },
          },
          {
            type: 'tool_call',
            tool_call: {
              id: 'call-b',
              agentId: 'agent-b',
              name: 'slow_tool',
              output: 'b',
              backgroundTask: backgroundTask('task-b'),
            },
          },
        ],
      });

      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-a',
          agentId: 'agent-a',
          kind: 'wakeup',
          claimId: 'delivery-a',
        }),
      ).resolves.toEqual({
        status: 'acquired',
        results: [
          {
            taskId: 'task-a',
            toolCallId: 'call-a',
            toolName: 'slow_tool',
            status: 'completed',
            output: 'a',
            agentId: 'agent-a',
            settledAt: expect.any(Date),
          },
        ],
      });
      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-b',
          agentId: 'agent-b',
          kind: 'manual',
          claimId: 'poll-b',
        }),
      ).resolves.toMatchObject({
        status: 'acquired',
        results: [expect.objectContaining({ taskId: 'task-b', agentId: 'agent-b' })],
      });
    });

    it('releases only the exact wakeup batch claim', async () => {
      const task = {
        version: 1,
        toolName: 'slow_tool',
        status: 'completed',
        settledAt: new Date(),
        resultClaim: { kind: 'wakeup', claimId: 'delivery-1', claimedAt: new Date() },
      };
      await saveMessage(mockCtx, {
        ...mockMessageData,
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'call-1',
              name: 'slow_tool',
              output: 'one',
              backgroundTask: { ...task, taskId: 'task-1' },
            },
          },
          {
            type: 'tool_call',
            tool_call: {
              id: 'call-2',
              name: 'slow_tool',
              output: 'two',
              backgroundTask: {
                ...task,
                taskId: 'task-2',
                resultClaim: { kind: 'manual', claimId: 'poll-1', claimedAt: new Date() },
              },
            },
          },
          {
            type: 'tool_call',
            tool_call: {
              id: 'call-3',
              name: 'slow_tool',
              output: 'three',
              backgroundTask: { ...task, taskId: 'task-3' },
            },
          },
        ],
      });

      await expect(
        releaseBackgroundToolResultClaims({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          kind: 'wakeup',
          claimId: 'delivery-1',
        }),
      ).resolves.toBe(true);
      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-1',
          kind: 'manual',
          claimId: 'poll-2',
        }),
      ).resolves.toMatchObject({ status: 'acquired' });
      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-3',
          kind: 'manual',
          claimId: 'poll-3',
        }),
      ).resolves.toMatchObject({ status: 'acquired' });
      await expect(
        claimBackgroundToolResults({
          userId: 'user123',
          conversationId: mockMessageData.conversationId as string,
          messageId: 'msg123',
          taskId: 'task-2',
          kind: 'wakeup',
          claimId: 'delivery-2',
        }),
      ).resolves.toEqual({
        status: 'claimed',
        claim: { kind: 'manual', claimId: 'poll-1' },
      });
    });

    it('keeps a sibling AGENT’s attachment when both id and file key collide', async () => {
      /* Handoff agents can share a provider tool-call id AND a claimed
       * file_id (same filename in one conversation); the second agent's
       * anchor must not evict the first agent's card-scoped attachment. */
      await saveMessage(mockCtx, { ...mockMessageData, content: toolCallContent() });

      await updateToolCallResult({
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_bg',
        agentId: 'agent_a',
        attachments: [{ file_id: 'shared', toolCallId: 'call_bg', agentId: 'agent_a' }],
      });
      await updateToolCallResult({
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_bg',
        agentId: 'agent_b',
        attachments: [{ file_id: 'shared', toolCallId: 'call_bg', agentId: 'agent_b' }],
      });

      const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(saved?.attachments).toEqual([
        { file_id: 'shared', toolCallId: 'call_bg', agentId: 'agent_a' },
        { file_id: 'shared', toolCallId: 'call_bg', agentId: 'agent_b' },
      ]);
    });

    it('keeps a sibling tool call’s attachment when file ids repeat across calls', async () => {
      await saveMessage(mockCtx, { ...mockMessageData, content: toolCallContent() });

      await updateToolCallResult({
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_bg',
        attachments: [{ file_id: 'shared', toolCallId: 'call_bg' }],
      });
      /** A second background call regenerated the same filename — same
       *  claimed file_id, different tool call. The first card must keep
       *  its attachment (the client anchors by toolCallId). */
      await updateToolCallResult({
        userId: 'user123',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_other',
        attachments: [{ file_id: 'shared', toolCallId: 'call_other' }],
      });

      const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(saved?.attachments).toEqual([
        { file_id: 'shared', toolCallId: 'call_bg' },
        { file_id: 'shared', toolCallId: 'call_other' },
      ]);
    });

    it('does not match another user’s message', async () => {
      await saveMessage(mockCtx, { ...mockMessageData, content: toolCallContent() });

      const result = await updateToolCallResult({
        userId: 'someone-else',
        messageId: 'msg123',
        conversationId: mockMessageData.conversationId as string,
        toolCallId: 'call_bg',
        output: 'hijacked',
      });
      expect(result.matched).toBe(false);

      const saved = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      const content = saved?.content as Array<{ tool_call?: { output?: string } }>;
      expect(content[1].tool_call?.output).toBe('{"background_task_id":"task-1"}');
    });
  });

  describe('deleteMessagesSince', () => {
    it('should delete messages only for the authenticated user', async () => {
      const conversationId = uuidv4();

      // Create multiple messages in the same conversation
      await saveMessage(mockCtx, {
        messageId: 'msg1',
        conversationId,
        text: 'First message',
        user: 'user123',
      });

      await saveMessage(mockCtx, {
        messageId: 'msg2',
        conversationId,
        text: 'Second message',
        user: 'user123',
      });

      await waitForTimestampTick();

      await saveMessage(mockCtx, {
        messageId: 'msg3',
        conversationId,
        text: 'Third message',
        user: 'user123',
      });

      // Delete messages since message2 (this should only delete messages created AFTER msg2)
      await deleteMessagesSince(mockCtx.userId, {
        messageId: 'msg2',
        conversationId,
      });

      // Verify msg1 and msg2 remain, msg3 is deleted
      const remainingMessages = await Message.find({ conversationId, user: 'user123' });
      expect(remainingMessages).toHaveLength(2);
      expect(remainingMessages.map((m) => m.messageId)).toContain('msg1');
      expect(remainingMessages.map((m) => m.messageId)).toContain('msg2');
      expect(remainingMessages.map((m) => m.messageId)).not.toContain('msg3');
    });

    it('should return undefined if no message is found', async () => {
      const result = await deleteMessagesSince(mockCtx.userId, {
        messageId: 'nonexistent',
        conversationId: 'convo123',
      });
      expect(result).toBeUndefined();
    });
  });

  describe('CLIENT_MESSAGE_SELECT projection', () => {
    it('strips server-internal fields and dead SERP verticals, keeping rendered data', async () => {
      const conversationId = uuidv4();
      await Message.create({
        messageId: 'projected-msg',
        conversationId,
        user: 'user123',
        isCreatedByUser: false,
        sender: 'Agent',
        text: 'visible text',
        content: [
          { type: 'text', text: 'part text' },
          {
            type: 'tool_call',
            tool_call: {
              id: 'call-background',
              backgroundTask: {
                version: 1,
                taskId: 'task-visible',
                toolName: 'slow_tool',
                status: 'completed',
                settledAt: new Date(),
                resultClaim: {
                  kind: 'wakeup',
                  claimId: 'private-delivery-identity',
                  claimedAt: new Date(),
                },
              },
            },
          },
        ],
        tokenCount: 42,
        conversationSignature: 'sig',
        clientId: 'client-1',
        invocationId: 7,
        summary: 'legacy summary',
        summaryTokenCount: 11,
        contextMeta: { anything: true },
        langfuseSampled: true,
        langfuseDestinationIds: ['lf-1'],
        langfuseRunId: 'run-1',
        metadata: {
          usage: { input: 10, output: 20 },
          thoughtSignatures: { tool_1: 'opaque' },
        },
        subagentTask: {
          attemptKey: 'private-attempt',
          requestFingerprint: 'private-fingerprint',
          status: 'running',
        },
        attachments: [
          {
            type: 'web_search',
            toolCallId: 'tool_1',
            web_search: {
              turn: 0,
              organic: [
                {
                  title: 'Result',
                  link: 'https://example.com',
                  snippet: 'snippet',
                  sitelinks: [{ title: 'sub', link: 'https://example.com/sub' }],
                  highlights: ['raw scrape'],
                },
              ],
              topStories: [{ title: 'Story', link: 'https://example.com/s', highlights: ['x'] }],
              references: [{ link: 'https://example.com', title: 'Result', type: 'link' }],
              images: [{ imageUrl: 'https://example.com/i.png' }],
              answerBox: { answer: '42' },
              knowledgeGraph: { title: 'KG' },
              peopleAlsoAsk: [{ question: 'q' }],
              relatedSearches: ['related'],
              news: [{ title: 'n' }],
              videos: [{ title: 'v' }],
              places: [{ title: 'p' }],
              shopping: [{ title: 's' }],
            },
          },
        ],
      });

      const [message] = await getMessages(
        { conversationId, user: 'user123' },
        CLIENT_MESSAGE_SELECT,
      );

      expect(message.text).toBe('visible text');
      expect(message.content).toHaveLength(2);
      const projectedTask = (
        message.content?.[1] as { tool_call?: { backgroundTask?: Record<string, unknown> } }
      ).tool_call?.backgroundTask;
      expect(projectedTask).toMatchObject({ taskId: 'task-visible' });
      expect(projectedTask).not.toHaveProperty('resultClaim');
      expect(message.tokenCount).toBe(42);
      const metadata = message.metadata as Record<string, unknown>;
      expect(metadata.usage).toBeDefined();
      expect(metadata.thoughtSignatures).toBeUndefined();

      const hidden = message as unknown as Record<string, unknown>;
      for (const field of [
        '_id',
        'user',
        'conversationSignature',
        'clientId',
        'invocationId',
        'summary',
        'summaryTokenCount',
        'contextMeta',
        'langfuseSampled',
        'langfuseDestinationIds',
        'langfuseRunId',
        'subagentTask',
      ]) {
        expect(hidden[field]).toBeUndefined();
      }

      type ProjectedWebSearch = {
        turn: number;
        organic: Array<Record<string, unknown>>;
        topStories: Array<Record<string, unknown>>;
        references: unknown[];
        images: unknown[];
      } & Record<string, unknown>;
      const webSearch = (message.attachments?.[0] as { web_search: ProjectedWebSearch }).web_search;
      expect(webSearch.turn).toBe(0);
      expect(webSearch.organic[0].title).toBe('Result');
      expect(webSearch.organic[0].link).toBe('https://example.com');
      expect(webSearch.organic[0].snippet).toBe('snippet');
      expect(webSearch.organic[0].sitelinks).toBeUndefined();
      expect(webSearch.organic[0].highlights).toBeUndefined();
      expect(webSearch.topStories[0].title).toBe('Story');
      expect(webSearch.topStories[0].highlights).toBeUndefined();
      expect(webSearch.references).toHaveLength(1);
      expect(webSearch.images).toHaveLength(1);
      /** `videos` stays: `turn…video…` citation markers resolve against it
       *  (the clipboard refTypeMap addresses it explicitly). */
      expect(webSearch.videos).toHaveLength(1);
      expect(webSearch.answerBox).toBeDefined();
      for (const vertical of [
        'knowledgeGraph',
        'peopleAlsoAsk',
        'relatedSearches',
        'news',
        'places',
        'shopping',
      ]) {
        expect(webSearch[vertical]).toBeUndefined();
      }
    });
  });

  describe('conversation fetch index', () => {
    it('declares the compound index that serves the conversation fetch and its sort', () => {
      const indexes = Message.schema.indexes() as Array<[Record<string, number>, unknown]>;
      expect(indexes).toContainEqual([
        { conversationId: 1, user: 1, createdAt: 1, _id: 1 },
        expect.anything(),
      ]);
    });
  });

  describe('getMessages', () => {
    it('should retrieve messages with the correct filter', async () => {
      const conversationId = uuidv4();

      // Save some messages
      await saveMessage(mockCtx, {
        messageId: 'msg1',
        conversationId,
        text: 'First message',
        user: 'user123',
      });

      await saveMessage(mockCtx, {
        messageId: 'msg2',
        conversationId,
        text: 'Second message',
        user: 'user123',
      });

      const messages = await getMessages({ conversationId });
      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe('First message');
      expect(messages[1].text).toBe('Second message');
    });

    it('should limit retrieved messages when requested', async () => {
      const conversationId = uuidv4();

      await saveMessage(mockCtx, {
        messageId: 'msg1',
        conversationId,
        text: 'First message',
        user: 'user123',
      });

      await saveMessage(mockCtx, {
        messageId: 'msg2',
        conversationId,
        text: 'Second message',
        user: 'user123',
      });

      await saveMessage(mockCtx, {
        messageId: 'msg3',
        conversationId,
        text: 'Third message',
        user: 'user123',
      });

      const messages = await getMessages({ conversationId }, undefined, { limit: 2 });

      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe('First message');
      expect(messages[1].text).toBe('Second message');
    });
  });

  describe('getMessagesForSubagentThreadView', () => {
    it('bounds text in MongoDB before returning the public projection', async () => {
      const conversationId = uuidv4();
      await saveMessage(mockCtx, {
        messageId: 'bounded-message',
        conversationId,
        text: '🧵'.repeat(20_000),
        user: 'user123',
      });

      const messages = await getMessagesForSubagentThreadView({
        user: 'user123',
        conversationId,
        limit: 1,
        textCodePointLimit: 8_192,
      });

      expect(messages).toHaveLength(1);
      expect(Array.from(messages[0].text ?? '')).toHaveLength(8_192);
      expect(Buffer.byteLength(messages[0].text ?? '', 'utf8')).toBeLessThanOrEqual(32 * 1024);
      expect(messages[0].textProjectionTruncated).toBe(true);
      expect(messages[0]).not.toHaveProperty('user');
      expect(messages[0]).not.toHaveProperty('conversationId');
    });

    it('anchors older pages by an exact scoped message without exposing Mongo ids', async () => {
      const conversationId = uuidv4();
      for (let index = 0; index < 4; index += 1) {
        await saveMessage(mockCtx, {
          messageId: `task-${index}:assistant`,
          conversationId,
          text: `Answer ${index}`,
          user: 'user123',
          createdAt: new Date(Date.UTC(2026, 7, 21, 12, index)),
        });
      }
      await saveMessage(mockCtx, {
        messageId: 'foreign:user',
        conversationId: uuidv4(),
        text: 'Foreign anchor',
        user: 'user123',
      });

      const page = await getMessagesForSubagentThreadView({
        user: 'user123',
        conversationId,
        beforeMessageId: 'task-2:assistant',
        limit: 2,
        textCodePointLimit: 8_192,
      });
      const foreign = await getMessagesForSubagentThreadView({
        user: 'user123',
        conversationId,
        beforeMessageId: 'foreign:user',
        limit: 2,
        textCodePointLimit: 8_192,
      });

      expect(page.map((message) => message.messageId)).toEqual([
        'task-2:assistant',
        'task-1:assistant',
      ]);
      expect(page[0]).not.toHaveProperty('_id');
      expect(foreign).toEqual([]);
    });

    it('projects only the bounded display-safe external event identity', async () => {
      const conversationId = uuidv4();
      await saveMessage(mockCtx, {
        messageId: 'event:user',
        conversationId,
        text: 'Private event payload',
        user: 'user123',
        subagentTriggerProjection: {
          version: 1,
          eventType: 'chess.turn.ready',
          sourceType: 'speed-chess',
          occurredAt: new Date('2026-08-21T12:00:00.000Z'),
          expectedActionToolName: 'submit_move',
        },
      });

      const [projected] = await getMessagesForSubagentThreadView({
        user: 'user123',
        conversationId,
        limit: 1,
        textCodePointLimit: 8_192,
      });

      expect(projected.subagentTriggerProjection).toEqual({
        version: 1,
        eventType: 'chess.turn.ready',
        sourceType: 'speed-chess',
        occurredAt: new Date('2026-08-21T12:00:00.000Z'),
        expectedActionToolName: 'submit_move',
      });
      expect(projected.subagentTriggerProjection).not.toHaveProperty('deliveryId');
      expect(projected.subagentTriggerProjection).not.toHaveProperty('sourceId');
    });

    it('projects bounded private transcripts for the retained linear history', async () => {
      const conversationId = uuidv4();
      await saveMessage(mockCtx, {
        messageId: 'task-a:assistant',
        conversationId,
        text: 'A',
        user: 'user123',
        subagentTranscript: {
          taskId: 'task-a',
          mode: 'append',
          messagesJson: '[{"type":"ai","data":{"content":"A"}}]',
        },
      });
      await saveMessage(mockCtx, {
        messageId: 'task-b:assistant',
        conversationId,
        text: 'B',
        user: 'user123',
        subagentTranscript: {
          taskId: 'task-b',
          mode: 'append',
          messagesJson: '[{"type":"ai","data":{"content":"B"}}]',
        },
      });

      const messages = await getMessagesForSubagentThreadView({
        user: 'user123',
        conversationId,
        limit: 10,
        textCodePointLimit: 8_192,
      });

      expect(messages).toHaveLength(2);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            messageId: 'task-a:assistant',
            subagentTranscript: expect.objectContaining({ taskId: 'task-a' }),
          }),
          expect.objectContaining({
            messageId: 'task-b:assistant',
            subagentTranscript: expect.objectContaining({ taskId: 'task-b' }),
          }),
        ]),
      );
    });

    it('keeps the budgeted timeline a contiguous newest suffix past an oversized entry', async () => {
      const conversationId = uuidv4();
      await saveMessage(mockCtx, {
        messageId: 'task-suffix:assistant',
        conversationId,
        text: '',
        user: 'user123',
        content: [
          ...Array.from({ length: 5 }, (_, index) => ({
            type: 'text',
            text: `older-${index}`,
          })),
          ...Array.from({ length: 8 }, (_, index) => ({
            type: 'text',
            text: `newest-${index}-${'b'.repeat(8_400)}`,
          })),
        ],
      });

      const messages = await getMessagesForSubagentThreadView({
        user: 'user123',
        conversationId,
        limit: 1,
        textCodePointLimit: 8_192,
      });

      const activity = messages[0].subagentActivity as Array<{ type: string; text: string }>;
      expect(activity.length).toBeGreaterThan(0);
      expect(activity.length).toBeLessThan(8);
      expect(activity.every((item) => item.text.startsWith('newest-'))).toBe(true);
      expect(activity[activity.length - 1].text).toContain('newest-7-');
      expect(JSON.stringify(activity)).not.toContain('older-');
      expect(messages[0].subagentActivityProjectionTruncated).toBe(true);
    });

    it('fits ordinary persisted child activity into the aggregate byte budget, newest first', async () => {
      const conversationId = uuidv4();
      await saveMessage(mockCtx, {
        messageId: 'task-budget:assistant',
        conversationId,
        text: '',
        user: 'user123',
        content: Array.from({ length: 12 }, (_, index) => ({
          type: 'text',
          text: `chunk-${index}-${'z'.repeat(8_000)}`,
        })),
      });

      const messages = await getMessagesForSubagentThreadView({
        user: 'user123',
        conversationId,
        limit: 1,
        textCodePointLimit: 8_192,
      });

      const activity = messages[0].subagentActivity as Array<{ type: string; text: string }>;
      expect(activity.length).toBeGreaterThan(0);
      expect(activity.length).toBeLessThan(12);
      expect(activity[activity.length - 1].text).toContain('chunk-11-');
      expect(activity[0].text).toContain(`chunk-${12 - activity.length}-`);
      const totalBytes = activity.reduce((sum, item) => sum + item.text.length, 0);
      expect(totalBytes).toBeLessThanOrEqual(64 * 1024);
      expect(messages[0].subagentActivityProjectionTruncated).toBe(true);
    });

    it('bounds ordinary persisted child activity before returning it to the API', async () => {
      const conversationId = uuidv4();
      await saveMessage(mockCtx, {
        messageId: 'task-content:assistant',
        conversationId,
        text: '',
        user: 'user123',
        content: [
          ...Array.from({ length: SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT + 2 }, (_, index) => ({
            type: 'text',
            text: `activity-${index}`,
          })),
          {
            type: 'tool_call',
            tool_call: {
              id: 'move-1',
              name: 'submit_move',
              args: 'x'.repeat(3_000),
              output: 'y'.repeat(5_000),
              progress: 1,
              inputValidationError: true,
            },
          },
          {
            type: 'activity_label',
            activity_label: 'Coordinating agents',
            tool_call_ids: Array.from({ length: 32 }, (_, index) => `tool-${index}`),
            agent_ids: Array.from({ length: 32 }, (_, index) => `agent-${index}`),
          },
        ],
      });

      const messages = await getMessagesForSubagentThreadView({
        user: 'user123',
        conversationId,
        limit: 1,
        textCodePointLimit: 8_192,
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].subagentActivity).toHaveLength(SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT);
      expect(messages[0].subagentActivityProjectionTruncated).toBe(true);
      const retainedTool = messages[0].subagentActivity?.find(
        (activity) => (activity as { type?: string }).type === 'tool',
      ) as {
        input: string;
        output: string;
      };
      expect(retainedTool).toEqual(
        expect.objectContaining({
          type: 'tool',
          toolCallId: 'move-1',
          name: 'submit_move',
          inputValidationError: true,
          inputTruncated: true,
          outputTruncated: true,
        }),
      );
      expect(retainedTool.input.length).toBeLessThan(3_000);
      expect(retainedTool.output.length).toBeLessThan(5_000);
      const retainedLabel = messages[0].subagentActivity?.find(
        (activity) => (activity as { type?: string }).type === 'activity_label',
      ) as { agentIds: string[]; labelTruncated: boolean; toolCallIds: string[] };
      expect(retainedLabel.toolCallIds).toHaveLength(8);
      expect(retainedLabel.agentIds).toHaveLength(8);
      expect(retainedLabel.labelTruncated).toBe(true);
      expect(JSON.stringify(messages[0])).not.toContain('activity-0');
      expect(JSON.stringify(messages[0])).not.toContain('x'.repeat(2_049));
      expect(JSON.stringify(messages[0])).not.toContain('y'.repeat(4_097));
    });

    it('bounds public control receipts before materializing the message page', async () => {
      const conversationId = uuidv4();
      const createdAt = new Date('2026-08-21T12:00:00.000Z');
      const accepted = Array.from({ length: 16 }, (_, index) => ({
        invocationId: `accepted-${index}`,
        fingerprint: `private-fingerprint-${index}`,
        action: 'steer' as const,
        status: 'accepted' as const,
        createdAt,
        updatedAt: createdAt,
        message: 'a'.repeat(4_096),
      }));
      const terminal = Array.from({ length: 48 }, (_, index) => ({
        invocationId: `applied-${index}`,
        fingerprint: `private-fingerprint-terminal-${index}`,
        action: 'queue' as const,
        status: 'applied' as const,
        createdAt,
        updatedAt: createdAt,
        message: 't'.repeat(4_096),
      }));
      await saveMessage(mockCtx, {
        messageId: 'task-controls:user',
        conversationId,
        text: 'Control the child.',
        user: 'user123',
        subagentTask: {
          attemptKey: 'private-attempt-key',
          requestFingerprint: 'private-request-fingerprint',
          status: 'running',
          controlReceipts: [...accepted, ...terminal],
        },
      });

      const [message] = await getMessagesForSubagentThreadView({
        user: 'user123',
        conversationId,
        limit: 1,
        textCodePointLimit: 8_192,
      });

      expect(message.subagentTask?.status).toBe('running');
      expect(message.subagentTask?.controlReceipts).toHaveLength(32);
      expect(message.subagentTask?.controlReceiptsProjectionTruncated).toBe(true);
      expect(message.subagentTask?.controlReceipts?.slice(0, 16)).toEqual(
        expect.arrayContaining(
          accepted.map((receipt) =>
            expect.objectContaining({ invocationId: receipt.invocationId, status: 'accepted' }),
          ),
        ),
      );
      expect(message.subagentTask?.controlReceipts?.slice(16)).toEqual(
        terminal
          .slice(-16)
          .map((receipt) =>
            expect.objectContaining({ invocationId: receipt.invocationId, status: 'applied' }),
          ),
      );
      for (const receipt of message.subagentTask?.controlReceipts ?? []) {
        expect(Buffer.byteLength(receipt.message ?? '', 'utf8')).toBeLessThanOrEqual(512);
        expect(receipt.messageTruncated).toBe(true);
        expect(receipt).not.toHaveProperty('fingerprint');
      }
      expect(message.subagentTask).not.toHaveProperty('attemptKey');
      expect(message.subagentTask).not.toHaveProperty('requestFingerprint');
    });

    it('bounds transcript materialization while retaining the exact selected task', async () => {
      const conversationId = uuidv4();
      const aggregateSpy = jest.spyOn(Message, 'aggregate');
      for (let index = 0; index < SUBAGENT_TRANSCRIPT_PAGE_LIMIT + 6; index += 1) {
        await saveMessage(mockCtx, {
          messageId: `task-${index}:assistant`,
          conversationId,
          text: `Answer ${index}`,
          user: 'user123',
          createdAt: new Date(Date.UTC(2026, 7, 21, 12, index)),
          subagentTranscript: {
            taskId: `task-${index}`,
            mode: 'append',
            messagesJson: JSON.stringify([{ type: 'ai', data: { content: `Answer ${index}` } }]),
          },
        });
      }

      const messages = await getMessagesForSubagentThreadView({
        user: 'user123',
        conversationId,
        selectedTaskId: 'task-0',
        limit: SUBAGENT_TRANSCRIPT_PAGE_LIMIT,
        textCodePointLimit: 8_192,
      });

      const materialized = messages.filter((message) => message.subagentTranscript != null);
      expect(messages).toHaveLength(SUBAGENT_TRANSCRIPT_PAGE_LIMIT + 1);
      expect(materialized).toHaveLength(SUBAGENT_TRANSCRIPT_PAGE_LIMIT);
      expect(materialized).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            messageId: 'task-0:assistant',
            subagentTranscript: expect.objectContaining({ taskId: 'task-0' }),
          }),
        ]),
      );
      expect(
        messages.filter(
          (message) =>
            message.subagentTranscript == null &&
            message.subagentTranscriptProjectionTruncated === true,
        ),
      ).toHaveLength(1);
      /** Three reads: the page, recent sources, and one single-snapshot read
       * that yields both the selected task's messages and its source — the
       * replacement for a `$facet`, which Amazon DocumentDB does not support. */
      expect(aggregateSpy).toHaveBeenCalledTimes(3);
      const messagesPipeline = aggregateSpy.mock.calls[0][0] as unknown as Array<
        Record<string, unknown>
      >;
      const recentSourcesPipeline = aggregateSpy.mock.calls[1][0] as unknown as Array<
        Record<string, unknown>
      >;
      const selectedPipeline = aggregateSpy.mock.calls[2][0] as unknown as Array<
        Record<string, unknown>
      >;
      for (const [pipeline] of aggregateSpy.mock.calls) {
        expect(pipeline).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ $facet: expect.anything() })]),
        );
      }
      expect(messagesPipeline[2]).toEqual({ $limit: SUBAGENT_TRANSCRIPT_PAGE_LIMIT });
      expect(recentSourcesPipeline[2]).toEqual({
        $limit: SUBAGENT_TRANSCRIPT_PAGE_LIMIT * 2,
      });
      expect(selectedPipeline[0]).toEqual(
        expect.objectContaining({
          $match: expect.objectContaining({
            messageId: {
              $in: ['task-0:user', 'task-0:assistant'],
            },
          }),
        }),
      );
      aggregateSpy.mockRestore();
    });

    it('omits an oversized private transcript before returning the application result', async () => {
      const conversationId = uuidv4();
      await saveMessage(mockCtx, {
        messageId: 'task-large:assistant',
        conversationId,
        text: 'The bounded public answer remains available.',
        user: 'user123',
        subagentTranscript: {
          taskId: 'task-large',
          mode: 'append',
          messagesJson: JSON.stringify([
            {
              type: 'ai',
              data: { content: 'x'.repeat(SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT + 1) },
            },
          ]),
        },
      });

      const messages = await getMessagesForSubagentThreadView({
        user: 'user123',
        conversationId,
        limit: 1,
        textCodePointLimit: 8_192,
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('The bounded public answer remains available.');
      expect(messages[0]).not.toHaveProperty('subagentTranscript');
      expect(messages[0].subagentTranscriptProjectionTruncated).toBe(true);
    });

    it('prefers the bounded settlement projection without materializing its private transcript', async () => {
      const conversationId = uuidv4();
      await saveMessage(mockCtx, {
        messageId: 'task-projected:assistant',
        conversationId,
        text: 'The public answer remains available.',
        user: 'user123',
        subagentTranscript: {
          taskId: 'task-projected',
          mode: 'append',
          messagesJson: JSON.stringify([
            {
              type: 'ai',
              data: { content: 'private'.repeat(SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT) },
            },
          ]),
        },
        subagentActivityProjection: {
          taskId: 'task-projected',
          version: 1,
          activityJson: JSON.stringify([{ type: 'writing', text: 'Public result.' }]),
          truncated: false,
        },
      });

      const messages = await getMessagesForSubagentThreadView({
        user: 'user123',
        conversationId,
        selectedTaskId: 'task-projected',
        limit: 1,
        textCodePointLimit: 8_192,
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].subagentActivityProjectionJson).toBe(
        JSON.stringify([{ type: 'writing', text: 'Public result.' }]),
      );
      expect(messages[0]).not.toHaveProperty('subagentTranscript');
      expect(messages[0]).not.toHaveProperty('subagentTranscriptProjectionTruncated');
    });
  });

  describe('listSubagentTasksForThreads', () => {
    it('derives event task status from ordinary durable turn rows', async () => {
      const conversationId = uuidv4();
      await Message.create([
        {
          user: 'user123',
          messageId: 'delivery-running:user',
          conversationId,
          isCreatedByUser: true,
          createdAt: new Date('2026-08-21T10:00:00.000Z'),
        },
        {
          user: 'user123',
          messageId: 'delivery-complete:assistant',
          conversationId,
          isCreatedByUser: false,
          createdAt: new Date('2026-08-21T10:01:00.000Z'),
        },
        {
          user: 'user123',
          messageId: 'delivery-error:assistant',
          conversationId,
          isCreatedByUser: false,
          error: true,
          createdAt: new Date('2026-08-21T10:02:00.000Z'),
        },
      ]);

      const [record] = await listSubagentTasksForThreads({
        user: 'user123',
        conversationIds: [conversationId],
        limitPerThread: 3,
      });

      expect(record.tasks).toEqual([
        expect.objectContaining({
          messageId: 'delivery-error:assistant',
          status: 'error',
          statusDerived: true,
        }),
        expect.objectContaining({
          messageId: 'delivery-complete:assistant',
          status: 'completed',
          statusDerived: true,
        }),
        expect.objectContaining({
          messageId: 'delivery-running:user',
          status: 'running',
          statusDerived: true,
        }),
      ]);
    });

    it('batches threads, deduplicates task rows, and bounds each newest task list', async () => {
      const firstThread = uuidv4();
      const secondThread = uuidv4();
      await saveMessage(mockCtx, {
        messageId: 'task-old:user',
        conversationId: firstThread,
        text: 'Start old task',
        isCreatedByUser: true,
        subagentTask: { attemptKey: 'old', status: 'running' },
      });
      await waitForTimestampTick();
      await saveMessage(mockCtx, {
        messageId: 'task-old:assistant',
        conversationId: firstThread,
        text: 'Finish old task',
        isCreatedByUser: false,
        subagentTask: { attemptKey: 'old', status: 'completed' },
      });
      await waitForTimestampTick();
      await saveMessage(mockCtx, {
        messageId: 'task-new:user',
        conversationId: firstThread,
        text: 'Start new task',
        isCreatedByUser: true,
        subagentTask: { attemptKey: 'new', status: 'running' },
      });
      await saveMessage(mockCtx, {
        messageId: 'task-other:assistant',
        conversationId: secondThread,
        text: 'Other result',
        isCreatedByUser: false,
        subagentTask: { attemptKey: 'other', status: 'cancelled' },
      });

      const records = await listSubagentTasksForThreads({
        user: 'user123',
        conversationIds: [firstThread, secondThread],
        limitPerThread: 2,
      });

      const first = records.find((record) => record.conversationId === firstThread);
      expect(first?.tasks).toHaveLength(2);
      expect(first?.tasks[0]).toEqual(
        expect.objectContaining({ messageId: 'task-new:user', status: 'running' }),
      );
      expect(first?.tasks[1]).toEqual(
        expect.objectContaining({ messageId: 'task-old:assistant', status: 'completed' }),
      );
      expect(records.find((record) => record.conversationId === secondThread)?.tasks).toEqual([
        expect.objectContaining({ messageId: 'task-other:assistant', status: 'cancelled' }),
      ]);
      expect(records.every((record) => record.sourceTruncated !== true)).toBe(true);
    });

    it('marks every selected child truncated when one busy child fills the shared source window', async () => {
      const quietThread = uuidv4();
      const busyThread = uuidv4();
      await Message.create([
        ...['quiet-old', 'quiet-new'].map((taskId, index) => ({
          user: 'user123',
          messageId: `${taskId}:assistant`,
          conversationId: quietThread,
          isCreatedByUser: false,
          createdAt: new Date(`2026-08-20T10:0${index}:00.000Z`),
          updatedAt: new Date(`2026-08-20T10:0${index}:00.000Z`),
          subagentTask: { attemptKey: taskId, status: 'completed' },
        })),
        ...Array.from({ length: 9 }, (_, index) => ({
          user: 'user123',
          messageId: `busy-${index}:assistant`,
          conversationId: busyThread,
          isCreatedByUser: false,
          createdAt: new Date(`2026-08-21T10:${String(index).padStart(2, '0')}:00.000Z`),
          updatedAt: new Date(`2026-08-21T10:${String(index).padStart(2, '0')}:00.000Z`),
          subagentTask: { attemptKey: `busy-${index}`, status: 'completed' },
        })),
      ]);

      const records = await listSubagentTasksForThreads({
        user: 'user123',
        conversationIds: [quietThread, busyThread],
        limitPerThread: 2,
      });

      expect(records.find((record) => record.conversationId === quietThread)).toEqual(
        expect.objectContaining({
          sourceTruncated: true,
          tasks: [expect.objectContaining({ messageId: 'quiet-new:assistant' })],
        }),
      );
      expect(records.find((record) => record.conversationId === busyThread)?.sourceTruncated).toBe(
        true,
      );
    });

    it('preserves a newer recent task when the latest-per-thread snapshot is stale', async () => {
      const conversationId = uuidv4();
      const aggregate = jest.spyOn(Message, 'aggregate') as unknown as jest.Mock;
      aggregate
        .mockReturnValueOnce(
          Promise.resolve([
            {
              conversationId,
              tasks: [
                {
                  messageId: 'task-old:assistant',
                  createdAt: new Date('2026-08-21T10:00:00.000Z'),
                  status: 'completed',
                },
              ],
            },
          ]),
        )
        .mockReturnValueOnce(
          Promise.resolve([
            {
              conversationId,
              sourceRows: 1,
              tasks: [
                {
                  messageId: 'task-new:user',
                  createdAt: new Date('2026-08-21T11:00:00.000Z'),
                  status: 'running',
                },
              ],
            },
          ]),
        );

      try {
        await expect(
          listSubagentTasksForThreads({
            user: 'user123',
            conversationIds: [conversationId],
            limitPerThread: 2,
          }),
        ).resolves.toEqual([
          {
            conversationId,
            tasks: [
              expect.objectContaining({ messageId: 'task-new:user' }),
              expect.objectContaining({ messageId: 'task-old:assistant' }),
            ],
          },
        ]);
      } finally {
        aggregate.mockRestore();
      }
    });

    it('preserves Mongo occurrence ordering when task timestamps tie', async () => {
      const conversationId = uuidv4();
      const aggregate = jest.spyOn(Message, 'aggregate') as unknown as jest.Mock;
      aggregate
        .mockReturnValueOnce(
          Promise.resolve([
            {
              conversationId,
              tasks: [
                {
                  messageId: 'task-b:user',
                  createdAt: new Date('2026-08-21T10:00:00.000Z'),
                  occurrenceId: new mongoose.Types.ObjectId('000000000000000000000002'),
                  status: 'running',
                },
              ],
            },
          ]),
        )
        .mockReturnValueOnce(
          Promise.resolve([
            {
              conversationId,
              sourceRows: 1,
              tasks: [
                {
                  messageId: 'task-a:assistant',
                  createdAt: new Date('2026-08-21T10:00:00.000Z'),
                  occurrenceId: new mongoose.Types.ObjectId('000000000000000000000001'),
                  status: 'completed',
                },
              ],
            },
          ]),
        );

      try {
        const [record] = await listSubagentTasksForThreads({
          user: 'user123',
          conversationIds: [conversationId],
          limitPerThread: 2,
        });

        expect(record.tasks.map((task) => task.messageId)).toEqual([
          'task-b:user',
          'task-a:assistant',
        ]);
      } finally {
        aggregate.mockRestore();
      }
    });
  });

  describe('deleteMessages', () => {
    it('should delete messages with the correct filter', async () => {
      // Save some messages for different users
      await saveMessage(mockCtx, mockMessageData);
      await saveMessage(
        { userId: 'user456' },
        {
          messageId: 'msg456',
          conversationId: uuidv4(),
          text: 'Other user message',
          user: 'user456',
        },
      );

      await deleteMessages({ user: 'user123' });

      // Verify only user123's messages were deleted
      const user123Messages = await Message.find({ user: 'user123' });
      const user456Messages = await Message.find({ user: 'user456' });

      expect(user123Messages).toHaveLength(0);
      expect(user456Messages).toHaveLength(1);
    });
  });

  describe('Conversation Hijacking Prevention', () => {
    it("should not allow editing a message in another user's conversation", async () => {
      const victimConversationId = uuidv4();
      const victimMessageId = 'victim-msg-123';

      // First, save a message as the victim (but we'll try to edit as attacker)
      await saveMessage(
        { userId: 'victim123' },
        {
          messageId: victimMessageId,
          conversationId: victimConversationId,
          text: 'Victim message',
          user: 'victim123',
        },
      );

      // Attacker tries to edit the victim's message
      await expect(
        updateMessage('attacker123', {
          messageId: victimMessageId,
          conversationId: victimConversationId,
          text: 'Hacked message',
        }),
      ).rejects.toThrow('Message not found or user not authorized.');

      // Verify the original message is unchanged
      const originalMessage = await Message.findOne({
        messageId: victimMessageId,
        user: 'victim123',
      });
      expect(originalMessage?.text).toBe('Victim message');
    });

    it("should not allow deleting messages from another user's conversation", async () => {
      const victimConversationId = uuidv4();
      const victimMessageId = 'victim-msg-123';

      // Save a message as the victim
      await saveMessage(
        { userId: 'victim123' },
        {
          messageId: victimMessageId,
          conversationId: victimConversationId,
          text: 'Victim message',
          user: 'victim123',
        },
      );

      // Attacker tries to delete from victim's conversation
      const result = await deleteMessagesSince('attacker123', {
        messageId: victimMessageId,
        conversationId: victimConversationId,
      });

      expect(result).toBeUndefined();

      // Verify the victim's message still exists
      const victimMessage = await Message.findOne({
        messageId: victimMessageId,
        user: 'victim123',
      });
      expect(victimMessage).toBeTruthy();
      expect(victimMessage?.text).toBe('Victim message');
    });

    it("should not allow inserting a new message into another user's conversation", async () => {
      const victimConversationId = uuidv4();

      // Attacker tries to save a message - this should succeed but with attacker's user ID
      const result = await saveMessage(
        { userId: 'attacker123' },
        {
          conversationId: victimConversationId,
          text: 'Inserted malicious message',
          messageId: 'new-msg-123',
          user: 'attacker123',
        },
      );

      expect(result).toBeTruthy();
      expect(result?.user).toBe('attacker123');

      // Verify the message was saved with the attacker's user ID, not as an anonymous message
      const savedMessage = await Message.findOne({ messageId: 'new-msg-123' });
      expect(savedMessage?.user).toBe('attacker123');
      expect(savedMessage?.conversationId).toBe(victimConversationId);
    });

    it('should allow retrieving messages from any conversation', async () => {
      const victimConversationId = uuidv4();

      // Save a message in the victim's conversation
      await saveMessage(
        { userId: 'victim123' },
        {
          messageId: 'victim-msg',
          conversationId: victimConversationId,
          text: 'Victim message',
          user: 'victim123',
        },
      );

      // Anyone should be able to retrieve messages by conversation ID
      const messages = await getMessages({ conversationId: victimConversationId });
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('Victim message');
    });
  });

  describe('isTemporary message handling', () => {
    beforeEach(() => {
      // Reset mocks before each test
      jest.clearAllMocks();
    });

    it('should save a message with expiredAt when isTemporary is true', async () => {
      // Mock app config with 24 hour retention
      mockCtx.interfaceConfig = { temporaryChatRetention: 24 };

      mockCtx.isTemporary = true;

      const beforeSave = new Date();
      const result = await saveMessage(mockCtx, mockMessageData);
      const afterSave = new Date();

      expect(result?.messageId).toBe('msg123');
      expect(result?.expiredAt).toBeDefined();
      expect(result?.expiredAt).toBeInstanceOf(Date);

      // Verify expiredAt is approximately 24 hours in the future
      const expectedExpirationTime = new Date(beforeSave.getTime() + 24 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result?.expiredAt ?? 0);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        new Date(afterSave.getTime() + 24 * 60 * 60 * 1000 + 1000).getTime(),
      );
    });

    it('preserves an exact inherited expiration instead of recomputing retention', async () => {
      const inheritedExpiration = new Date('2026-08-22T03:04:05.000Z');
      mockCtx.isTemporary = true;
      mockCtx.expiredAt = inheritedExpiration;
      mockCtx.interfaceConfig = { temporaryChatRetention: 48 };

      const result = await saveMessage(mockCtx, mockMessageData);

      expect(result?.isTemporary).toBe(true);
      expect(result?.expiredAt).toEqual(inheritedExpiration);
    });

    it('should save a message without expiredAt when isTemporary is false', async () => {
      mockCtx.isTemporary = false;

      const result = await saveMessage(mockCtx, mockMessageData);

      expect(result?.messageId).toBe('msg123');
      expect(result?.expiredAt).toBeNull();
    });

    it('should save a message without expiredAt when isTemporary is not provided', async () => {
      // No isTemporary set

      const result = await saveMessage(mockCtx, mockMessageData);

      expect(result?.messageId).toBe('msg123');
      expect(result?.expiredAt).toBeUndefined();
    });

    it('should use custom retention period from config', async () => {
      // Mock app config with 48 hour retention
      mockCtx.interfaceConfig = { temporaryChatRetention: 48 };

      mockCtx.isTemporary = true;

      const beforeSave = new Date();
      const result = await saveMessage(mockCtx, mockMessageData);

      expect(result?.expiredAt).toBeDefined();

      // Verify expiredAt is approximately 48 hours in the future
      const expectedExpirationTime = new Date(beforeSave.getTime() + 48 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result?.expiredAt ?? 0);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        expectedExpirationTime.getTime() + 1000,
      );
    });

    it('should handle minimum retention period (1 hour)', async () => {
      // Mock app config with less than minimum retention
      mockCtx.interfaceConfig = { temporaryChatRetention: 0.5 }; // Half hour - should be clamped to 1 hour

      mockCtx.isTemporary = true;

      const beforeSave = new Date();
      const result = await saveMessage(mockCtx, mockMessageData);

      expect(result?.expiredAt).toBeDefined();

      // Verify expiredAt is approximately 1 hour in the future (minimum)
      const expectedExpirationTime = new Date(beforeSave.getTime() + 1 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result?.expiredAt ?? 0);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        expectedExpirationTime.getTime() + 1000,
      );
    });

    it('should handle maximum retention period (8760 hours)', async () => {
      // Mock app config with more than maximum retention
      mockCtx.interfaceConfig = { temporaryChatRetention: 10000 }; // Should be clamped to 8760 hours

      mockCtx.isTemporary = true;

      const beforeSave = new Date();
      const result = await saveMessage(mockCtx, mockMessageData);

      expect(result?.expiredAt).toBeDefined();

      // Verify expiredAt is approximately 8760 hours (1 year) in the future
      const expectedExpirationTime = new Date(beforeSave.getTime() + 8760 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result?.expiredAt ?? 0);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        expectedExpirationTime.getTime() + 1000,
      );
    });

    it.each([true, false, undefined])(
      'uses the independent retention period for isTemporary=%s',
      async (isTemporary) => {
        mockCtx.isTemporary = isTemporary;
        mockCtx.interfaceConfig = {
          temporaryChatRetention: 1,
          generalChatRetention: 2160,
          retentionMode: RetentionMode.ALL,
        };
        const now = Date.now();
        const result = await saveMessage(mockCtx, mockMessageData);
        const expectedHours = isTemporary === true ? 1 : 2160;

        expect(result?.isTemporary).toBe(isTemporary === true);
        expect(result?.expiredAt?.getTime()).toBeGreaterThanOrEqual(now + expectedHours * 3600000);
        expect(result?.expiredAt?.getTime()).toBeLessThan(now + expectedHours * 3600000 + 5000);
      },
    );

    it('atomically assigns general retention when inserting without a chat type', async () => {
      mockCtx.isTemporary = undefined;
      mockCtx.interfaceConfig = {
        temporaryChatRetention: 1,
        generalChatRetention: 2160,
        retentionMode: RetentionMode.ALL,
      };
      const followupWrite = jest
        .spyOn(Message, 'updateOne')
        .mockRejectedValue(new Error('offline'));

      const result = await saveMessage(mockCtx, mockMessageData);

      expect(result?.isTemporary).toBe(false);
      expect(result?.expiredAt).toBeInstanceOf(Date);
      expect(followupWrite).not.toHaveBeenCalled();
    });

    it('ignores caller-supplied retention fields', async () => {
      mockCtx.isTemporary = undefined;
      mockCtx.interfaceConfig = {
        temporaryChatRetention: 1,
        generalChatRetention: 2160,
        retentionMode: RetentionMode.ALL,
      };
      const suppliedExpiration = new Date('2099-01-01T00:00:00.000Z');

      const result = await saveMessage(mockCtx, {
        ...mockMessageData,
        isTemporary: true,
        expiredAt: suppliedExpiration,
      });

      expect(result?.isTemporary).toBe(false);
      expect(result?.expiredAt).not.toEqual(suppliedExpiration);
    });

    it.each([true, false])(
      'preserves the stored deadline when chat type %s is omitted',
      async (isTemporary) => {
        mockCtx.isTemporary = isTemporary;
        mockCtx.interfaceConfig = {
          temporaryChatRetention: 1,
          generalChatRetention: 2160,
          retentionMode: RetentionMode.ALL,
        };
        const first = await saveMessage(mockCtx, mockMessageData);
        mockCtx.isTemporary = undefined;
        const second = await saveMessage(mockCtx, { ...mockMessageData });
        expect(second?.isTemporary).toBe(isTemporary);
        expect(second?.expiredAt).toEqual(first?.expiredAt);
      },
    );

    it('preserves an explicitly inherited deadline with separate retention periods', async () => {
      mockCtx.isTemporary = false;
      mockCtx.expiredAt = new Date(Date.now() + 60000);
      mockCtx.interfaceConfig = {
        temporaryChatRetention: 1,
        generalChatRetention: 2160,
        retentionMode: RetentionMode.ALL,
      };
      const result = await saveMessage(mockCtx, mockMessageData);
      expect(result?.expiredAt).toEqual(mockCtx.expiredAt);
    });

    it('should set expiredAt for non-temporary message when retentionMode is ALL', async () => {
      mockCtx.isTemporary = false;
      mockCtx.interfaceConfig = {
        temporaryChatRetention: 24,
        retentionMode: RetentionMode.ALL,
      };
      const result = await saveMessage(mockCtx, mockMessageData);
      expect(result?.expiredAt).toBeDefined();
      expect(result?.expiredAt).toBeInstanceOf(Date);
    });

    it('should mark retained message non-temporary when retentionMode is ALL and isTemporary is omitted', async () => {
      mockCtx.isTemporary = undefined;
      mockCtx.interfaceConfig = {
        temporaryChatRetention: 24,
        retentionMode: RetentionMode.ALL,
      };

      const result = await saveMessage(mockCtx, mockMessageData);

      expect(result?.expiredAt).toBeDefined();
      expect(result?.isTemporary).toBe(false);
    });

    it('should preserve existing temporary flag when retentionMode is ALL and isTemporary is omitted', async () => {
      mockCtx.isTemporary = true;
      mockCtx.interfaceConfig = {
        temporaryChatRetention: 24,
        retentionMode: RetentionMode.ALL,
      };

      const firstSave = await saveMessage(mockCtx, mockMessageData);

      mockCtx.isTemporary = undefined;
      const secondSave = await saveMessage(mockCtx, {
        ...mockMessageData,
        text: 'Updated text',
      });

      expect(firstSave?.isTemporary).toBe(true);
      expect(secondSave?.text).toBe('Updated text');
      expect(secondSave?.isTemporary).toBe(true);
      expect(secondSave?.expiredAt).toBeDefined();
    });

    it('should not set expiredAt when retentionMode is temporary and not isTemporary', async () => {
      mockCtx.isTemporary = false;
      mockCtx.interfaceConfig = {
        temporaryChatRetention: 24,
        retentionMode: RetentionMode.TEMPORARY,
      };
      const result = await saveMessage(mockCtx, mockMessageData);
      expect(result?.expiredAt).toBeNull();
    });

    it('should handle missing config gracefully', async () => {
      // Simulate missing config - should use default retention period
      delete mockCtx.interfaceConfig;

      mockCtx.isTemporary = true;

      const beforeSave = new Date();
      const result = await saveMessage(mockCtx, mockMessageData);
      const afterSave = new Date();

      // Should still save the message with default retention period (30 days)
      expect(result?.messageId).toBe('msg123');
      expect(result?.expiredAt).toBeDefined();
      expect(result?.expiredAt).toBeInstanceOf(Date);

      // Verify expiredAt is approximately 30 days in the future (720 hours)
      const expectedExpirationTime = new Date(beforeSave.getTime() + 720 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result?.expiredAt ?? 0);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        new Date(afterSave.getTime() + 720 * 60 * 60 * 1000 + 1000).getTime(),
      );
    });

    it('should use default retention when config is not provided', async () => {
      // Mock getAppConfig to return empty config
      mockCtx.interfaceConfig = undefined; // Empty config

      mockCtx.isTemporary = true;

      const beforeSave = new Date();
      const result = await saveMessage(mockCtx, mockMessageData);

      expect(result?.expiredAt).toBeDefined();

      // Default retention is 30 days (720 hours)
      const expectedExpirationTime = new Date(beforeSave.getTime() + 30 * 24 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result?.expiredAt ?? 0);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        expectedExpirationTime.getTime() + 1000,
      );
    });

    it('should not update expiredAt on message update', async () => {
      // First save a temporary message
      mockCtx.interfaceConfig = { temporaryChatRetention: 24 };

      mockCtx.isTemporary = true;
      const savedMessage = await saveMessage(mockCtx, mockMessageData);
      const originalExpiredAt = savedMessage?.expiredAt;

      // Now update the message without isTemporary flag
      mockCtx.isTemporary = undefined;
      const updatedMessage = await updateMessage(mockCtx.userId, {
        messageId: 'msg123',
        text: 'Updated text',
      });

      // expiredAt should not be in the returned updated message object
      expect(updatedMessage?.expiredAt).toBeUndefined();

      // Verify in database that expiredAt wasn't changed
      const dbMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' });
      expect(dbMessage?.expiredAt).toEqual(originalExpiredAt);
    });

    it('should preserve expiredAt when saving existing temporary message', async () => {
      // First save a temporary message
      mockCtx.interfaceConfig = { temporaryChatRetention: 24 };

      mockCtx.isTemporary = true;
      const firstSave = await saveMessage(mockCtx, mockMessageData);
      const originalExpiredAt = firstSave?.expiredAt;

      // Wait a bit to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Save again with same messageId but different text
      const updatedData = { ...mockMessageData, text: 'Updated text' };
      const secondSave = await saveMessage(mockCtx, updatedData);

      // Should update text but create new expiredAt
      expect(secondSave?.text).toBe('Updated text');
      expect(secondSave?.expiredAt).toBeDefined();
      expect(new Date(secondSave?.expiredAt ?? 0).getTime()).toBeGreaterThan(
        new Date(originalExpiredAt ?? 0).getTime(),
      );
    });

    it('should preserve temporary retention when saving without isTemporary', async () => {
      mockCtx.interfaceConfig = { temporaryChatRetention: 24 };

      mockCtx.isTemporary = true;
      const firstSave = await saveMessage(mockCtx, mockMessageData);
      const originalExpiredAt = firstSave?.expiredAt;

      mockCtx.isTemporary = undefined;
      const updatedData = { ...mockMessageData, text: 'Updated text' };
      const secondSave = await saveMessage(mockCtx, updatedData);

      expect(secondSave?.text).toBe('Updated text');
      expect(secondSave?.isTemporary).toBe(true);
      expect(secondSave?.expiredAt).toEqual(originalExpiredAt);
    });

    it('should handle bulk operations with temporary messages', async () => {
      // This test verifies bulkSaveMessages doesn't interfere with expiredAt
      const messages = [
        {
          messageId: 'bulk1',
          conversationId: uuidv4(),
          text: 'Bulk message 1',
          user: 'user123',
          expiredAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        {
          messageId: 'bulk2',
          conversationId: uuidv4(),
          text: 'Bulk message 2',
          user: 'user123',
          expiredAt: null,
        },
      ];

      await bulkSaveMessages(messages);

      const savedMessages = await Message.find({
        messageId: { $in: ['bulk1', 'bulk2'] },
      }).lean();

      expect(savedMessages).toHaveLength(2);

      const bulk1 = savedMessages.find((m) => m.messageId === 'bulk1');
      const bulk2 = savedMessages.find((m) => m.messageId === 'bulk2');

      expect(bulk1?.expiredAt).toBeDefined();
      expect(bulk2?.expiredAt).toBeNull();
    });
  });

  describe('Message cursor pagination', () => {
    /**
     * Helper to create messages with specific timestamps
     * Uses collection.insertOne to bypass Mongoose timestamps
     */
    const createMessageWithTimestamp = async (
      index: number,
      conversationId: string,
      createdAt: Date,
    ) => {
      const messageId = uuidv4();
      await Message.collection.insertOne({
        messageId,
        conversationId,
        user: 'user123',
        text: `Message ${index}`,
        isCreatedByUser: index % 2 === 0,
        createdAt,
        updatedAt: createdAt,
      });
      return Message.findOne({ messageId }).lean<IMessage>();
    };

    /**
     * Simulates the pagination logic from api/server/routes/messages.js
     * This tests the exact query pattern used in the route
     */
    const getMessagesByCursor = async ({
      conversationId,
      user,
      pageSize = 25,
      cursor = null as string | null,
      sortBy = 'createdAt',
      sortDirection = 'desc',
    }: {
      conversationId: string;
      user: string;
      pageSize?: number;
      cursor?: string | null;
      sortBy?: string;
      sortDirection?: string;
    }) => {
      const sortOrder = sortDirection === 'asc' ? 1 : -1;
      const sortField = ['createdAt', 'updatedAt'].includes(sortBy) ? sortBy : 'createdAt';
      const cursorOperator = sortDirection === 'asc' ? '$gt' : '$lt';

      const filter: Record<string, unknown> = { conversationId, user };
      if (cursor) {
        filter[sortField] = { [cursorOperator]: new Date(cursor) };
      }

      const messages = await Message.find(filter)
        .sort({ [sortField]: sortOrder })
        .limit(pageSize + 1)
        .lean();

      let nextCursor: string | null = null;
      if (messages.length > pageSize) {
        messages.pop(); // Remove extra item used to detect next page
        // Create cursor from the last RETURNED item (not the popped one)
        nextCursor = (messages[messages.length - 1] as Record<string, unknown>)[
          sortField
        ] as string;
      }

      return { messages, nextCursor };
    };

    it('should return messages for a conversation with pagination', async () => {
      const conversationId = uuidv4();
      const baseTime = new Date('2026-01-01T00:00:00.000Z');

      // Create 30 messages to test pagination
      for (let i = 0; i < 30; i++) {
        const createdAt = new Date(baseTime.getTime() - i * 60000); // Each 1 minute apart
        await createMessageWithTimestamp(i, conversationId, createdAt);
      }

      // Fetch first page (pageSize 25)
      const page1 = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        pageSize: 25,
      });

      expect(page1.messages).toHaveLength(25);
      expect(page1.nextCursor).toBeTruthy();

      // Fetch second page using cursor
      const page2 = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        pageSize: 25,
        cursor: page1.nextCursor,
      });

      // Should get remaining 5 messages
      expect(page2.messages).toHaveLength(5);
      expect(page2.nextCursor).toBeNull();

      // Verify no duplicates and no gaps
      const allMessageIds = [
        ...page1.messages.map((m) => m.messageId),
        ...page2.messages.map((m) => m.messageId),
      ];
      const uniqueIds = new Set(allMessageIds);

      expect(uniqueIds.size).toBe(30); // All 30 messages accounted for
      expect(allMessageIds.length).toBe(30); // No duplicates
    });

    it('should not skip message at page boundary (item 26 bug fix)', async () => {
      const conversationId = uuidv4();
      const baseTime = new Date('2026-01-01T12:00:00.000Z');

      // Create exactly 26 messages
      const messages: (IMessage | null)[] = [];
      for (let i = 0; i < 26; i++) {
        const createdAt = new Date(baseTime.getTime() - i * 60000);
        const msg = await createMessageWithTimestamp(i, conversationId, createdAt);
        messages.push(msg);
      }

      // The 26th message (index 25) should be on page 2
      const item26 = messages[25];

      // Fetch first page with pageSize 25
      const page1 = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        pageSize: 25,
      });

      expect(page1.messages).toHaveLength(25);
      expect(page1.nextCursor).toBeTruthy();

      // Item 26 should NOT be in page 1
      const page1Ids = page1.messages.map((m) => m.messageId);
      expect(page1Ids).not.toContain(item26!.messageId);

      // Fetch second page
      const page2 = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        pageSize: 25,
        cursor: page1.nextCursor,
      });

      // Item 26 MUST be in page 2 (this was the bug - it was being skipped)
      expect(page2.messages).toHaveLength(1);
      expect((page2.messages[0] as { messageId: string }).messageId).toBe(item26!.messageId);
    });

    it('should sort by createdAt DESC by default', async () => {
      const conversationId = uuidv4();

      // Create messages with specific timestamps
      const msg1 = await createMessageWithTimestamp(
        1,
        conversationId,
        new Date('2026-01-01T00:00:00.000Z'),
      );
      const msg2 = await createMessageWithTimestamp(
        2,
        conversationId,
        new Date('2026-01-02T00:00:00.000Z'),
      );
      const msg3 = await createMessageWithTimestamp(
        3,
        conversationId,
        new Date('2026-01-03T00:00:00.000Z'),
      );

      const result = await getMessagesByCursor({
        conversationId,
        user: 'user123',
      });

      // Should be sorted by createdAt DESC (newest first) by default
      expect(result?.messages).toHaveLength(3);
      expect((result?.messages[0] as { messageId: string }).messageId).toBe(msg3!.messageId);
      expect((result?.messages[1] as { messageId: string }).messageId).toBe(msg2!.messageId);
      expect((result?.messages[2] as { messageId: string }).messageId).toBe(msg1!.messageId);
    });

    it('should support ascending sort direction', async () => {
      const conversationId = uuidv4();

      const msg1 = await createMessageWithTimestamp(
        1,
        conversationId,
        new Date('2026-01-01T00:00:00.000Z'),
      );
      const msg2 = await createMessageWithTimestamp(
        2,
        conversationId,
        new Date('2026-01-02T00:00:00.000Z'),
      );

      const result = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        sortDirection: 'asc',
      });

      // Should be sorted by createdAt ASC (oldest first)
      expect(result?.messages).toHaveLength(2);
      expect((result?.messages[0] as { messageId: string }).messageId).toBe(msg1!.messageId);
      expect((result?.messages[1] as { messageId: string }).messageId).toBe(msg2!.messageId);
    });

    it('should handle empty conversation', async () => {
      const conversationId = uuidv4();

      const result = await getMessagesByCursor({
        conversationId,
        user: 'user123',
      });

      expect(result?.messages).toHaveLength(0);
      expect(result?.nextCursor).toBeNull();
    });

    it('should only return messages for the specified user', async () => {
      const conversationId = uuidv4();
      const createdAt = new Date();

      // Create a message for user123
      await Message.collection.insertOne({
        messageId: uuidv4(),
        conversationId,
        user: 'user123',
        text: 'User message',
        createdAt,
        updatedAt: createdAt,
      });

      // Create a message for a different user
      await Message.collection.insertOne({
        messageId: uuidv4(),
        conversationId,
        user: 'otherUser',
        text: 'Other user message',
        createdAt,
        updatedAt: createdAt,
      });

      const result = await getMessagesByCursor({
        conversationId,
        user: 'user123',
      });

      // Should only return user123's message
      expect(result?.messages).toHaveLength(1);
      expect((result?.messages[0] as { user: string }).user).toBe('user123');
    });

    it('should handle exactly pageSize number of messages (no next page)', async () => {
      const conversationId = uuidv4();
      const baseTime = new Date('2026-01-01T00:00:00.000Z');

      // Create exactly 25 messages (equal to default pageSize)
      for (let i = 0; i < 25; i++) {
        const createdAt = new Date(baseTime.getTime() - i * 60000);
        await createMessageWithTimestamp(i, conversationId, createdAt);
      }

      const result = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        pageSize: 25,
      });

      expect(result?.messages).toHaveLength(25);
      expect(result?.nextCursor).toBeNull(); // No next page
    });

    it('should handle pageSize of 1', async () => {
      const conversationId = uuidv4();
      const baseTime = new Date('2026-01-01T00:00:00.000Z');

      // Create 3 messages
      for (let i = 0; i < 3; i++) {
        const createdAt = new Date(baseTime.getTime() - i * 60000);
        await createMessageWithTimestamp(i, conversationId, createdAt);
      }

      // Fetch with pageSize 1
      let cursor: string | null = null;
      const allMessages: unknown[] = [];

      for (let page = 0; page < 5; page++) {
        const result = await getMessagesByCursor({
          conversationId,
          user: 'user123',
          pageSize: 1,
          cursor,
        });

        allMessages.push(...(result?.messages ?? []));
        cursor = result?.nextCursor;

        if (!cursor) {
          break;
        }
      }

      // Should get all 3 messages without duplicates
      expect(allMessages).toHaveLength(3);
      const uniqueIds = new Set(allMessages.map((m) => (m as { messageId: string }).messageId));
      expect(uniqueIds.size).toBe(3);
    });

    it('should handle messages with same createdAt timestamp', async () => {
      const conversationId = uuidv4();
      const sameTime = new Date('2026-01-01T12:00:00.000Z');

      // Create multiple messages with the exact same timestamp
      const messages: (IMessage | null)[] = [];
      for (let i = 0; i < 5; i++) {
        const msg = await createMessageWithTimestamp(i, conversationId, sameTime);
        messages.push(msg);
      }

      const result = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        pageSize: 10,
      });

      // All messages should be returned
      expect(result?.messages).toHaveLength(5);
    });
  });

  describe('tenantId stripping', () => {
    it('merges provenance within the active tenant context', async () => {
      const messageId = uuidv4();
      const conversationId = uuidv4();

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await saveMessage(
          { userId: 'user123' },
          { messageId, conversationId, text: 'Original', userSubmittedPaths: ['/text'] },
        );
        await saveMessage(
          { userId: 'user123' },
          {
            messageId,
            conversationId,
            text: 'Updated',
            userSubmittedPaths: ['/content/0/text'],
          },
        );
      });

      const doc = await runAsSystem(async () => Message.findOne({ messageId }).lean());
      expect(doc?.tenantId).toBe('tenant-a');
      expect(doc?.text).toBe('Updated');
      expect(doc?.userSubmittedPaths).toEqual(expect.arrayContaining(['/text', '/content/0/text']));
      expect(doc?.userSubmittedPaths).toHaveLength(2);
    });

    it('saveMessage should not write caller-supplied tenantId to the document', async () => {
      const messageId = uuidv4();
      const conversationId = uuidv4();
      const result = await saveMessage(
        { userId: 'user123' },
        {
          messageId,
          conversationId,
          text: 'Tenant test',
          tenantId: 'malicious-tenant',
          userSubmittedPaths: ['/text'],
        },
      );

      expect(result).not.toBeNull();
      expect(result).toBeDefined();
      const doc = await Message.findOne({ messageId }).lean();
      expect(doc).not.toBeNull();
      expect(doc?.text).toBe('Tenant test');
      expect(doc?.tenantId).toBeUndefined();
    });

    it('bulkSaveMessages should not overwrite tenantId via update payload', async () => {
      const messageId = uuidv4();
      const conversationId = uuidv4();

      await tenantStorage.run({ tenantId: 'real-tenant' }, async () => {
        await Message.create({
          messageId,
          conversationId,
          user: 'user123',
          text: 'Original',
        });
      });

      await tenantStorage.run({ tenantId: 'real-tenant' }, async () => {
        await bulkSaveMessages([
          {
            messageId,
            conversationId,
            user: 'user123',
            text: 'Updated',
            tenantId: 'malicious-tenant',
          },
        ]);
      });

      const doc = await runAsSystem(async () => Message.findOne({ messageId }).lean());
      expect(doc).not.toBeNull();
      expect(doc?.text).toBe('Updated');
      expect(doc?.tenantId).toBe('real-tenant');
    });

    it('recordMessage should not write caller-supplied tenantId to the document', async () => {
      const messageId = uuidv4();
      const conversationId = uuidv4();
      await recordMessage({
        user: 'user123',
        messageId,
        conversationId,
        text: 'Record tenant test',
        tenantId: 'malicious-tenant',
      });

      const doc = await Message.findOne({ messageId }).lean();
      expect(doc).not.toBeNull();
      expect(doc?.text).toBe('Record tenant test');
      expect(doc?.tenantId).toBeUndefined();
    });

    it('updateMessage should not write caller-supplied tenantId to the document', async () => {
      const messageId = uuidv4();
      const conversationId = uuidv4();
      await saveMessage({ userId: 'user123' }, { messageId, conversationId, text: 'Original' });

      const updateWithUnknownField = {
        messageId,
        text: 'Updated',
        tenantId: 'malicious-tenant',
        unknownPipelineField: 'malicious-value',
        userSubmittedPaths: ['/text'],
      };
      await updateMessage('user123', updateWithUnknownField);

      const doc = await Message.findOne({ messageId }).lean();
      expect(doc?.text).toBe('Updated');
      expect(doc?.tenantId).toBeUndefined();
      expect((doc as Record<string, unknown> | null)?.unknownPipelineField).toBeUndefined();
    });
  });
  describe('recordSubagentTaskControlReceipt', () => {
    const createTaskInput = async (conversationId: string, taskId = 'task-1') => {
      await Message.create({
        user: 'user123',
        conversationId,
        messageId: `${taskId}:user`,
        parentMessageId: Constants.NO_PARENT,
        sender: 'User',
        text: 'Do the work',
        endpoint: 'agents',
        isCreatedByUser: true,
        subagentTask: {
          attemptKey: `attempt-${taskId}`,
          status: 'running',
        },
      });
    };

    it('advances one invocation monotonically and enforces ownership', async () => {
      const conversationId = uuidv4();
      await createTaskInput(conversationId);
      const accepted = {
        invocationId: 'invocation-1',
        fingerprint: 'fingerprint-1',
        controlId: 'control-1',
        action: 'steer' as const,
        status: 'accepted' as const,
        createdAt: new Date('2026-08-24T12:00:00.000Z'),
        updatedAt: new Date('2026-08-24T12:00:00.000Z'),
        message: 'Use the primary source.',
      };

      await expect(
        recordSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId,
          taskId: 'task-1',
          receipt: { ...accepted, controlId: undefined, status: 'reserved' },
        }),
      ).resolves.toBe(true);
      /** A reservation fences competing owners but is not public evidence that
       * the command was accepted or applied. */
      await expect(
        getSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId,
          taskId: 'task-1',
          invocationId: 'invocation-1',
        }),
      ).resolves.toBeNull();

      await expect(
        recordSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId,
          taskId: 'task-1',
          receipt: accepted,
        }),
      ).resolves.toBe(true);
      await expect(
        recordSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId,
          taskId: 'task-1',
          receipt: {
            ...accepted,
            status: 'applied',
            boundary: 'tool',
            updatedAt: new Date('2026-08-24T12:00:01.000Z'),
          },
        }),
      ).resolves.toBe(true);
      /** A delayed accepted replay cannot downgrade the durable terminal receipt. */
      await expect(
        recordSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId,
          taskId: 'task-1',
          receipt: accepted,
        }),
      ).resolves.toBe('unchanged');
      await expect(
        recordSubagentTaskControlReceipt({
          userId: 'another-user',
          conversationId,
          taskId: 'task-1',
          receipt: accepted,
        }),
      ).resolves.toBe(false);

      const stored = await Message.findOne({
        user: 'user123',
        conversationId,
        messageId: 'task-1:user',
      })
        .select('+subagentTask')
        .lean<IMessage>();
      expect(stored).not.toBeNull();
      if (stored == null) throw new Error('Expected the durable task input.');
      expect(stored.subagentTask?.status).toBe('running');
      expect(stored.subagentTask?.controlReceipts).toEqual([
        expect.objectContaining({
          invocationId: 'invocation-1',
          action: 'steer',
          status: 'applied',
          boundary: 'tool',
        }),
      ]);
    });

    it('updates only the authorized tenant when message identities collide', async () => {
      const conversationId = uuidv4();
      const taskId = 'tenant-task';
      await Promise.all(
        ['tenant-a', 'tenant-b'].map((tenantId) =>
          Message.create({
            user: 'user123',
            tenantId,
            conversationId,
            messageId: `${taskId}:user`,
            parentMessageId: Constants.NO_PARENT,
            sender: 'User',
            text: 'Do the tenant work',
            endpoint: 'agents',
            isCreatedByUser: true,
            subagentTask: { attemptKey: `attempt-${tenantId}`, status: 'running' },
          }),
        ),
      );
      const now = new Date('2026-08-24T12:00:00.000Z');

      await expect(
        recordSubagentTaskControlReceipt({
          userId: 'user123',
          tenantId: 'tenant-b',
          conversationId,
          taskId,
          receipt: {
            invocationId: 'tenant-invocation',
            fingerprint: 'tenant-fingerprint',
            controlId: 'tenant-control',
            action: 'queue',
            status: 'accepted',
            createdAt: now,
            updatedAt: now,
          },
        }),
      ).resolves.toBe(true);

      const [tenantA, tenantB] = await Promise.all(
        ['tenant-a', 'tenant-b'].map((tenantId) =>
          Message.findOne({
            user: 'user123',
            tenantId,
            conversationId,
            messageId: `${taskId}:user`,
          })
            .select('+subagentTask')
            .lean<IMessage>(),
        ),
      );
      expect(tenantA?.subagentTask?.controlReceipts).toBeUndefined();
      expect(tenantB?.subagentTask?.controlReceipts).toEqual([
        expect.objectContaining({ invocationId: 'tenant-invocation' }),
      ]);
    });

    it('reads an exact authorized receipt and persists a new terminal rejection', async () => {
      const conversationId = uuidv4();
      await createTaskInput(conversationId);
      await mongoose.models.Conversation.create({
        user: 'user123',
        conversationId,
        title: 'Child thread',
        endpoint: 'agents',
        subagentThread: {
          rootConversationId: 'parent-conversation',
          parentConversationId: 'parent-conversation',
          parentMessageId: 'parent-message',
          parentToolCallId: 'parent-tool',
          subagentType: 'researcher',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      await Message.create({
        user: 'user123',
        conversationId,
        messageId: 'task-1:assistant',
        parentMessageId: 'task-1:user',
        sender: 'researcher',
        text: 'Done.',
        endpoint: 'agents',
        isCreatedByUser: false,
        subagentTask: {
          attemptKey: 'task-1-attempt',
          parentRunId: 'parent-message',
          status: 'completed',
          resultClaim: {
            kind: 'manual',
            claimId: 'poll-1',
            claimedAt: new Date('2026-08-24T12:00:02.000Z'),
          },
        },
      });
      const now = new Date('2026-08-24T12:00:00.000Z');
      await expect(
        recordSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId,
          taskId: 'task-1',
          receipt: {
            invocationId: 'terminal-invocation',
            fingerprint: 'terminal-fingerprint',
            action: 'cancel',
            status: 'rejected',
            reason: 'task_not_running',
            createdAt: now,
            updatedAt: now,
          },
        }),
      ).resolves.toBe(true);

      await expect(
        getSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId,
          taskId: 'task-1',
          invocationId: 'terminal-invocation',
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          invocationId: 'terminal-invocation',
          fingerprint: 'terminal-fingerprint',
          status: 'rejected',
          reason: 'task_not_running',
        }),
      );
      await expect(
        getSubagentTaskControlReceipt({
          userId: 'another-user',
          conversationId,
          taskId: 'task-1',
          invocationId: 'terminal-invocation',
        }),
      ).resolves.toBeNull();
      await expect(
        getSubagentTaskControlReplay({
          userId: 'user123',
          parentConversationId: 'parent-conversation',
          taskId: 'task-1',
          invocationId: 'terminal-invocation',
        }),
      ).resolves.toEqual({
        receipt: expect.objectContaining({ invocationId: 'terminal-invocation' }),
        task: expect.objectContaining({
          taskId: 'task-1',
          threadId: conversationId,
          subagentType: 'researcher',
          status: 'completed',
          resultAvailable: true,
          resultClaimed: true,
        }),
      });
      await expect(
        getSubagentTaskControlReplay({
          userId: 'user123',
          parentConversationId: 'different-parent',
          taskId: 'task-1',
          invocationId: 'terminal-invocation',
        }),
      ).resolves.toBeNull();

      const ordinaryConversationId = uuidv4();
      await Message.create({
        user: 'user123',
        conversationId: ordinaryConversationId,
        messageId: 'ordinary-task:user',
        parentMessageId: Constants.NO_PARENT,
        sender: 'User',
        text: 'An ordinary message with a colliding id.',
        endpoint: 'agents',
        isCreatedByUser: true,
      });
      await expect(
        recordSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId: ordinaryConversationId,
          taskId: 'ordinary-task',
          receipt: {
            invocationId: 'terminal-invocation',
            fingerprint: 'terminal-fingerprint',
            action: 'cancel',
            status: 'rejected',
            reason: 'task_not_running',
            createdAt: now,
            updatedAt: now,
          },
        }),
      ).resolves.toBe(false);
    });

    it('replays an applied cancellation as cancelled before its terminal row exists', async () => {
      const conversationId = uuidv4();
      await createTaskInput(conversationId);
      await mongoose.models.Conversation.create({
        user: 'user123',
        conversationId,
        title: 'Cancelling child thread',
        endpoint: 'agents',
        subagentThread: {
          rootConversationId: 'parent-conversation',
          parentConversationId: 'parent-conversation',
          parentMessageId: 'parent-message',
          parentToolCallId: 'parent-tool',
          subagentType: 'researcher',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      const now = new Date('2026-08-24T12:00:00.000Z');
      await expect(
        recordSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId,
          taskId: 'task-1',
          receipt: {
            invocationId: 'cancel-invocation',
            fingerprint: 'cancel-fingerprint',
            action: 'cancel',
            status: 'applied',
            createdAt: now,
            updatedAt: now,
          },
        }),
      ).resolves.toBe(true);

      await expect(
        getSubagentTaskControlReplay({
          userId: 'user123',
          parentConversationId: 'parent-conversation',
          taskId: 'task-1',
          invocationId: 'cancel-invocation',
        }),
      ).resolves.toEqual({
        receipt: expect.objectContaining({ invocationId: 'cancel-invocation' }),
        task: expect.objectContaining({
          taskId: 'task-1',
          threadId: conversationId,
          status: 'cancelled',
          resultAvailable: false,
          resultClaimed: false,
          updatedAt: now,
        }),
      });
    });

    it('reports every accepted control when replaying one durable invocation', async () => {
      const conversationId = uuidv4();
      await createTaskInput(conversationId);
      await mongoose.models.Conversation.create({
        user: 'user123',
        conversationId,
        title: 'Controlled child thread',
        endpoint: 'agents',
        subagentThread: {
          rootConversationId: 'parent-conversation',
          parentConversationId: 'parent-conversation',
          parentMessageId: 'parent-message',
          parentToolCallId: 'parent-tool',
          subagentType: 'researcher',
          subagentKind: 'agent',
          depth: 1,
        },
      });
      const now = new Date('2026-08-24T12:00:00.000Z');
      for (const index of [1, 2]) {
        await expect(
          recordSubagentTaskControlReceipt({
            userId: 'user123',
            conversationId,
            taskId: 'task-1',
            receipt: {
              invocationId: `pending-invocation-${index}`,
              fingerprint: `pending-fingerprint-${index}`,
              controlId: `pending-control-${index}`,
              action: 'queue',
              status: 'accepted',
              createdAt: now,
              updatedAt: now,
            },
          }),
        ).resolves.toBe(true);
      }

      await expect(
        getSubagentTaskControlReplay({
          userId: 'user123',
          parentConversationId: 'parent-conversation',
          taskId: 'task-1',
          invocationId: 'pending-invocation-1',
        }),
      ).resolves.toEqual({
        receipt: expect.objectContaining({ invocationId: 'pending-invocation-1' }),
        task: expect.objectContaining({ pendingControls: 2 }),
      });
    });

    it('rejects an invocation fingerprint conflict without reporting persistence', async () => {
      const conversationId = uuidv4();
      await createTaskInput(conversationId);
      const now = new Date('2026-08-24T12:00:00.000Z');
      const receipt = {
        invocationId: 'conflicting-invocation',
        fingerprint: 'first-fingerprint',
        controlId: 'first-control',
        action: 'queue' as const,
        status: 'accepted' as const,
        createdAt: now,
        updatedAt: now,
      };
      await expect(
        recordSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId,
          taskId: 'task-1',
          receipt,
        }),
      ).resolves.toBe(true);
      await expect(
        recordSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId,
          taskId: 'task-1',
          receipt: { ...receipt, fingerprint: 'different-fingerprint' },
        }),
      ).resolves.toBe('conflict');
    });

    it('retains concurrent receipts without requiring an aggregation-pipeline update', async () => {
      const conversationId = uuidv4();
      await createTaskInput(conversationId);
      const createdAt = new Date('2026-08-24T12:00:00.000Z');

      const invocationIds = Array.from({ length: 32 }, (_, index) => `concurrent-${index}`);
      await Promise.all(
        invocationIds.map((invocationId, index) =>
          recordSubagentTaskControlReceipt({
            userId: 'user123',
            conversationId,
            taskId: 'task-1',
            receipt: {
              invocationId,
              fingerprint: `${invocationId}-fingerprint`,
              controlId: `${invocationId}-control`,
              action: 'queue',
              status: 'accepted',
              createdAt: new Date(createdAt.getTime() + index),
              updatedAt: new Date(createdAt.getTime() + index),
            },
          }),
        ),
      );

      const stored = await Message.findOne({
        user: 'user123',
        conversationId,
        messageId: 'task-1:user',
      })
        .select('+subagentTask')
        .lean<IMessage>();
      expect(stored?.subagentTask?.controlReceipts).toEqual(
        expect.arrayContaining(
          invocationIds.map((invocationId) => expect.objectContaining({ invocationId })),
        ),
      );
    });

    it('retains accepted commands while bounding terminal receipt history', async () => {
      const conversationId = uuidv4();
      await createTaskInput(conversationId);
      const createdAt = new Date('2026-08-24T12:00:00.000Z');
      await recordSubagentTaskControlReceipt({
        userId: 'user123',
        conversationId,
        taskId: 'task-1',
        receipt: {
          invocationId: 'pending',
          fingerprint: 'pending-fingerprint',
          controlId: 'pending-control',
          action: 'queue',
          status: 'accepted',
          createdAt,
          updatedAt: createdAt,
        },
      });
      for (let index = 0; index < 70; index += 1) {
        await recordSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId,
          taskId: 'task-1',
          receipt: {
            invocationId: `terminal-${index}`,
            fingerprint: `fingerprint-${index}`,
            controlId: `control-${index}`,
            action: 'steer',
            status: 'applied',
            createdAt: new Date(createdAt.getTime() + index + 1),
            updatedAt: new Date(createdAt.getTime() + index + 1),
            boundary: 'tool',
          },
        });
      }

      const stored = await Message.findOne({
        user: 'user123',
        conversationId,
        messageId: 'task-1:user',
      })
        .select('+subagentTask')
        .lean<IMessage>();
      expect(stored).not.toBeNull();
      if (stored == null) throw new Error('Expected the durable task input.');
      expect(stored.subagentTask?.controlReceipts).toHaveLength(64);
      expect(stored.subagentTask?.controlReceipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ invocationId: 'pending', status: 'accepted' }),
          expect.objectContaining({ invocationId: 'terminal-69', status: 'applied' }),
        ]),
      );
      expect(stored.subagentTask?.controlReceipts).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ invocationId: 'terminal-0' })]),
      );

      /** An old idempotent retry retains its original occurrence ordering and
       * cannot evict newer terminal history merely by arriving again. */
      await recordSubagentTaskControlReceipt({
        userId: 'user123',
        conversationId,
        taskId: 'task-1',
        receipt: {
          invocationId: 'terminal-0',
          fingerprint: 'fingerprint-0',
          controlId: 'control-0',
          action: 'steer',
          status: 'applied',
          createdAt: new Date(createdAt.getTime() + 1),
          updatedAt: new Date(createdAt.getTime() + 1),
          boundary: 'tool',
        },
      });
      const afterReplay = await Message.findOne({
        user: 'user123',
        conversationId,
        messageId: 'task-1:user',
      })
        .select('+subagentTask')
        .lean<IMessage>();
      expect(afterReplay?.subagentTask?.controlReceipts).toHaveLength(64);
      expect(afterReplay?.subagentTask?.controlReceipts).toEqual(
        expect.arrayContaining([expect.objectContaining({ invocationId: 'terminal-7' })]),
      );
      expect(afterReplay?.subagentTask?.controlReceipts).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ invocationId: 'terminal-0' })]),
      );
    });

    it('refuses to evict active receipt fences at durable capacity', async () => {
      const conversationId = uuidv4();
      await createTaskInput(conversationId);
      const createdAt = new Date('2026-08-24T12:00:00.000Z');
      const results: Array<boolean | 'unchanged' | 'conflict'> = [];
      for (let index = 0; index < 70; index += 1) {
        results.push(
          await recordSubagentTaskControlReceipt({
            userId: 'user123',
            conversationId,
            taskId: 'task-1',
            receipt: {
              invocationId: `accepted-${index}`,
              fingerprint: `fingerprint-${index}`,
              controlId: `control-${index}`,
              action: 'queue',
              status: 'accepted',
              createdAt: new Date(createdAt.getTime() + index),
              updatedAt: new Date(createdAt.getTime() + index),
            },
          }),
        );
      }
      expect(results.slice(0, 64)).toEqual(Array.from({ length: 64 }, () => true));
      expect(results.slice(64)).toEqual(Array.from({ length: 6 }, () => false));

      const stored = await Message.findOne({
        user: 'user123',
        conversationId,
        messageId: 'task-1:user',
      })
        .select('+subagentTask')
        .lean<IMessage>();
      expect(stored?.subagentTask?.controlReceipts).toHaveLength(64);
      expect(stored?.subagentTask?.controlReceipts?.[0]?.invocationId).toBe('accepted-0');
      expect(stored?.subagentTask?.controlReceipts?.[63]?.invocationId).toBe('accepted-63');

      await expect(
        recordSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId,
          taskId: 'task-1',
          receipt: {
            invocationId: 'terminal-with-no-allowance',
            fingerprint: 'terminal-fingerprint',
            controlId: 'terminal-control',
            action: 'queue',
            status: 'applied',
            createdAt: new Date(createdAt.getTime() + 100),
            updatedAt: new Date(createdAt.getTime() + 100),
            boundary: 'turn',
          },
        }),
      ).resolves.toBe(false);
      const afterTerminal = await Message.findOne({
        user: 'user123',
        conversationId,
        messageId: 'task-1:user',
      })
        .select('+subagentTask')
        .lean<IMessage>();
      expect(afterTerminal?.subagentTask?.controlReceipts).toHaveLength(64);
      expect(afterTerminal?.subagentTask?.controlReceipts).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ invocationId: 'terminal-with-no-allowance' }),
        ]),
      );

      /** Completing an existing active fence always frees its own slot and wins
       * over terminal history, even though its occurrence timestamp is oldest. */
      await expect(
        recordSubagentTaskControlReceipt({
          userId: 'user123',
          conversationId,
          taskId: 'task-1',
          receipt: {
            invocationId: 'accepted-0',
            fingerprint: 'fingerprint-0',
            controlId: 'control-0',
            action: 'queue',
            status: 'applied',
            createdAt,
            updatedAt: new Date(createdAt.getTime() + 101),
            boundary: 'turn',
          },
        }),
      ).resolves.toBe(true);
      const afterTransition = await Message.findOne({
        user: 'user123',
        conversationId,
        messageId: 'task-1:user',
      })
        .select('+subagentTask')
        .lean<IMessage>();
      expect(afterTransition?.subagentTask?.controlReceipts).toHaveLength(64);
      expect(afterTransition?.subagentTask?.controlReceipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ invocationId: 'accepted-0', status: 'applied' }),
          expect.objectContaining({ invocationId: 'accepted-63', status: 'accepted' }),
        ]),
      );
    });
  });

  describe('claimSubagentTaskResult', () => {
    const terminalResult = async (taskId: string, conversationId: string, status: string) =>
      saveMessage({ userId: 'user123' }, {
        messageId: `${taskId}:assistant`,
        conversationId,
        text: 'child result',
        subagentTask: { attemptKey: `${taskId}:attempt`, status },
      } as Partial<IMessage>);

    it('hands one terminal result to a single polling invocation', async () => {
      const taskId = uuidv4();
      const conversationId = uuidv4();
      await terminalResult(taskId, conversationId, 'completed');

      const first = await claimSubagentTaskResult({
        userId: 'user123',
        conversationId,
        taskId,
        kind: 'manual',
        claimId: 'poll-1',
      });
      expect(first.status).toBe('acquired');
      expect(first.status === 'acquired' && first.message.text).toBe('child result');

      /** The same invocation retrying recovers the result it never received. */
      const retried = await claimSubagentTaskResult({
        userId: 'user123',
        conversationId,
        taskId,
        kind: 'manual',
        claimId: 'poll-1',
      });
      expect(retried.status).toBe('acquired');

      /** Another invocation is told it was collected instead of handed a copy. */
      await expect(
        claimSubagentTaskResult({
          userId: 'user123',
          conversationId,
          taskId,
          kind: 'manual',
          claimId: 'poll-2',
        }),
      ).resolves.toMatchObject({ status: 'claimed' });
    });

    it('elects either a manual poll or one idempotent automatic wakeup', async () => {
      const manualTaskId = uuidv4();
      const wakeupTaskId = uuidv4();
      const conversationId = uuidv4();
      await terminalResult(manualTaskId, conversationId, 'completed');
      await terminalResult(wakeupTaskId, conversationId, 'completed');

      await expect(
        claimSubagentTaskResult({
          userId: 'user123',
          conversationId,
          taskId: manualTaskId,
          kind: 'manual',
          claimId: 'poll-1',
        }),
      ).resolves.toMatchObject({ status: 'acquired' });
      await expect(
        claimSubagentTaskResult({
          userId: 'user123',
          conversationId,
          taskId: manualTaskId,
          kind: 'wakeup',
          claimId: 'delivery-1',
        }),
      ).resolves.toMatchObject({ status: 'claimed' });

      const wakeupClaim = {
        userId: 'user123',
        conversationId,
        taskId: wakeupTaskId,
        kind: 'wakeup' as const,
        claimId: 'delivery-2',
      };
      await expect(claimSubagentTaskResult(wakeupClaim)).resolves.toMatchObject({
        status: 'acquired',
      });
      await expect(claimSubagentTaskResult(wakeupClaim)).resolves.toMatchObject({
        status: 'acquired',
      });
      await expect(
        claimSubagentTaskResult({ ...wakeupClaim, claimId: 'delivery-3' }),
      ).resolves.toMatchObject({ status: 'claimed' });
      await expect(
        claimSubagentTaskResult({ ...wakeupClaim, kind: 'manual', claimId: 'poll-2' }),
      ).resolves.toMatchObject({ status: 'claimed' });
    });

    it('preserves and upgrades retries of legacy manual claims without a kind', async () => {
      const taskId = uuidv4();
      const conversationId = uuidv4();
      await terminalResult(taskId, conversationId, 'completed');
      await claimSubagentTaskResult({
        userId: 'user123',
        conversationId,
        taskId,
        kind: 'manual',
        claimId: 'legacy-poll',
      });
      await Message.collection.updateOne(
        { user: 'user123', conversationId, messageId: `${taskId}:assistant` },
        { $unset: { 'subagentTask.resultClaim.kind': '' } },
      );

      await expect(
        claimSubagentTaskResult({
          userId: 'user123',
          conversationId,
          taskId,
          kind: 'manual',
          claimId: 'legacy-poll',
        }),
      ).resolves.toMatchObject({
        status: 'acquired',
        message: { subagentTask: { resultClaim: { kind: 'manual', claimId: 'legacy-poll' } } },
      });
      await expect(
        claimSubagentTaskResult({
          userId: 'user123',
          conversationId,
          taskId,
          kind: 'wakeup',
          claimId: 'legacy-poll',
        }),
      ).resolves.toMatchObject({ status: 'claimed' });
    });

    it('releases only the exact rejected wakeup so manual collection can take over', async () => {
      const taskId = uuidv4();
      const conversationId = uuidv4();
      await terminalResult(taskId, conversationId, 'completed');
      const wakeup = {
        userId: 'user123',
        conversationId,
        taskId,
        kind: 'wakeup' as const,
        claimId: 'delivery-1',
      };
      await expect(claimSubagentTaskResult(wakeup)).resolves.toMatchObject({
        status: 'acquired',
      });
      await expect(
        releaseSubagentTaskResultClaim({ ...wakeup, claimId: 'another-delivery' }),
      ).resolves.toBe(false);
      await expect(releaseSubagentTaskResultClaim(wakeup)).resolves.toBe(true);
      await expect(
        claimSubagentTaskResult({
          userId: 'user123',
          conversationId,
          taskId,
          kind: 'manual',
          claimId: 'poll-after-rejection',
        }),
      ).resolves.toMatchObject({ status: 'acquired' });
    });

    it('reports a result that is missing or still running as not found', async () => {
      const runningTaskId = uuidv4();
      const conversationId = uuidv4();
      await terminalResult(runningTaskId, conversationId, 'running');

      await expect(
        claimSubagentTaskResult({
          userId: 'user123',
          conversationId,
          taskId: runningTaskId,
          kind: 'manual',
          claimId: 'poll-1',
        }),
      ).resolves.toEqual({ status: 'not_found' });

      await expect(
        claimSubagentTaskResult({
          userId: 'user123',
          conversationId,
          taskId: uuidv4(),
          kind: 'manual',
          claimId: 'poll-1',
        }),
      ).resolves.toEqual({ status: 'not_found' });
    });

    it('never hands one owner’s result to another user', async () => {
      const taskId = uuidv4();
      const conversationId = uuidv4();
      await terminalResult(taskId, conversationId, 'completed');

      await expect(
        claimSubagentTaskResult({
          userId: 'other-user',
          conversationId,
          taskId,
          kind: 'manual',
          claimId: 'poll-1',
        }),
      ).resolves.toEqual({ status: 'not_found' });
    });
  });
});
