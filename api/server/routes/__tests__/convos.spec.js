const express = require('express');
const request = require('supertest');

const MOCKS = '../__test-utils__/convos-route-mocks';
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));
const {
  archiveAllHandler,
  generationJobManager,
  moderateText,
  moderatedTexts,
  messageIpLimiter,
  messageUserLimiter,
  subagentActivityHandlerInputs,
  checkpointRows,
  resetCheckpointRows,
} = require(MOCKS);

const priorLimitMessageIp = process.env.LIMIT_MESSAGE_IP;
const priorLimitMessageUser = process.env.LIMIT_MESSAGE_USER;
process.env.LIMIT_MESSAGE_IP = 'true';
process.env.LIMIT_MESSAGE_USER = 'true';

const checkpointNamespace = (id) =>
  `${require(MOCKS).ownerPrefix('test-user-123')}00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;

jest.mock('@librechat/agents', () => require(MOCKS).agents());
jest.mock('@librechat/api', () =>
  require(MOCKS).api({
    createContentFilter: jest.fn((options) => (req, res, next) => {
      const extracted = [...options.extract(req)];
      if (JSON.stringify(extracted).includes('BLOCK-CONTROL')) {
        return res.status(400).json({ error: 'content_filter_block' });
      }
      next();
    }),
    extractStoredMessageContent: jest.fn((input) => [input]),
    inspectContent: jest.fn(() => null),
    extractConversationTitleContent: jest.fn(() => []),
    contentFilterBlockResponse: jest.fn(),
    isContentFilterError: jest.fn((error) => error?.code === 'content_filter_block'),
  }),
);
jest.mock('@librechat/data-schemas', () => require(MOCKS).dataSchemas());
jest.mock('librechat-data-provider', () => require(MOCKS).dataProvider());
jest.mock('~/models', () => require(MOCKS).sharedModels());
jest.mock('~/server/middleware/requireJwtAuth', () => require(MOCKS).requireJwtAuth());
jest.mock('~/server/middleware', () => require(MOCKS).middlewarePassthrough());
jest.mock('~/server/utils/import/fork', () => require(MOCKS).forkUtils());
jest.mock('~/server/utils/import', () => require(MOCKS).importUtils());
jest.mock('~/cache/getLogStores', () => require(MOCKS).logStores());
jest.mock('~/server/routes/files/multer', () => require(MOCKS).multerSetup());
jest.mock('multer', () => require(MOCKS).multerLib());
jest.mock('~/server/services/Endpoints/azureAssistants', () => require(MOCKS).assistantEndpoint());
jest.mock('~/server/services/Endpoints/assistants', () => require(MOCKS).assistantEndpoint());
jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () =>
  require(MOCKS).subagentThreadStore(),
);
jest.mock('~/server/services/Endpoints/agents/backgroundCompletion', () => ({
  pendingBackgroundToolCompletions: { list: jest.fn() },
}));

describe('Convos Routes', () => {
  let app;
  let convosRouter;
  const {
    deleteToolCalls,
    deleteConvos,
    deleteMessages,
    getConvo,
    saveConvo,
  } = require('~/models');
  const {
    deleteOwnedAgentCheckpoints,
    deleteAllSharedLinksWithCleanup,
    deleteConvoSharedLinksWithCleanup,
  } = require('@librechat/api');
  const subagentThreadStore = require('~/server/services/Endpoints/agents/subagentThreadStore');

  beforeAll(() => {
    convosRouter = require('../convos');

    app = express();
    app.use(express.json());

    /** Mock authenticated user */
    app.use((req, res, next) => {
      req.user = { id: 'test-user-123', role: 'USER' };
      const tenantId = req.get('x-test-tenant');
      if (tenantId) {
        req.user.tenantId = tenantId;
      }
      req.config = {
        messageFilter: {
          pii: {
            starterPatterns: ['sk_prefix'],
          },
        },
        filters: {
          messages: {
            pii: {
              fields: ['text'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      next();
    });

    app.use('/api/convos', convosRouter);
  });

  afterAll(() => {
    if (priorLimitMessageIp == null) delete process.env.LIMIT_MESSAGE_IP;
    else process.env.LIMIT_MESSAGE_IP = priorLimitMessageIp;
    if (priorLimitMessageUser == null) delete process.env.LIMIT_MESSAGE_USER;
    else process.env.LIMIT_MESSAGE_USER = priorLimitMessageUser;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    moderatedTexts.length = 0;
    generationJobManager.getCleanupJob.mockResolvedValue(null);
    generationJobManager.abortJob.mockResolvedValue({ success: true });
    generationJobManager.getCleanupBlockingJobIdsForUser.mockResolvedValue([]);
    generationJobManager.getCleanupBlockingJobIdsForConversations.mockResolvedValue([]);
    resetCheckpointRows();
  });

  it('binds the activity subscription adapter to the subagent task store', () => {
    const binding = subagentActivityHandlerInputs.at(-1);
    const subscriber = { onEvent: jest.fn() };

    binding.stream.subscribe('child-thread', 'task-1', subscriber);

    expect(subagentThreadStore.subscribeActivity).toHaveBeenCalledWith(
      'child-thread',
      'task-1',
      subscriber,
    );
  });

  it('filters and moderates subagent guidance as ordinary user text before control handling', async () => {
    const response = await request(app).post('/api/convos/parent/subagents/child/control').send({
      taskId: 'task-1',
      invocationId: 'invocation-1',
      action: 'queue',
      message: 'Guide the child.',
    });

    expect(response.status).toBe(200);
    expect(messageIpLimiter).toHaveBeenCalledTimes(1);
    expect(messageUserLimiter).toHaveBeenCalledTimes(1);
    expect(moderateText).toHaveBeenCalledTimes(1);
    expect(moderatedTexts).toEqual(['Guide the child.']);

    moderateText.mockClear();
    moderatedTexts.length = 0;
    const blocked = await request(app).post('/api/convos/parent/subagents/child/control').send({
      taskId: 'task-1',
      invocationId: 'invocation-2',
      action: 'interrupt',
      message: 'BLOCK-CONTROL',
    });

    expect(blocked.status).toBe(400);
    expect(blocked.body).toEqual({ error: 'content_filter_block' });
    expect(moderateText).not.toHaveBeenCalled();

    moderateText.mockClear();
    const oversized = await request(app)
      .post('/api/convos/parent/subagents/child/control')
      .send({
        taskId: 'task-1',
        invocationId: 'invocation-3',
        action: 'queue',
        message: 'x'.repeat(4 * 1024 + 1),
      });

    expect(oversized.status).toBe(400);
    expect(oversized.body).toEqual({ error: 'Invalid subagent control request' });
    expect(moderateText).not.toHaveBeenCalled();

    const cancelled = await request(app).post('/api/convos/parent/subagents/child/control').send({
      taskId: 'task-1',
      invocationId: 'invocation-4',
      action: 'cancel',
    });

    expect(cancelled.status).toBe(200);
    expect(moderateText).not.toHaveBeenCalled();

    const crafted = await request(app)
      .post('/api/convos/parent/subagents/child/control')
      .send({
        taskId: 'task-1',
        invocationId: 'invocation-5',
        action: 'queue',
        message: 'Use only this bounded guidance.',
        answers: ['This unrelated field must not reach moderation.'],
      });

    expect(crafted.status).toBe(400);
    expect(crafted.body).toEqual({ error: 'Invalid subagent control request' });
    expect(moderateText).not.toHaveBeenCalled();
  });

  describe('GET /:conversationId', () => {
    it('returns an ordinary owned conversation', async () => {
      getConvo.mockResolvedValue({ conversationId: 'ordinary', title: 'Ordinary' });

      const response = await request(app).get('/api/convos/ordinary');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ conversationId: 'ordinary', title: 'Ordinary' });
      expect(getConvo).toHaveBeenCalledWith('test-user-123', 'ordinary');
    });

    it('returns the same not-found response for an owned child thread', async () => {
      getConvo.mockResolvedValue({
        conversationId: 'child',
        subagentThread: { parentConversationId: 'parent' },
      });

      const childResponse = await request(app).get('/api/convos/child');
      getConvo.mockResolvedValue(null);
      const missingResponse = await request(app).get('/api/convos/missing');

      expect(childResponse.status).toBe(404);
      expect(childResponse.text).toBe('');
      expect(childResponse.status).toBe(missingResponse.status);
      expect(childResponse.text).toBe(missingResponse.text);
      expect(getConvo).toHaveBeenNthCalledWith(1, 'test-user-123', 'child');
    });
  });

  describe('POST /import', () => {
    const { importConversations } = require('~/server/utils/import');

    it('passes source-aware filters into conversation import', async () => {
      importConversations.mockResolvedValue();

      const response = await request(app).post('/api/convos/import');

      expect(response.status).toBe(201);
      expect(importConversations).toHaveBeenCalledWith({
        filepath: '/tmp/test-file.json',
        requestUserId: 'test-user-123',
        userRole: 'USER',
        interfaceConfig: undefined,
        filters: {
          messages: {
            pii: {
              fields: ['text'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
        legacyPii: {
          starterPatterns: ['sk_prefix'],
        },
      });
    });

    it('returns only metadata-safe filter details for a blocked import', async () => {
      const error = Object.assign(new Error('blocked'), {
        code: 'content_filter_block',
        statusCode: 400,
        body: {
          error: 'content_filter_block',
          message: 'Submitted content contains a restricted value. Remove it and try again.',
          source: 'message',
          field: 'text',
        },
      });
      importConversations.mockRejectedValue(error);

      const response = await request(app).post('/api/convos/import');

      expect(response.status).toBe(400);
      expect(response.body).toEqual(error.body);
      expect(response.body).not.toHaveProperty('detectorId');
      expect(response.body).not.toHaveProperty('ruleId');
      expect(response.body).not.toHaveProperty('fragmentPath');
      const { logger } = require('@librechat/data-schemas');
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('returns an actionable client error for an oversized imported record', async () => {
      const message = 'Each imported conversation or message must be at most 16711680 bytes';
      const error = Object.assign(new Error(message), {
        name: 'ConversationImportError',
        code: 'invalid_request',
        statusCode: 413,
        body: { error: 'invalid_request', message },
      });
      importConversations.mockRejectedValue(error);

      const response = await request(app).post('/api/convos/import');

      expect(response.status).toBe(413);
      expect(response.body).toEqual(error.body);
      const { logger } = require('@librechat/data-schemas');
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('preserves the generic server error contract for other import failures', async () => {
      const error = new Error('invalid JSON');
      importConversations.mockRejectedValue(error);

      const response = await request(app).post('/api/convos/import');

      expect(response.status).toBe(500);
      expect(response.text).toBe('Error processing file');
      const { logger } = require('@librechat/data-schemas');
      expect(logger.error).toHaveBeenCalledWith('Error processing file', error);
    });
  });

  describe('POST /fork', () => {
    const { forkConversation } = require('~/server/utils/import/fork');

    it('passes source-aware filters into the fork preflight', async () => {
      forkConversation.mockResolvedValue({ conversation: { conversationId: 'forked-convo' } });

      const response = await request(app).post('/api/convos/fork').send({
        conversationId: 'source-convo',
        messageId: 'source-message',
      });

      expect(response.status).toBe(200);
      expect(forkConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          requestUserId: 'test-user-123',
          originalConvoId: 'source-convo',
          targetMessageId: 'source-message',
          filters: {
            messages: {
              pii: {
                fields: ['text'],
                starterPatterns: ['sk_prefix'],
              },
            },
          },
          legacyPii: {
            starterPatterns: ['sk_prefix'],
          },
        }),
      );
    });

    it('returns a raw-free 400 when cloned content is blocked', async () => {
      const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
        code: 'content_filter_block',
        statusCode: 400,
        body: {
          error: 'content_filter_block',
          message: 'Submitted content contains a restricted value. Remove it and try again.',
          source: 'message',
          field: 'text',
        },
      });
      forkConversation.mockRejectedValue(error);

      const response = await request(app).post('/api/convos/fork').send({
        conversationId: 'source-convo',
        messageId: 'source-message',
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual(error.body);
      expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    });

    it('returns an actionable client error when a cloned record is oversized', async () => {
      const message = 'Each imported conversation or message must be at most 16711680 bytes';
      const error = Object.assign(new Error(message), {
        name: 'ConversationImportError',
        code: 'invalid_request',
        statusCode: 413,
        body: { error: 'invalid_request', message },
      });
      forkConversation.mockRejectedValue(error);

      const response = await request(app).post('/api/convos/fork').send({
        conversationId: 'source-convo',
        messageId: 'source-message',
      });

      expect(response.status).toBe(413);
      expect(response.body).toEqual(error.body);
      const { logger } = require('@librechat/data-schemas');
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('POST /duplicate', () => {
    const { duplicateConversation } = require('~/server/utils/import/fork');

    it('passes source-aware filters into the duplicate preflight', async () => {
      duplicateConversation.mockResolvedValue({
        conversation: { conversationId: 'duplicated-convo' },
      });

      const response = await request(app)
        .post('/api/convos/duplicate')
        .send({ conversationId: 'source-convo' });

      expect(response.status).toBe(201);
      expect(duplicateConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'test-user-123',
          conversationId: 'source-convo',
          filters: {
            messages: {
              pii: {
                fields: ['text'],
                starterPatterns: ['sk_prefix'],
              },
            },
          },
          legacyPii: {
            starterPatterns: ['sk_prefix'],
          },
        }),
      );
    });

    it('returns a raw-free 400 when cloned content is blocked', async () => {
      const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
        code: 'content_filter_block',
        statusCode: 400,
        body: {
          error: 'content_filter_block',
          message: 'Submitted content contains a restricted value. Remove it and try again.',
          source: 'message',
          field: 'text',
        },
      });
      duplicateConversation.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/convos/duplicate')
        .send({ conversationId: 'source-convo' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual(error.body);
      expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    });

    it('returns an actionable client error when a cloned record is oversized', async () => {
      const message = 'Each imported conversation or message must be at most 16711680 bytes';
      const error = Object.assign(new Error(message), {
        name: 'ConversationImportError',
        code: 'invalid_request',
        statusCode: 413,
        body: { error: 'invalid_request', message },
      });
      duplicateConversation.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/convos/duplicate')
        .send({ conversationId: 'source-convo' });

      expect(response.status).toBe(413);
      expect(response.body).toEqual(error.body);
      const { logger } = require('@librechat/data-schemas');
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /all', () => {
    it('prunes the deleted conversations’ owned generation checkpoint scopes', async () => {
      // Generation-scoped checkpoints are removed eagerly after their ownership is proven.
      const conversationIds = ['conv-a', 'conv-b'];
      deleteConvos.mockImplementation(async (_userId, _filter, options) => {
        await options.beforeDelete?.(conversationIds);
        return { deletedCount: 2, conversationIds };
      });
      deleteToolCalls.mockResolvedValue({ deletedCount: 0 });
      deleteAllSharedLinksWithCleanup.mockResolvedValue({ deletedCount: 0 });
      generationJobManager.getCleanupJob.mockImplementation(async (conversationId) => ({
        metadata: {
          userId: 'test-user-123',
          conversationId,
          checkpointNamespace: checkpointNamespace(conversationId === 'conv-a' ? 1 : 2),
          generationProtocolVersion: 2,
        },
        status: 'complete',
        createdAt: Date.now(),
      }));

      const response = await request(app).delete('/api/convos/all');

      expect(response.status).toBe(201);
      expect(deleteOwnedAgentCheckpoints).toHaveBeenCalledWith(
        'test-user-123',
        undefined,
        undefined,
        undefined,
      );
      /** The deletion runs inside the owner admission fence, not around it. */
      expect(subagentThreadStore.withOwnerDeletionFence).toHaveBeenCalledTimes(1);
      const [fencedUserId, fencedTenantId] =
        subagentThreadStore.withOwnerDeletionFence.mock.calls[0];
      expect(fencedUserId).toBe('test-user-123');
      expect(fencedTenantId).toBeUndefined();
      expect(subagentThreadStore.cancelAndDrainForOwner).not.toHaveBeenCalled();
    });

    it('drains a paused event actor after owner-wide deletion removes its conversation', async () => {
      const createdAt = Date.now();
      generationJobManager.getCleanupBlockingJobIdsForUser.mockResolvedValue([
        'paused-event-child',
      ]);
      deleteConvos.mockResolvedValue({
        deletedCount: 1,
        conversationIds: ['paused-event-child'],
      });
      generationJobManager.getCleanupJob.mockImplementation(async (conversationId) =>
        conversationId === 'paused-event-child'
          ? {
              metadata: { userId: 'test-user-123' },
              status: 'requires_action',
              createdAt,
            }
          : null,
      );

      const response = await request(app).delete('/api/convos/all');

      expect(response.status).toBe(201);
      expect(generationJobManager.abortJob).toHaveBeenCalledWith('paused-event-child', {
        expectedCreatedAt: createdAt,
        awaitProviderDrain: true,
      });
    });

    it('drains every owner remote run before selecting the delete-all snapshot', async () => {
      const createdAt = Date.now();
      generationJobManager.getCleanupBlockingJobIdsForUser.mockResolvedValue([
        'resp-new-conversation',
      ]);
      generationJobManager.getCleanupJob.mockImplementation(async (streamId) =>
        streamId === 'resp-new-conversation'
          ? {
              conversationId: 'conversation-not-yet-persisted',
              metadata: { userId: 'test-user-123' },
              status: 'running',
              createdAt,
            }
          : null,
      );
      deleteConvos.mockResolvedValue({
        deletedCount: 1,
        conversationIds: ['conversation-not-yet-persisted'],
      });

      const response = await request(app).delete('/api/convos/all');

      expect(response.status).toBe(201);
      expect(generationJobManager.getCleanupBlockingJobIdsForUser).toHaveBeenCalledWith(
        'test-user-123',
        undefined,
      );
      expect(generationJobManager.abortJob).toHaveBeenCalledWith('resp-new-conversation', {
        expectedCreatedAt: createdAt,
        awaitProviderDrain: true,
      });
      expect(generationJobManager.abortJob.mock.invocationCallOrder[0]).toBeLessThan(
        deleteConvos.mock.invocationCallOrder[0],
      );
    });

    it('re-drains and removes persistence created during a recovered owner-fence gap', async () => {
      const createdAt = Date.now();
      generationJobManager.getCleanupBlockingJobIdsForUser
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(['resp-gap']);
      generationJobManager.getCleanupJob.mockImplementation(async (streamId) =>
        streamId === 'resp-gap'
          ? {
              metadata: {
                userId: 'test-user-123',
                conversationId: 'gap-conversation',
                checkpointNamespace: checkpointNamespace(3),
                generationProtocolVersion: 2,
              },
              status: 'running',
              createdAt,
            }
          : null,
      );
      deleteConvos
        .mockResolvedValueOnce({ deletedCount: 1, conversationIds: ['original'] })
        .mockImplementationOnce(async (_userId, _filter, options) => {
          expect(options).toEqual(
            expect.objectContaining({ allowEmpty: true, beforeDelete: expect.any(Function) }),
          );
          await options.beforeDelete?.(['gap-conversation']);
          return { deletedCount: 1, conversationIds: ['gap-conversation'] };
        });
      subagentThreadStore.withOwnerDeletionFence.mockImplementationOnce(
        async (_userId, _tenantId, deletion, recover) => {
          const result = await deletion();
          await recover();
          return result;
        },
      );

      const response = await request(app).delete('/api/convos/all');

      expect(response.status).toBe(201);
      expect(generationJobManager.abortJob).toHaveBeenCalledWith('resp-gap', {
        expectedCreatedAt: createdAt,
        awaitProviderDrain: true,
      });
      expect(
        deleteConvos.mock.calls.filter(([, filter]) => Object.keys(filter).length === 0),
      ).toHaveLength(2);
      expect(deleteMessages).toHaveBeenCalledWith({ user: 'test-user-123' });
      expect(deleteOwnedAgentCheckpoints).toHaveBeenCalledWith(
        'test-user-123',
        undefined,
        undefined,
        undefined,
      );
    });

    it('retries owner message cleanup after conversations were already removed', async () => {
      deleteConvos
        .mockResolvedValueOnce({ deletedCount: 1, conversationIds: ['original'] })
        .mockResolvedValueOnce({ deletedCount: 0, conversationIds: [] });
      deleteMessages
        .mockRejectedValueOnce(new Error('message database unavailable'))
        .mockResolvedValueOnce({ deletedCount: 1 });

      const first = await request(app).delete('/api/convos/all');
      const retry = await request(app).delete('/api/convos/all');

      expect(first.status).toBe(500);
      expect(retry.status).toBe(201);
      expect(deleteOwnedAgentCheckpoints).toHaveBeenCalledWith(
        'test-user-123',
        undefined,
        undefined,
        undefined,
      );
      expect(deleteConvos).toHaveBeenCalledWith(
        'test-user-123',
        {},
        expect.objectContaining({ allowEmpty: true }),
      );
      expect(deleteMessages).toHaveBeenLastCalledWith({ user: 'test-user-123' });
    });

    it('should delete all conversations, tool calls, and shared links for a user', async () => {
      const mockDbResponse = {
        deletedCount: 5,
        message: 'All conversations deleted successfully',
      };

      deleteConvos.mockResolvedValue(mockDbResponse);
      deleteToolCalls.mockResolvedValue({ deletedCount: 10 });
      deleteAllSharedLinksWithCleanup.mockResolvedValue({
        message: 'All shared links deleted successfully',
        deletedCount: 3,
      });

      const response = await request(app).delete('/api/convos/all');

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject(mockDbResponse);

      /** Verify deleteConvos was called with correct userId */
      expect(deleteConvos).toHaveBeenCalledWith(
        'test-user-123',
        {},
        expect.objectContaining({ beforeDelete: expect.any(Function) }),
      );
      expect(deleteConvos).toHaveBeenCalledTimes(1);

      /** Verify deleteToolCalls was called with correct userId */
      expect(deleteToolCalls).toHaveBeenCalledWith('test-user-123');
      expect(deleteToolCalls).toHaveBeenCalledTimes(1);

      /** Verify deleteAllSharedLinksWithCleanup was called with correct userId */
      expect(deleteAllSharedLinksWithCleanup).toHaveBeenCalledWith('test-user-123');
      expect(deleteAllSharedLinksWithCleanup).toHaveBeenCalledTimes(1);
    });

    it('should call deleteAllSharedLinksWithCleanup even when no conversations exist', async () => {
      const mockDbResponse = {
        deletedCount: 0,
        message: 'No conversations to delete',
      };

      deleteConvos.mockResolvedValue(mockDbResponse);
      deleteToolCalls.mockResolvedValue({ deletedCount: 0 });
      deleteAllSharedLinksWithCleanup.mockResolvedValue({
        message: 'All shared links deleted successfully',
        deletedCount: 0,
      });

      const response = await request(app).delete('/api/convos/all');

      expect(response.status).toBe(201);
      expect(deleteAllSharedLinksWithCleanup).toHaveBeenCalledWith('test-user-123');
    });

    it('should return 500 if deleteConvos fails', async () => {
      const errorMessage = 'Database connection error';
      deleteConvos.mockRejectedValue(new Error(errorMessage));

      const response = await request(app).delete('/api/convos/all');

      expect(response.status).toBe(500);
      expect(response.text).toBe('Error clearing conversations');

      /** Verify error was logged */
      const { logger } = require('@librechat/data-schemas');
      expect(logger.error).toHaveBeenCalledWith('Error clearing conversations', expect.any(Error));
    });

    it('does not delete conversations when cross-replica task draining fails', async () => {
      /** Draining happens inside the admission fence, so its failure fails the fence. */
      subagentThreadStore.withOwnerDeletionFence.mockRejectedValueOnce(
        new Error('task owner unavailable'),
      );

      const response = await request(app).delete('/api/convos/all');

      expect(response.status).toBe(500);
      expect(deleteConvos).not.toHaveBeenCalled();
      expect(deleteOwnedAgentCheckpoints).not.toHaveBeenCalled();
      expect(deleteToolCalls).not.toHaveBeenCalled();
      expect(deleteAllSharedLinksWithCleanup).not.toHaveBeenCalled();
    });

    it('should return 500 if deleteToolCalls fails', async () => {
      deleteConvos.mockResolvedValue({ deletedCount: 5 });
      deleteToolCalls.mockRejectedValue(new Error('Tool calls deletion failed'));

      const response = await request(app).delete('/api/convos/all');

      expect(response.status).toBe(500);
      expect(response.text).toBe('Error clearing conversations');
    });

    it('should return 500 if deleteAllSharedLinksWithCleanup fails', async () => {
      deleteConvos.mockResolvedValue({ deletedCount: 5 });
      deleteToolCalls.mockResolvedValue({ deletedCount: 10 });
      deleteAllSharedLinksWithCleanup.mockRejectedValue(new Error('Shared links deletion failed'));

      const response = await request(app).delete('/api/convos/all');

      expect(response.status).toBe(500);
      expect(response.text).toBe('Error clearing conversations');
    });

    it('should handle multiple users independently', async () => {
      /** First user */
      deleteConvos.mockResolvedValue({ deletedCount: 3 });
      deleteToolCalls.mockResolvedValue({ deletedCount: 5 });
      deleteAllSharedLinksWithCleanup.mockResolvedValue({ deletedCount: 2 });

      let response = await request(app).delete('/api/convos/all');

      expect(response.status).toBe(201);
      expect(deleteAllSharedLinksWithCleanup).toHaveBeenCalledWith('test-user-123');

      jest.clearAllMocks();

      /** Second user (simulate different user by modifying middleware) */
      const app2 = express();
      app2.use(express.json());
      app2.use((req, res, next) => {
        req.user = { id: 'test-user-456' };
        next();
      });
      app2.use('/api/convos', require('../convos'));

      deleteConvos.mockResolvedValue({ deletedCount: 7 });
      deleteToolCalls.mockResolvedValue({ deletedCount: 12 });
      deleteAllSharedLinksWithCleanup.mockResolvedValue({ deletedCount: 4 });

      response = await request(app2).delete('/api/convos/all');

      expect(response.status).toBe(201);
      expect(deleteAllSharedLinksWithCleanup).toHaveBeenCalledWith('test-user-456');
    });

    it('should execute deletions in correct sequence', async () => {
      const executionOrder = [];

      deleteConvos.mockImplementation(() => {
        executionOrder.push('deleteConvos');
        return Promise.resolve({ deletedCount: 5 });
      });

      deleteToolCalls.mockImplementation(() => {
        executionOrder.push('deleteToolCalls');
        return Promise.resolve({ deletedCount: 10 });
      });

      deleteAllSharedLinksWithCleanup.mockImplementation(() => {
        executionOrder.push('deleteAllSharedLinksWithCleanup');
        return Promise.resolve({ deletedCount: 3 });
      });

      await request(app).delete('/api/convos/all');

      /** Verify all three functions were called */
      expect(executionOrder).toEqual([
        'deleteConvos',
        'deleteToolCalls',
        'deleteAllSharedLinksWithCleanup',
      ]);
    });

    it('should maintain data integrity by cleaning up shared links when conversations are deleted', async () => {
      /** This test ensures that orphaned shared links are prevented */
      const mockConvosDeleted = { deletedCount: 10 };
      const mockToolCallsDeleted = { deletedCount: 15 };
      const mockSharedLinksDeleted = {
        message: 'All shared links deleted successfully',
        deletedCount: 8,
      };

      deleteConvos.mockResolvedValue(mockConvosDeleted);
      deleteToolCalls.mockResolvedValue(mockToolCallsDeleted);
      deleteAllSharedLinksWithCleanup.mockResolvedValue(mockSharedLinksDeleted);

      const response = await request(app).delete('/api/convos/all');

      expect(response.status).toBe(201);

      /** Verify that shared links cleanup was called for the same user */
      expect(deleteAllSharedLinksWithCleanup).toHaveBeenCalledWith('test-user-123');

      /** Verify no shared links remain for deleted conversations */
      expect(deleteAllSharedLinksWithCleanup).toHaveBeenCalledAfter(deleteConvos);
    });
  });

  describe('DELETE /', () => {
    it('fences the owner when DELETE / is called without a conversation filter', async () => {
      deleteConvos.mockResolvedValue({ deletedCount: 3, conversationIds: ['a', 'b', 'c'] });

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { thread_id: 'thread-abc' } });

      expect(response.status).toBe(201);
      /** An empty filter deletes everything, so it takes the same admission fence. */
      expect(subagentThreadStore.withOwnerDeletionFence).toHaveBeenCalledTimes(1);
      expect(subagentThreadStore.withOwnerDeletionFence.mock.calls[0][0]).toBe('test-user-123');
      expect(subagentThreadStore.cancelAndDrainForOwner).not.toHaveBeenCalled();
      expect(deleteConvos).toHaveBeenCalledWith(
        'test-user-123',
        {},
        expect.objectContaining({ beforeDelete: expect.any(Function) }),
      );
      expect(subagentThreadStore.withOwnerDeletionFence.mock.calls[0][3]).toEqual(
        expect.any(Function),
      );
    });

    it('drains owner remote runs before the empty-filter deletion snapshot', async () => {
      const createdAt = Date.now();
      generationJobManager.getCleanupBlockingJobIdsForUser.mockResolvedValue(['resp-new']);
      generationJobManager.getCleanupJob.mockImplementation(async (streamId) =>
        streamId === 'resp-new'
          ? { metadata: { userId: 'test-user-123' }, status: 'running', createdAt }
          : null,
      );
      deleteConvos.mockResolvedValue({
        deletedCount: 1,
        conversationIds: ['new-conversation'],
      });

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { thread_id: 'thread-abc' } });

      expect(response.status).toBe(201);
      expect(generationJobManager.abortJob).toHaveBeenCalledWith('resp-new', {
        expectedCreatedAt: createdAt,
        awaitProviderDrain: true,
      });
      expect(generationJobManager.abortJob.mock.invocationCallOrder[0]).toBeLessThan(
        deleteConvos.mock.invocationCallOrder[0],
      );
    });

    it('drains a paused event actor after an empty-filter deletion removes it', async () => {
      const createdAt = Date.now();
      deleteConvos.mockResolvedValue({
        deletedCount: 1,
        conversationIds: ['paused-event-child'],
      });
      generationJobManager.getCleanupJob.mockImplementation(async (conversationId) =>
        conversationId === 'paused-event-child'
          ? {
              metadata: { userId: 'test-user-123' },
              status: 'requires_action',
              createdAt,
            }
          : null,
      );

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { thread_id: 'thread-abc' } });

      expect(response.status).toBe(201);
      expect(generationJobManager.abortJob).toHaveBeenCalledWith('paused-event-child', {
        expectedCreatedAt: createdAt,
        awaitProviderDrain: true,
      });
    });

    it('fails closed before checkpoint pruning when generation lookup stays unavailable', async () => {
      deleteConvos.mockImplementation(async (_userId, _filter, options) => {
        await options.beforeDelete?.(['paused-event-child']);
        return {
          deletedCount: 1,
          conversationIds: ['paused-event-child'],
        };
      });
      generationJobManager.getCleanupJob.mockRejectedValue(
        new Error('generation store unavailable'),
      );

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { thread_id: 'thread-abc' } });

      expect(response.status).toBe(500);
      expect(generationJobManager.getCleanupJob).toHaveBeenCalledTimes(3);
      expect(deleteOwnedAgentCheckpoints).not.toHaveBeenCalled();
    });

    it('cancels root and descendant leases and cleans every cascaded conversation', async () => {
      deleteConvos.mockResolvedValue({
        deletedCount: 2,
        conversationIds: ['parent-conversation', 'child-conversation'],
      });
      deleteToolCalls.mockResolvedValue({ deletedCount: 1 });
      deleteConvoSharedLinksWithCleanup.mockResolvedValue({ deletedCount: 1 });

      const response = await request(app)
        .delete('/api/convos')
        .send({
          arg: { conversationId: 'parent-conversation' },
        });

      expect(response.status).toBe(201);
      /** The plan is resolved before deletion, while those rows can still be read. */
      expect(subagentThreadStore.planCancellationForConversations).toHaveBeenCalledWith(
        'test-user-123',
        ['parent-conversation'],
        undefined,
      );
      expect(
        subagentThreadStore.planCancellationForConversations.mock.invocationCallOrder[0],
      ).toBeLessThan(deleteConvos.mock.invocationCallOrder[0]);
      /** It is applied once before deletion and replayed after with the cascade. */
      expect(subagentThreadStore.cancelPlan).toHaveBeenCalledTimes(2);
      expect(subagentThreadStore.cancelPlan.mock.calls[0][1]).toBeUndefined();
      expect(subagentThreadStore.cancelPlan.mock.calls[1][1]).toEqual([
        'parent-conversation',
        'child-conversation',
      ]);
      expect(deleteToolCalls.mock.calls.map((call) => call[1])).toEqual([
        'parent-conversation',
        'child-conversation',
      ]);
      expect(deleteConvoSharedLinksWithCleanup.mock.calls.map((call) => call[1])).toEqual([
        'parent-conversation',
        'child-conversation',
      ]);
    });

    it('drains an active child generation and removes persistence that races deletion', async () => {
      const createdAt = Date.now();
      deleteConvos.mockResolvedValue({
        deletedCount: 2,
        conversationIds: ['parent-conversation', 'child-conversation'],
      });
      generationJobManager.getCleanupJob.mockImplementation(async (conversationId) =>
        conversationId === 'child-conversation'
          ? { metadata: { userId: 'test-user-123' }, status: 'running', createdAt }
          : null,
      );

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'parent-conversation' } });

      expect(response.status).toBe(201);
      expect(generationJobManager.abortJob).toHaveBeenCalledWith('child-conversation', {
        expectedCreatedAt: createdAt,
        awaitProviderDrain: true,
      });
      expect(deleteConvos).toHaveBeenNthCalledWith(
        2,
        'test-user-123',
        { conversationId: { $in: ['parent-conversation', 'child-conversation'] } },
        expect.objectContaining({ allowEmpty: true }),
      );
      expect(deleteMessages).toHaveBeenCalledWith({
        user: 'test-user-123',
        conversationId: { $in: ['parent-conversation', 'child-conversation'] },
      });
    });

    it('drains response-id runs indexed under a deleted conversation', async () => {
      const createdAt = Date.now();
      generationJobManager.getCleanupBlockingJobIdsForConversations.mockResolvedValue([
        'resp_remote-run',
      ]);
      generationJobManager.getCleanupJob.mockImplementation(async (streamId) =>
        streamId === 'resp_remote-run'
          ? { metadata: { userId: 'test-user-123' }, status: 'running', createdAt }
          : null,
      );
      deleteConvos.mockImplementationOnce(async (_userId, _filter, options) => {
        await options.beforeDelete?.(['conversation-1']);
        return { deletedCount: 1, conversationIds: ['conversation-1'] };
      });

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'conversation-1' } });

      expect(response.status).toBe(201);
      expect(generationJobManager.getCleanupBlockingJobIdsForConversations).toHaveBeenCalledWith(
        'test-user-123',
        ['conversation-1'],
        undefined,
      );
      expect(generationJobManager.abortJob).toHaveBeenCalledWith('resp_remote-run', {
        expectedCreatedAt: createdAt,
        awaitProviderDrain: true,
      });
    });

    it('preserves foreign and legacy checkpoints when conversation IDs collide', async () => {
      const conversationIds = ['conversation-1', 'child-conversation'];
      const jobs = {
        'resp-owned': {
          metadata: {
            userId: 'test-user-123',
            conversationId: 'conversation-1',
            checkpointNamespace: checkpointNamespace(4),
            generationProtocolVersion: 2,
          },
        },
        'task-owned-child': {
          metadata: {
            userId: 'test-user-123',
            conversationId: 'child-conversation',
            checkpointNamespace: checkpointNamespace(5),
            generationProtocolVersion: 2,
          },
        },
        'resp-foreign-user': {
          metadata: {
            userId: 'foreign-user',
            conversationId: 'conversation-1',
            checkpointNamespace: 'foreign-user-generation',
            generationProtocolVersion: 2,
          },
        },
        'resp-foreign-tenant': {
          metadata: {
            userId: 'test-user-123',
            tenantId: 'foreign-tenant',
            conversationId: 'conversation-1',
            checkpointNamespace: 'foreign-tenant-generation',
            generationProtocolVersion: 2,
          },
        },
        'resp-legacy': {
          metadata: {
            userId: 'test-user-123',
            conversationId: 'conversation-1',
            checkpointNamespace: '',
            generationProtocolVersion: 1,
          },
        },
      };
      resetCheckpointRows([
        { threadId: 'conversation-1', checkpointNamespace: checkpointNamespace(4) },
        {
          threadId: 'conversation-1',
          checkpointNamespace: `${checkpointNamespace(4)}|subgraph`,
        },
        { threadId: 'child-conversation', checkpointNamespace: checkpointNamespace(5) },
        { threadId: 'conversation-1', checkpointNamespace: 'foreign-user-generation' },
        { threadId: 'conversation-1', checkpointNamespace: 'foreign-tenant-generation' },
        { threadId: 'conversation-1', checkpointNamespace: '' },
      ]);
      generationJobManager.getCleanupBlockingJobIdsForConversations.mockResolvedValue(
        Object.keys(jobs),
      );
      generationJobManager.getCleanupJob.mockImplementation(async (streamId) => {
        const job = jobs[streamId];
        return job == null ? null : { ...job, status: 'complete', createdAt: Date.now() };
      });
      deleteConvos.mockImplementationOnce(async (_userId, _filter, options) => {
        await options.beforeDelete?.(conversationIds);
        return { deletedCount: 2, conversationIds };
      });

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'conversation-1' } });

      expect(response.status).toBe(201);
      expect(checkpointRows).toEqual([
        { threadId: 'conversation-1', checkpointNamespace: 'foreign-user-generation' },
        { threadId: 'conversation-1', checkpointNamespace: 'foreign-tenant-generation' },
        { threadId: 'conversation-1', checkpointNamespace: '' },
      ]);
      expect(deleteOwnedAgentCheckpoints).toHaveBeenCalledWith(
        'test-user-123',
        undefined,
        ['conversation-1', 'child-conversation'],
        undefined,
      );
    });

    it('deletes an owned checkpoint after its terminal job hash expires', async () => {
      const scope = {
        threadId: 'conversation-1',
        checkpointNamespace: checkpointNamespace(8),
      };
      resetCheckpointRows([scope]);
      deleteConvos.mockImplementationOnce(async (_userId, _filter, options) => {
        await options.beforeDelete?.(['conversation-1']);
        return { deletedCount: 1, conversationIds: ['conversation-1'] };
      });

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'conversation-1' } });

      expect(response.status).toBe(201);
      expect(checkpointRows).toEqual([]);
      expect(deleteOwnedAgentCheckpoints).toHaveBeenCalledWith(
        'test-user-123',
        undefined,
        ['conversation-1'],
        undefined,
      );
    });

    it('retains checkpoint payload when conversation deletion fails after its snapshot', async () => {
      const scope = { threadId: 'conversation-1', checkpointNamespace: checkpointNamespace(8) };
      resetCheckpointRows([scope]);
      deleteConvos.mockImplementationOnce(async (_owner, _filter, options) => {
        await options.beforeDelete(['conversation-1']);
        throw new Error('conversation deletion failed');
      });
      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'conversation-1' } });
      expect(response.status).toBe(500);
      expect(deleteOwnedAgentCheckpoints).not.toHaveBeenCalled();
      expect(checkpointRows).toEqual([scope]);
    });

    it('fails closed when saver deletion fails', async () => {
      deleteOwnedAgentCheckpoints.mockRejectedValueOnce(new Error('checkpoint store unavailable'));
      deleteConvos.mockImplementationOnce(async (_userId, _filter, options) => {
        await options.beforeDelete?.(['conversation-1']);
        return { deletedCount: 1, conversationIds: ['conversation-1'] };
      });

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'conversation-1' } });

      expect(response.status).toBe(500);
    });

    it('retries checkpoint cleanup for descendants after all conversation records are gone', async () => {
      deleteOwnedAgentCheckpoints.mockRejectedValueOnce(new Error('post-delete cleanup failed'));
      deleteConvos
        .mockImplementationOnce(async (_owner, _filter, options) => {
          await options.beforeDelete(['conversation-1', 'child-conversation']);
          return { deletedCount: 2, conversationIds: ['conversation-1', 'child-conversation'] };
        })
        .mockResolvedValue({ deletedCount: 0, conversationIds: [] });
      const first = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'conversation-1' } });
      expect(first.status).toBe(500);
      checkpointRows.push({
        threadId: 'child-conversation',
        checkpointNamespace: checkpointNamespace(13),
      });
      // Restore only a late checkpoint; the deletion intent must remain from the first request.
      const second = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'conversation-1' } });
      expect(second.status).toBe(201);
      expect(deleteOwnedAgentCheckpoints).toHaveBeenLastCalledWith(
        'test-user-123',
        undefined,
        ['conversation-1', 'child-conversation'],
        undefined,
      );
      expect(checkpointRows).toEqual([]);
    });

    it('cleans checkpoints from every cascade wave', async () => {
      const jobs = {
        'run-parent': {
          metadata: {
            userId: 'test-user-123',
            conversationId: 'parent-conversation',
            checkpointNamespace: checkpointNamespace(11),
            generationProtocolVersion: 2,
          },
        },
        'run-child': {
          metadata: {
            userId: 'test-user-123',
            conversationId: 'child-conversation',
            checkpointNamespace: checkpointNamespace(12),
            generationProtocolVersion: 2,
          },
        },
      };
      generationJobManager.getCleanupBlockingJobIdsForConversations.mockImplementation(
        async (_userId, conversationIds) =>
          conversationIds.map((conversationId) =>
            conversationId === 'parent-conversation' ? 'run-parent' : 'run-child',
          ),
      );
      generationJobManager.getCleanupJob.mockImplementation(async (streamId) => {
        const job = jobs[streamId];
        return job == null ? null : { ...job, status: 'complete', createdAt: Date.now() };
      });
      deleteConvos
        .mockImplementationOnce(async (_userId, _filter, options) => {
          await options.beforeDelete?.(['parent-conversation']);
          await options.beforeDelete?.(['child-conversation']);
          return {
            deletedCount: 2,
            conversationIds: ['parent-conversation', 'child-conversation'],
          };
        })
        .mockResolvedValueOnce({ deletedCount: 0, conversationIds: [] });

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'parent-conversation' } });

      expect(response.status).toBe(201);
      expect(deleteOwnedAgentCheckpoints).toHaveBeenCalledWith(
        'test-user-123',
        undefined,
        ['parent-conversation', 'child-conversation'],
        undefined,
      );
    });

    it('drains a tenant user legacy generation without pruning its ambiguous namespace', async () => {
      const createdAt = Date.now();
      generationJobManager.getCleanupBlockingJobIdsForConversations.mockResolvedValue([
        'legacy-run',
      ]);
      generationJobManager.getCleanupJob.mockImplementation(async (streamId) =>
        streamId === 'legacy-run'
          ? {
              metadata: {
                userId: 'test-user-123',
                conversationId: 'conversation-1',
                checkpointNamespace: 'legacy-tenant-generation',
                generationProtocolVersion: 2,
              },
              status: 'running',
              createdAt,
            }
          : null,
      );
      deleteConvos
        .mockImplementationOnce(async (_userId, _filter, options) => {
          await options.beforeDelete?.(['conversation-1']);
          return { deletedCount: 1, conversationIds: ['conversation-1'] };
        })
        .mockResolvedValueOnce({ deletedCount: 0, conversationIds: [] });

      const response = await request(app)
        .delete('/api/convos')
        .set('x-test-tenant', 'tenant-1')
        .send({ arg: { conversationId: 'conversation-1' } });

      expect(response.status).toBe(201);
      expect(generationJobManager.abortJob).toHaveBeenCalledWith('legacy-run', {
        expectedCreatedAt: createdAt,
        awaitProviderDrain: true,
      });
      expect(deleteOwnedAgentCheckpoints).toHaveBeenCalledWith(
        'test-user-123',
        'tenant-1',
        ['conversation-1'],
        undefined,
      );
    });

    it('waits for terminal response-id runs whose provider writes are undrained', async () => {
      const createdAt = Date.now();
      generationJobManager.getCleanupBlockingJobIdsForConversations.mockResolvedValue([
        'resp_terminal-run',
      ]);
      generationJobManager.getCleanupJob.mockImplementation(async (streamId) =>
        streamId === 'resp_terminal-run'
          ? {
              metadata: { userId: 'test-user-123', providerDrained: false },
              status: 'complete',
              createdAt,
            }
          : null,
      );
      deleteConvos.mockImplementationOnce(async (_userId, _filter, options) => {
        await options.beforeDelete?.(['conversation-1']);
        return { deletedCount: 1, conversationIds: ['conversation-1'] };
      });

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'conversation-1' } });

      expect(response.status).toBe(201);
      expect(generationJobManager.abortJob).toHaveBeenCalledWith('resp_terminal-run', {
        expectedCreatedAt: createdAt,
        awaitProviderDrain: true,
      });
    });

    it('catches a response-id run admitted after the pre-delete snapshot', async () => {
      const createdAt = Date.now();
      let deletionCommitted = false;
      generationJobManager.getCleanupBlockingJobIdsForConversations.mockImplementation(async () =>
        deletionCommitted ? ['resp_late-run'] : [],
      );
      generationJobManager.getCleanupJob.mockImplementation(async (streamId) =>
        streamId === 'resp_late-run'
          ? { metadata: { userId: 'test-user-123' }, status: 'running', createdAt }
          : null,
      );
      deleteConvos.mockImplementationOnce(async (_userId, _filter, options) => {
        await options.beforeDelete?.(['conversation-1']);
        deletionCommitted = true;
        return { deletedCount: 1, conversationIds: ['conversation-1'] };
      });

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'conversation-1' } });

      expect(response.status).toBe(201);
      expect(generationJobManager.getCleanupBlockingJobIdsForConversations).toHaveBeenCalledTimes(
        2,
      );
      expect(generationJobManager.abortJob).toHaveBeenCalledWith('resp_late-run', {
        expectedCreatedAt: createdAt,
        awaitProviderDrain: true,
      });
    });

    it('removes persistence even when a racing response drains before post-delete discovery', async () => {
      deleteConvos
        .mockImplementationOnce(async (_userId, _filter, options) => {
          await options.beforeDelete?.(['conversation-1']);
          return { deletedCount: 1, conversationIds: ['conversation-1'] };
        })
        .mockResolvedValueOnce({ deletedCount: 1, conversationIds: ['conversation-1'] });
      generationJobManager.getCleanupBlockingJobIdsForConversations.mockResolvedValue([]);

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'conversation-1' } });

      expect(response.status).toBe(201);
      expect(generationJobManager.abortJob).not.toHaveBeenCalled();
      expect(deleteConvos).toHaveBeenNthCalledWith(
        2,
        'test-user-123',
        { conversationId: { $in: ['conversation-1'] } },
        expect.objectContaining({ allowEmpty: true }),
      );
      expect(deleteMessages).toHaveBeenCalledWith({
        user: 'test-user-123',
        conversationId: { $in: ['conversation-1'] },
      });
    });

    it('fails closed when the idempotent remnant sweep hits a storage failure', async () => {
      deleteConvos
        .mockImplementationOnce(async (_userId, _filter, options) => {
          await options.beforeDelete?.(['conversation-1']);
          return { deletedCount: 1, conversationIds: ['conversation-1'] };
        })
        .mockRejectedValueOnce(new Error('remnant database unavailable'));

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'conversation-1' } });

      expect(response.status).toBe(500);
      expect(response.text).toBe('Error clearing conversations');
      expect(deleteOwnedAgentCheckpoints).not.toHaveBeenCalled();
    });

    it('fails closed when remnant message cleanup is unavailable', async () => {
      deleteConvos
        .mockImplementationOnce(async (_userId, _filter, options) => {
          await options.beforeDelete?.(['conversation-1']);
          return { deletedCount: 1, conversationIds: ['conversation-1'] };
        })
        .mockResolvedValueOnce({ deletedCount: 0, conversationIds: [] });
      deleteMessages.mockRejectedValueOnce(new Error('message database unavailable'));

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'conversation-1' } });

      expect(response.status).toBe(500);
      expect(response.text).toBe('Error clearing conversations');
      expect(deleteOwnedAgentCheckpoints).not.toHaveBeenCalled();
    });

    it('does not prune generation persistence when provider stop is unconfirmed', async () => {
      const createdAt = Date.now();
      let deletionCommitted = false;
      deleteConvos.mockImplementation(async (_userId, _filter, options) => {
        await options.beforeDelete?.(['child-conversation']);
        deletionCommitted = true;
        return {
          deletedCount: 2,
          conversationIds: ['parent-conversation', 'child-conversation'],
        };
      });
      generationJobManager.getCleanupJob.mockImplementation(async (conversationId) =>
        conversationId === 'child-conversation'
          ? { metadata: { userId: 'test-user-123' }, status: 'running', createdAt }
          : null,
      );
      generationJobManager.abortJob.mockResolvedValue({
        success: false,
        failureReason: 'job_still_active',
      });

      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'parent-conversation' } });

      expect(response.status).toBe(500);
      expect(deleteConvos).toHaveBeenCalledTimes(1);
      expect(deletionCommitted).toBe(false);
      expect(deleteMessages).not.toHaveBeenCalled();
    });

    it.each(['terminalPersistencePending', 'terminalHostActionPending'])(
      'drains %s only for leases removed by this deletion',
      async (marker) => {
        const createdAt = Date.now();
        deleteConvos.mockResolvedValue({
          deletedCount: 2,
          conversationIds: ['parent-conversation', 'child-conversation'],
        });
        subagentThreadStore.planCancellationForConversations.mockResolvedValueOnce({
          userId: 'test-user-123',
          conversationIds: ['parent-conversation'],
          scopes: [],
          leases: [
            {
              taskId: 'related-generation',
              parentConversationId: 'parent-conversation',
              conversationId: 'child-conversation',
            },
            {
              taskId: 'unrelated-generation',
              parentConversationId: 'other-parent',
              conversationId: 'other-child',
            },
          ],
        });
        let relatedReads = 0;
        generationJobManager.getCleanupJob.mockImplementation(async (conversationId) => {
          if (conversationId !== 'related-generation') return null;
          relatedReads += 1;
          return {
            status: 'complete',
            createdAt,
            metadata: {
              userId: 'test-user-123',
              providerDrained: true,
              [marker]: relatedReads <= 2,
            },
          };
        });

        const response = await request(app)
          .delete('/api/convos')
          .send({ arg: { conversationId: 'parent-conversation' } });

        expect(response.status).toBe(201);
        expect(generationJobManager.abortJob).toHaveBeenCalledWith('related-generation', {
          expectedCreatedAt: createdAt,
          awaitProviderDrain: true,
        });
        expect(relatedReads).toBeGreaterThanOrEqual(3);
        expect(generationJobManager.getCleanupJob).not.toHaveBeenCalledWith('unrelated-generation');
        expect(deleteConvos).toHaveBeenCalledTimes(2);
      },
    );

    it('should delete a single conversation, tool calls, and associated shared links', async () => {
      const mockConversationId = 'conv-123';
      const mockDbResponse = {
        deletedCount: 1,
        message: 'Conversation deleted successfully',
      };

      deleteConvos.mockResolvedValue(mockDbResponse);
      deleteToolCalls.mockResolvedValue({ deletedCount: 3 });
      deleteConvoSharedLinksWithCleanup.mockResolvedValue({
        message: 'Shared links deleted successfully',
        deletedCount: 1,
      });

      const response = await request(app)
        .delete('/api/convos')
        .send({
          arg: {
            conversationId: mockConversationId,
          },
        });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject(mockDbResponse);

      /** Verify deleteConvos was called with correct parameters */
      expect(deleteConvos).toHaveBeenCalledWith(
        'test-user-123',
        { conversationId: mockConversationId },
        expect.objectContaining({ beforeDelete: expect.any(Function) }),
      );

      /** Verify deleteToolCalls was called */
      expect(deleteToolCalls).toHaveBeenCalledWith('test-user-123', mockConversationId);

      /** Verify deleteConvoSharedLinksWithCleanup was called */
      expect(deleteConvoSharedLinksWithCleanup).toHaveBeenCalledWith(
        'test-user-123',
        mockConversationId,
      );
    });

    it('should not call deleteConvoSharedLinksWithCleanup when no conversationId provided', async () => {
      deleteConvos.mockResolvedValue({ deletedCount: 0 });
      deleteToolCalls.mockResolvedValue({ deletedCount: 0 });

      const response = await request(app)
        .delete('/api/convos')
        .send({
          arg: {
            source: 'button',
          },
        });

      expect(response.status).toBe(200);
      expect(deleteConvoSharedLinksWithCleanup).not.toHaveBeenCalled();
    });

    it('should handle deletion of conversation without shared links', async () => {
      const mockConversationId = 'conv-no-shares';

      deleteConvos.mockResolvedValue({ deletedCount: 1 });
      deleteToolCalls.mockResolvedValue({ deletedCount: 0 });
      deleteConvoSharedLinksWithCleanup.mockResolvedValue({
        message: 'Shared links deleted successfully',
        deletedCount: 0,
      });

      const response = await request(app)
        .delete('/api/convos')
        .send({
          arg: {
            conversationId: mockConversationId,
          },
        });

      expect(response.status).toBe(201);
      expect(deleteConvoSharedLinksWithCleanup).toHaveBeenCalledWith(
        'test-user-123',
        mockConversationId,
      );
    });

    it('should return 400 when no parameters provided', async () => {
      const response = await request(app).delete('/api/convos').send({
        arg: {},
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'no parameters provided' });
      expect(deleteConvos).not.toHaveBeenCalled();
      expect(deleteConvoSharedLinksWithCleanup).not.toHaveBeenCalled();
    });

    it('should return 400 when request body is empty (DoS prevention)', async () => {
      const response = await request(app).delete('/api/convos').send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'no parameters provided' });
      expect(deleteConvos).not.toHaveBeenCalled();
    });

    it('should return 400 when arg is null (DoS prevention)', async () => {
      const response = await request(app).delete('/api/convos').send({ arg: null });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'no parameters provided' });
      expect(deleteConvos).not.toHaveBeenCalled();
    });

    it('should return 400 when arg is undefined (DoS prevention)', async () => {
      const response = await request(app).delete('/api/convos').send({ arg: undefined });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'no parameters provided' });
      expect(deleteConvos).not.toHaveBeenCalled();
    });

    it('should return 400 when request body is null (DoS prevention)', async () => {
      const response = await request(app)
        .delete('/api/convos')
        .set('Content-Type', 'application/json')
        .send('null');

      expect(response.status).toBe(400);
      expect(deleteConvos).not.toHaveBeenCalled();
    });

    it('should return 500 if deleteConvoSharedLinksWithCleanup fails', async () => {
      const mockConversationId = 'conv-error';

      deleteConvos.mockResolvedValue({ deletedCount: 1 });
      deleteToolCalls.mockResolvedValue({ deletedCount: 2 });
      deleteConvoSharedLinksWithCleanup.mockRejectedValue(
        new Error('Failed to delete shared links'),
      );

      const response = await request(app)
        .delete('/api/convos')
        .send({
          arg: {
            conversationId: mockConversationId,
          },
        });

      expect(response.status).toBe(500);
      expect(response.text).toBe('Error clearing conversations');
    });

    it('should execute deletions in correct sequence for single conversation', async () => {
      const mockConversationId = 'conv-sequence';
      const executionOrder = [];

      deleteConvos.mockImplementation(() => {
        executionOrder.push('deleteConvos');
        return Promise.resolve({ deletedCount: 1 });
      });

      deleteToolCalls.mockImplementation(() => {
        executionOrder.push('deleteToolCalls');
        return Promise.resolve({ deletedCount: 2 });
      });

      deleteConvoSharedLinksWithCleanup.mockImplementation(() => {
        executionOrder.push('deleteConvoSharedLinksWithCleanup');
        return Promise.resolve({ deletedCount: 1 });
      });

      await request(app)
        .delete('/api/convos')
        .send({
          arg: {
            conversationId: mockConversationId,
          },
        });

      expect(executionOrder).toEqual([
        'deleteConvos',
        'deleteConvos',
        'deleteToolCalls',
        'deleteConvoSharedLinksWithCleanup',
      ]);
    });

    it('should prevent orphaned shared links when deleting single conversation', async () => {
      const mockConversationId = 'conv-with-shares';

      deleteConvos.mockResolvedValue({ deletedCount: 1 });
      deleteToolCalls.mockResolvedValue({ deletedCount: 4 });
      deleteConvoSharedLinksWithCleanup.mockResolvedValue({
        message: 'Shared links deleted successfully',
        deletedCount: 2,
      });

      const response = await request(app)
        .delete('/api/convos')
        .send({
          arg: {
            conversationId: mockConversationId,
          },
        });

      expect(response.status).toBe(201);

      /** Verify shared links were deleted for the specific conversation */
      expect(deleteConvoSharedLinksWithCleanup).toHaveBeenCalledWith(
        'test-user-123',
        mockConversationId,
      );

      /** Verify it was called after the conversation was deleted */
      expect(deleteConvoSharedLinksWithCleanup).toHaveBeenCalledAfter(deleteConvos);
    });
  });

  describe('GET / search handling', () => {
    const { getConvosByCursor } = require('~/models');

    beforeEach(() => {
      getConvosByCursor.mockResolvedValue({ conversations: [], nextCursor: null });
    });

    /** Express already percent-decodes `req.query`, so decoding a second time in the route
     * threw URIError on any term containing a bare `%` and mangled `%xx`-looking text. */
    it('accepts a search term containing a literal percent sign', async () => {
      const response = await request(app)
        .get('/api/convos')
        .query({ isArchived: 'true', search: '100% ready' });

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ search: '100% ready' }),
      );
    });

    it('passes percent-escape-looking text through without decoding it', async () => {
      const response = await request(app).get('/api/convos').query({ search: 'a%41b' });

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ search: 'a%41b' }),
      );
    });

    it('treats a whitespace-only search as no search', async () => {
      const response = await request(app).get('/api/convos').query({ search: '   ' });

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ search: undefined }),
      );
    });
  });

  describe('GET / pinned filter', () => {
    const { getConvosByCursor } = require('~/models');

    beforeEach(() => {
      getConvosByCursor.mockResolvedValue({ conversations: [], nextCursor: null });
    });

    it('forwards pinned=true so the sidebar section can fetch pins on their own', async () => {
      const response = await request(app)
        .get('/api/convos')
        .query({ pinned: 'true', limit: '100' });

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ pinned: true, limit: 100 }),
      );
    });

    it('leaves the list unfiltered when pinned is absent', async () => {
      const response = await request(app).get('/api/convos');

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ pinned: false }),
      );
    });
  });

  describe('GET / limit clamping', () => {
    const { getConvosByCursor } = require('~/models');

    beforeEach(() => {
      getConvosByCursor.mockResolvedValue({ conversations: [], nextCursor: null });
    });

    /** `parseInt('-1') || 25` kept the -1, and `.limit(-1 + 1)` is `.limit(0)`, which
     * MongoDB reads as "no limit" — one request drained the caller's whole list. */
    it('clamps a negative limit instead of forwarding it', async () => {
      const response = await request(app).get('/api/convos').query({ limit: '-1' });

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ limit: 1 }),
      );
    });

    it('caps an oversized limit at the page ceiling', async () => {
      const response = await request(app).get('/api/convos').query({ limit: '999999999' });

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ limit: 100 }),
      );
    });

    it('raises a zero limit to a single row', async () => {
      const response = await request(app).get('/api/convos').query({ limit: '0' });

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ limit: 1 }),
      );
    });

    it.each([
      ['absent', undefined],
      ['non-numeric', 'all'],
    ])('falls back to the default page size when the limit is %s', async (_label, limit) => {
      const response = await request(app)
        .get('/api/convos')
        .query(limit === undefined ? {} : { limit });

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ limit: 25 }),
      );
    });

    /** Express parses a repeated key into an array, which `parseInt` silently reads as
     * its first element's digits rather than rejecting. */
    it('clamps a repeated limit parameter', async () => {
      const response = await request(app).get('/api/convos?limit=999999&limit=5');

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ limit: 100 }),
      );
    });
  });

  describe('GET / sort normalization', () => {
    const { getConvosByCursor } = require('~/models');

    beforeEach(() => {
      getConvosByCursor.mockResolvedValue({ conversations: [], nextCursor: null });
    });

    it('forwards a whitelisted sort field and direction', async () => {
      const response = await request(app)
        .get('/api/convos')
        .query({ sortBy: 'title', sortDirection: 'asc' });

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ sortBy: 'title', sortDirection: 'asc' }),
      );
    });

    /** An unknown field reaches `getConvosByCursor`, which throws on it, so forwarding
     * a stale or hand-edited value would answer 500 instead of listing anything. */
    it('falls back to the default ordering for values it does not recognize', async () => {
      const response = await request(app)
        .get('/api/convos')
        .query({ sortBy: 'DROP TABLE', sortDirection: 'sideways' });

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ sortBy: 'updatedAt', sortDirection: 'desc' }),
      );
    });
  });

  describe('POST /archive', () => {
    it('should archive a conversation successfully', async () => {
      const mockConversationId = 'conv-123';
      const mockArchivedConvo = {
        conversationId: mockConversationId,
        title: 'Test Conversation',
        isArchived: true,
        user: 'test-user-123',
      };

      saveConvo.mockResolvedValue(mockArchivedConvo);

      const response = await request(app)
        .post('/api/convos/archive')
        .send({
          arg: {
            conversationId: mockConversationId,
            isArchived: true,
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockArchivedConvo);
      expect(saveConvo).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'test-user-123' }),
        {
          conversationId: mockConversationId,
          isArchived: true,
        },
        {
          context: `POST /api/convos/archive ${mockConversationId}`,
          preserveUpdatedAt: true,
          noUpsert: true,
        },
      );
    });

    it('should unarchive a conversation successfully', async () => {
      const mockConversationId = 'conv-456';
      const mockUnarchivedConvo = {
        conversationId: mockConversationId,
        title: 'Unarchived Conversation',
        isArchived: false,
        user: 'test-user-123',
      };

      saveConvo.mockResolvedValue(mockUnarchivedConvo);

      const response = await request(app)
        .post('/api/convos/archive')
        .send({
          arg: {
            conversationId: mockConversationId,
            isArchived: false,
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockUnarchivedConvo);
      expect(saveConvo).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'test-user-123' }),
        { conversationId: mockConversationId, isArchived: false },
        {
          context: `POST /api/convos/archive ${mockConversationId}`,
          preserveUpdatedAt: true,
          noUpsert: true,
        },
      );
    });

    it('leaves archivedAt to saveConvo so a redundant archive cannot restamp it', async () => {
      saveConvo.mockResolvedValue({ conversationId: 'conv-789', isArchived: true });

      await request(app)
        .post('/api/convos/archive')
        .send({ arg: { conversationId: 'conv-789', isArchived: true } });

      const [, data] = saveConvo.mock.calls[0];
      expect(data).not.toHaveProperty('archivedAt');
      expect(data.isArchived).toBe(true);
    });

    /** `updatedAt` stays the chat's own activity so unarchiving restores its real place
     * in the date groups; when it was filed away is recorded on `archivedAt` instead. */
    it('does not let archiving count as activity in the sidebar ordering', async () => {
      saveConvo.mockResolvedValue({ conversationId: 'conv-789', isArchived: true });

      await request(app)
        .post('/api/convos/archive')
        .send({ arg: { conversationId: 'conv-789', isArchived: true } });

      expect(saveConvo).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ preserveUpdatedAt: true }),
      );
    });

    it('should return 404 when the conversation does not exist', async () => {
      saveConvo.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/convos/archive')
        .send({ arg: { conversationId: 'missing-convo', isArchived: true } });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Conversation not found' });
      expect(saveConvo).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ noUpsert: true }),
      );
    });

    it('should return 400 when conversationId is missing', async () => {
      const response = await request(app)
        .post('/api/convos/archive')
        .send({
          arg: {
            isArchived: true,
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'conversationId is required' });
      expect(saveConvo).not.toHaveBeenCalled();
    });

    it('should return 400 when isArchived is not a boolean', async () => {
      const response = await request(app)
        .post('/api/convos/archive')
        .send({
          arg: {
            conversationId: 'conv-123',
            isArchived: 'true',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'isArchived must be a boolean' });
      expect(saveConvo).not.toHaveBeenCalled();
    });

    it('should return 400 when isArchived is undefined', async () => {
      const response = await request(app)
        .post('/api/convos/archive')
        .send({
          arg: {
            conversationId: 'conv-123',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'isArchived must be a boolean' });
      expect(saveConvo).not.toHaveBeenCalled();
    });

    it('should return 500 when saveConvo fails', async () => {
      const mockConversationId = 'conv-error';
      saveConvo.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/api/convos/archive')
        .send({
          arg: {
            conversationId: mockConversationId,
            isArchived: true,
          },
        });

      expect(response.status).toBe(500);
      expect(response.text).toBe('Error archiving conversation');

      const { logger } = require('@librechat/data-schemas');
      expect(logger.error).toHaveBeenCalledWith('Error archiving conversation', expect.any(Error));
    });

    it('should handle empty arg object', async () => {
      const response = await request(app).post('/api/convos/archive').send({
        arg: {},
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'conversationId is required' });
    });
  });

  describe('POST /archive/all', () => {
    const { archiveAllConvos } = require('~/models');

    it('delegates archive-all requests through the package API handler', async () => {
      archiveAllConvos.mockResolvedValue({ archivedCount: 4 });

      const response = await request(app).post('/api/convos/archive/all');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ archivedCount: 4 });
      expect(archiveAllHandler).toHaveBeenCalledTimes(1);
      expect(archiveAllConvos).toHaveBeenCalledWith('test-user-123');
    });
  });

  describe('POST /convos/pin', () => {
    const mockConversationId = 'conv-123';
    const { setConvoPinned } = require('~/models');

    it('should pin a conversation', async () => {
      const mockPinnedConvo = { conversationId: mockConversationId, pinned: true };
      setConvoPinned.mockResolvedValue(mockPinnedConvo);

      const response = await request(app).post('/api/convos/pin').send({ arg: mockPinnedConvo });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockPinnedConvo);
      expect(setConvoPinned).toHaveBeenCalledWith('test-user-123', mockConversationId, true);
    });

    it('should unpin a conversation', async () => {
      const mockUnpinnedConvo = { conversationId: mockConversationId, pinned: false };
      setConvoPinned.mockResolvedValue(mockUnpinnedConvo);

      const response = await request(app).post('/api/convos/pin').send({ arg: mockUnpinnedConvo });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockUnpinnedConvo);
      expect(setConvoPinned).toHaveBeenCalledWith('test-user-123', mockConversationId, false);
    });

    /** A pin is one boolean: it must not drag in `saveConvo`'s message-id refresh
     * and project-stats recompute, which cost an extra read and a large write. */
    it('does not route a pin through the full conversation save', async () => {
      setConvoPinned.mockResolvedValue({ conversationId: mockConversationId, pinned: true });

      await request(app)
        .post('/api/convos/pin')
        .send({ arg: { conversationId: mockConversationId, pinned: true } });

      expect(setConvoPinned).toHaveBeenCalledTimes(1);
      expect(saveConvo).not.toHaveBeenCalled();
    });

    it('should return 404 when the conversation does not exist', async () => {
      setConvoPinned.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/convos/pin')
        .send({ arg: { conversationId: 'missing-convo', pinned: true } });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Conversation not found' });
    });

    it('should return 400 when conversationId is missing', async () => {
      const response = await request(app)
        .post('/api/convos/pin')
        .send({ arg: { pinned: true } });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'conversationId is required' });
      expect(setConvoPinned).not.toHaveBeenCalled();
    });

    it('should return 400 when pinned is not a boolean', async () => {
      const response = await request(app)
        .post('/api/convos/pin')
        .send({ arg: { conversationId: mockConversationId, pinned: 'yes' } });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'pinned must be a boolean' });
      expect(setConvoPinned).not.toHaveBeenCalled();
    });

    it('should return 400 when pinned is missing', async () => {
      const response = await request(app)
        .post('/api/convos/pin')
        .send({ arg: { conversationId: mockConversationId } });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'pinned is required' });
      expect(setConvoPinned).not.toHaveBeenCalled();
    });

    it('should return 500 when the pin update fails', async () => {
      setConvoPinned.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/api/convos/pin')
        .send({ arg: { conversationId: mockConversationId, pinned: true } });

      expect(response.status).toBe(500);
    });
  });
});

/**
 * Custom Jest matcher to verify function call order
 */
expect.extend({
  toHaveBeenCalledAfter(received, other) {
    const receivedCalls = received.mock.invocationCallOrder;
    const otherCalls = other.mock.invocationCallOrder;

    if (receivedCalls.length === 0) {
      return {
        pass: false,
        message: () =>
          `Expected ${received.getMockName()} to have been called after ${other.getMockName()}, but ${received.getMockName()} was never called`,
      };
    }

    if (otherCalls.length === 0) {
      return {
        pass: false,
        message: () =>
          `Expected ${received.getMockName()} to have been called after ${other.getMockName()}, but ${other.getMockName()} was never called`,
      };
    }

    const lastReceivedCall = receivedCalls[receivedCalls.length - 1];
    const firstOtherCall = otherCalls[0];

    const pass = lastReceivedCall > firstOtherCall;

    return {
      pass,
      message: () =>
        pass
          ? `Expected ${received.getMockName()} not to have been called after ${other.getMockName()}`
          : `Expected ${received.getMockName()} to have been called after ${other.getMockName()}`,
    };
  },
});
