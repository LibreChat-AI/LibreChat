const { CLIENT_MESSAGE_SELECT, MEILI_SEARCH_LIMIT } = require('@librechat/data-schemas');
const express = require('express');
const request = require('supertest');

jest.mock('@librechat/agents', () => ({
  sleep: jest.fn(),
}));

jest.mock('@librechat/api', () => {
  const inspectContent = jest.fn(() => null);
  const extractChatContent = jest.fn(() => []);
  const extractStoredMessageContent = jest.fn(() => []);
  const contentFilterBlockResponse = jest.fn();
  const getContentTraversalFragments = jest.fn((error) => error.fragments ?? []);
  const isContentTraversalLimitError = jest.fn(
    (error) => error?.code === 'content_filter_uninspectable',
  );
  const isContentTraversalProtected = jest.fn(() => false);
  const assertModelBoundContent = jest.fn();
  const hasActiveFilePolicy = jest.fn(
    (filters) => filters?.files?.pii != null && filters.files.pii.starterPatterns?.length !== 0,
  );
  const resolveCanonicalFileReferences = jest.fn(async ({ input, filters }) => ({
    sanitizedInput: input,
    hydratedFiles: [],
    hydratedFilters: filters,
  }));
  const assertMutationAllowed = (extract, filters, input) => {
    let fragments;
    let traversalError;
    try {
      fragments = extract(input);
    } catch (error) {
      if (!isContentTraversalLimitError(error)) {
        throw error;
      }
      fragments = getContentTraversalFragments(error);
      traversalError = error;
    }
    const finding = inspectContent(fragments, { filters });
    if (finding != null) {
      throw Object.assign(new Error('blocked'), {
        code: 'content_filter_block',
        statusCode: 400,
        body: contentFilterBlockResponse(finding),
      });
    }
    if (traversalError != null && isContentTraversalProtected({ error: traversalError, filters })) {
      throw traversalError;
    }
  };

  return {
    /** The real helper, without loading the rest of the package this suite mocks around. */
    withoutTraceRefs: jest.requireActual('../../../../packages/api/src/langfuse/trace.ts')
      .withoutTraceRefs,
    createContentFilter: jest.fn(() => (req, res, next) => next()),
    inspectContent,
    extractChatContent,
    extractFeedbackContent: jest.fn(() => []),
    extractStoredMessageContent,
    contentFilterBlockResponse,
    getContentTraversalFragments,
    isContentTraversalLimitError,
    isContentTraversalProtected,
    assertModelBoundContent,
    hasActiveFilePolicy,
    isContentFilterError: jest.fn(
      (error) =>
        error?.code === 'content_filter_block' || error?.code === 'content_filter_uninspectable',
    ),
    resolveCanonicalFileReferences,
    assertStoredMessageBranchAllowed: jest.fn(async (input) => {
      let storedMessage = input.message;
      let resolvedFiles = [];
      if (hasActiveFilePolicy(input.filters)) {
        const inspection = await resolveCanonicalFileReferences({
          filters: input.filters,
          input: input.message,
          user: input.user,
        });
        storedMessage = inspection.sanitizedInput;
        resolvedFiles = inspection.hydratedFiles;
      }
      assertModelBoundContent({
        filters: input.filters,
        legacyPii: input.legacyPii,
        storedMessages: [storedMessage],
        resolvedFiles,
      });
    }),
    assertStoredMessageMutationAllowed: jest.fn((filters, input) =>
      assertMutationAllowed(extractStoredMessageContent, filters, input),
    ),
    assertChatMutationAllowed: jest.fn((filters, input) =>
      assertMutationAllowed(extractChatContent, filters, input),
    ),
    mergeUserSubmittedPaths: (...lists) => [...new Set(lists.flat().filter(Boolean))],
    mergeUserSubmittedMessageFieldPaths: (...lists) => {
      const seen = new Set();
      return lists.flat().filter((entry) => {
        if (entry == null) {
          return false;
        }
        const key = `${entry.field}:${entry.path}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    },
    unescapeLaTeX: jest.fn((x) => x),
    countTokens: jest.fn().mockResolvedValue(10),
    mergeQuotedTextForCount: jest.fn((text) => text),
    sendFeedbackScore: jest.fn().mockResolvedValue(undefined),
    traceIdForMessage: jest.fn((messageId) => `trace-${messageId}`),
    CHILD_THREAD_READ_ONLY_ERROR: 'Child thread is view-only.',
    isSubagentThreadWriteBlocked: jest.fn().mockResolvedValue(false),
    requireFeedbackEnabled: (req, res, next) => next(),
  };
});

jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
}));

jest.mock('~/models', () => ({
  getConvo: jest.fn(),
  saveConvo: jest.fn(),
  getMessage: jest.fn(),
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
  getConvoOwnership: jest.fn(),
  updateMessage: jest.fn(),
  deleteMessages: jest.fn(),
  getConvosQueried: jest.fn(),
  searchMessages: jest.fn(),
  getMessagesByCursor: jest.fn(),
  getFiles: jest.fn(),
}));

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(),
  replaceArtifactContent: jest.fn(),
}));

jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());

jest.mock('~/server/middleware', () => {
  const validateMessageReq = jest.fn((req, res, next) => next());
  const canReadActiveJobConversation = jest.fn().mockResolvedValue(false);
  const prepareMessageRequestValidation = jest.fn((req, res, next) => {
    req.messageRequestValidation = {
      conversationId: 'convo-1',
      shouldFetchMessages: true,
      promise: Promise.resolve({ ok: true }),
    };
    next();
  });
  const sendValidationResponse = jest.fn((res, result) => {
    if (result.send) {
      return res.status(result.status).send(result.body);
    }
    return res.status(result.status).json(result.body);
  });

  return {
    requireJwtAuth: (req, res, next) => next(),
    validateMessageReq,
    canReadActiveJobConversation,
    sendValidationResponse,
    prepareMessageRequestValidation,
    configMiddleware: (req, res, next) => {
      req.config = {
        filters: {
          messages: {
            pii: {
              starterPatterns: [],
            },
          },
          ...(req.headers['x-test-inert-file-policy'] === '1' && {
            files: { pii: { fields: ['content'], starterPatterns: [] } },
          }),
        },
      };
      next();
    },
  };
});

jest.mock('~/db/models', () => ({
  Message: {
    findOne: jest.fn(),
    find: jest.fn(),
    meiliSearch: jest.fn(),
  },
}));

describe('message route conversation ownership filters', () => {
  let app;
  const {
    getConvoOwnership,
    getMessage,
    getMessages,
    getMessagesByCursor,
    getConvosQueried,
    searchMessages,
    saveConvo,
    saveMessage,
    updateMessage,
  } = require('~/models');
  const {
    createContentFilter,
    inspectContent,
    extractChatContent,
    extractStoredMessageContent,
    contentFilterBlockResponse,
    getContentTraversalFragments,
    isContentTraversalProtected,
    assertModelBoundContent,
    hasActiveFilePolicy,
    resolveCanonicalFileReferences,
  } = require('@librechat/api');
  const {
    findAllArtifacts,
    replaceArtifactContent,
  } = require('~/server/services/Artifacts/update');
  const {
    canReadActiveJobConversation,
    prepareMessageRequestValidation,
  } = require('~/server/middleware');
  let storedMessageFilterOptions;

  const authenticatedUserId = 'user-owner-123';

  beforeAll(() => {
    const messagesRouter = require('../messages');
    storedMessageFilterOptions = createContentFilter.mock.calls[0][0];

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: authenticatedUserId };
      next();
    });
    app.use('/api/messages', messagesRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    canReadActiveJobConversation.mockResolvedValue(false);
    prepareMessageRequestValidation.mockImplementation((req, res, next) => {
      req.messageRequestValidation = {
        conversationId: 'convo-1',
        shouldFetchMessages: true,
        promise: Promise.resolve({ ok: true }),
      };
      next();
    });
  });

  it('preflights opaque content from the direct stored-message request body', () => {
    const body = { content: [{ type: 'input_file', file_data: 'opaque-data' }] };

    expect(storedMessageFilterOptions.getOpaqueFileInput({ body })).toBe(body);
    expect(storedMessageFilterOptions.getMessageRoles({ body: { role: 'system' } })).toEqual([
      'system',
    ]);
  });

  it.each([
    { name: 'marked user-submitted assistant content', isUserSubmitted: true },
    { name: 'legacy unmarked model content', isUserSubmitted: undefined },
  ])('preserves provenance when branching $name', async ({ isUserSubmitted }) => {
    getMessage.mockResolvedValue({
      messageId: 'source-message',
      conversationId: 'convo-1',
      parentMessageId: 'parent-1',
      isCreatedByUser: false,
      ...(typeof isUserSubmitted === 'boolean' && { isUserSubmitted }),
      attachments: [{ file_id: 'file-1' }],
      userSubmittedPaths: ['/content/0/text', '/content/1/text', '/attachments/0/file_id'],
      userSubmittedMessageFieldPaths: [
        { path: '/content/0/text', field: 'answer' },
        { path: '/content/1/text', field: 'decision_response' },
      ],
      content: [
        { type: 'text', text: 'Different agent content', agentId: 'agent-2' },
        { type: 'text', text: 'Assistant content', agentId: 'agent-1' },
      ],
    });
    saveMessage.mockImplementation(async (_ctx, message) => message);

    const response = await request(app).post('/api/messages/branch').send({
      messageId: 'source-message',
      agentId: 'agent-1',
    });

    expect(response.status).toBe(201);
    const savedMessage = saveMessage.mock.calls[0][1];
    if (typeof isUserSubmitted === 'boolean') {
      expect(savedMessage.isUserSubmitted).toBe(isUserSubmitted);
    } else {
      expect(savedMessage).not.toHaveProperty('isUserSubmitted');
    }
    expect(savedMessage.userSubmittedPaths).toEqual(['/attachments/0/file_id', '/content/0/text']);
    expect(savedMessage.userSubmittedMessageFieldPaths).toEqual([
      { path: '/content/0/text', field: 'decision_response' },
    ]);
  });

  it('inherits the source message retention when branching', async () => {
    const expiredAt = new Date('2030-01-01T00:00:00.000Z');
    getMessage.mockResolvedValue({
      messageId: 'source-message',
      conversationId: 'convo-1',
      parentMessageId: 'parent-1',
      isCreatedByUser: false,
      isTemporary: true,
      expiredAt,
      content: [{ type: 'text', text: 'Assistant content', agentId: 'agent-1' }],
    });
    saveMessage.mockImplementation(async (_ctx, message) => message);

    const response = await request(app).post('/api/messages/branch').send({
      messageId: 'source-message',
      agentId: 'agent-1',
    });

    expect(response.status).toBe(201);
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ isTemporary: true, expiredAt }),
      expect.any(Object),
      { context: 'POST /api/messages/branch' },
    );
  });

  it('uses the guard-loaded retention for both writes when a message spoofs the chat type', async () => {
    const expiredAt = new Date('2030-01-01T00:00:00.000Z');
    const db = require('~/models');
    db.getConvo.mockResolvedValue({ conversationId: 'convo-1', isTemporary: true, expiredAt });
    require('@librechat/api').isSubagentThreadWriteBlocked.mockImplementationOnce(
      async ({ getConvo }, { userId, conversationId }) => {
        await getConvo(userId, conversationId);
        return false;
      },
    );
    saveMessage.mockImplementation(async (_ctx, message) => message);

    const response = await request(app).post('/api/messages/convo-1').send({
      messageId: 'message-1',
      text: 'hello',
      isTemporary: false,
    });

    expect(response.status).toBe(201);
    for (const save of [saveMessage, saveConvo]) {
      expect(save).toHaveBeenLastCalledWith(
        expect.objectContaining({ isTemporary: true, expiredAt }),
        expect.any(Object),
        expect.any(Object),
      );
    }
    expect(db.getConvo).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'carries server-private context meta onto the branch',
      contextMeta: {
        calibrationRatio: 1.25,
        encoding: 'claude',
        fading: { v: 1, budgetTokens: 50_000, masked: true },
      },
    },
    { name: 'leaves context meta absent when the source has none', contextMeta: undefined },
  ])('$name', async ({ contextMeta }) => {
    getMessage.mockResolvedValue({
      messageId: 'source-message',
      conversationId: 'convo-1',
      parentMessageId: 'parent-1',
      isCreatedByUser: false,
      ...(contextMeta == null ? {} : { contextMeta }),
      content: [
        { type: 'text', text: 'Different agent content', agentId: 'agent-2' },
        { type: 'text', text: 'Assistant content', agentId: 'agent-1' },
      ],
    });
    saveMessage.mockImplementation(async (_ctx, message) => message);

    const response = await request(app).post('/api/messages/branch').send({
      messageId: 'source-message',
      agentId: 'agent-1',
    });

    expect(response.status).toBe(201);
    const savedMessage = saveMessage.mock.calls[0][1];
    if (contextMeta == null) {
      expect(savedMessage).not.toHaveProperty('contextMeta');
    } else {
      expect(savedMessage.contextMeta).toEqual(contextMeta);
    }
    /** Server-private state stays in the database; normal reads strip it, so must this response. */
    expect(response.body).not.toHaveProperty('contextMeta');
    expect(response.body.messageId).toBe(savedMessage.messageId);
  });

  it('does not hydrate branch files for an inert file policy', async () => {
    getMessage.mockResolvedValue({
      messageId: 'source-message',
      conversationId: 'convo-1',
      parentMessageId: 'parent-1',
      isCreatedByUser: false,
      content: [{ type: 'text', text: 'Assistant content', agentId: 'agent-1' }],
    });
    saveMessage.mockImplementation(async (_ctx, message) => message);

    const response = await request(app)
      .post('/api/messages/branch')
      .set('x-test-inert-file-policy', '1')
      .send({ messageId: 'source-message', agentId: 'agent-1' });

    expect(response.status).toBe(201);
    expect(hasActiveFilePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        files: { pii: { fields: ['content'], starterPatterns: [] } },
      }),
    );
    expect(resolveCanonicalFileReferences).not.toHaveBeenCalled();
  });

  it('rechecks branched user-authored content under the current policy before saving', async () => {
    getMessage.mockResolvedValue({
      messageId: 'source-message',
      conversationId: 'convo-1',
      parentMessageId: 'parent-1',
      isCreatedByUser: false,
      userSubmittedPaths: ['/content/0/text'],
      content: [{ type: 'text', text: 'PRIVATE-BRANCH', agentId: 'agent-1' }],
    });
    const filterError = Object.assign(new Error('blocked'), {
      code: 'content_filter_block',
      statusCode: 400,
      body: {
        error: 'content_filter_block',
        message: 'Submitted content is not allowed.',
        source: 'message',
        field: 'content_part',
      },
    });
    assertModelBoundContent.mockImplementationOnce(() => {
      throw filterError;
    });

    const response = await request(app).post('/api/messages/branch').send({
      messageId: 'source-message',
      agentId: 'agent-1',
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(filterError.body);
    expect(assertModelBoundContent).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.any(Object),
        storedMessages: [
          expect.objectContaining({
            userSubmittedPaths: ['/content/0/text'],
            content: [{ type: 'text', text: 'PRIVATE-BRANCH' }],
          }),
        ],
      }),
    );
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('should pass only mutable conversation fields to saveConvo', async () => {
    const urlConversationId = '11111111-1111-4111-8111-111111111111';
    const bodyConversationId = '22222222-2222-4222-8222-222222222222';
    const savedMessage = {
      _id: 'message-object-id',
      __v: 0,
      messageId: 'message-1',
      conversationId: urlConversationId,
      text: 'hello',
      endpoint: 'openAI',
      model: 'gpt-5',
      iconURL: 'https://example.com/icon.png',
      isTemporary: false,
      files: [{ file_id: 'file-1' }],
      user: authenticatedUserId,
      /** An existing server-authored row keeps its stored state through the update. */
      contextMeta: {
        calibrationRatio: 1.2,
        encoding: 'claude',
        fading: { v: 1, budgetTokens: 50_000, masked: true },
      },
    };

    saveMessage.mockResolvedValue(savedMessage);
    saveConvo.mockResolvedValue({ conversationId: urlConversationId });

    const response = await request(app)
      .post(`/api/messages/${urlConversationId}`)
      .send({
        messageId: savedMessage.messageId,
        conversationId: bodyConversationId,
        text: savedMessage.text,
        endpoint: savedMessage.endpoint,
        model: savedMessage.model,
        iconURL: savedMessage.iconURL,
        isUserSubmitted: false,
        userSubmittedPaths: ['/forged/model/output'],
        userSubmittedMessageFieldPaths: [
          { path: '/forged/model/output', field: 'decision_reason' },
        ],
        contextMeta: {
          calibrationRatio: 1,
          encoding: 'claude',
          fading: { v: 1, budgetTokens: 1, masked: true },
        },
        langfuseSampled: true,
        langfuseDestinationIds: ['forged-destination'],
        langfuseRunId: 'someone-elses-run',
      });

    expect(response.status).toBe(201);
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: authenticatedUserId }),
      expect.objectContaining({
        messageId: savedMessage.messageId,
        conversationId: urlConversationId,
        text: savedMessage.text,
        isUserSubmitted: true,
        user: authenticatedUserId,
      }),
      { context: 'POST /api/messages/:conversationId' },
    );
    expect(saveMessage.mock.calls[0][1].conversationId).not.toBe(bodyConversationId);
    expect(saveMessage.mock.calls[0][1]).not.toHaveProperty('userSubmittedPaths');
    expect(saveMessage.mock.calls[0][1]).not.toHaveProperty('userSubmittedMessageFieldPaths');
    expect(saveMessage.mock.calls[0][1]).not.toHaveProperty('contextMeta');
    expect(saveMessage.mock.calls[0][1].langfuseSampled).toBe(false);
    expect(saveMessage.mock.calls[0][1]).not.toHaveProperty('langfuseDestinationIds');
    expect(saveMessage.mock.calls[0][1]).not.toHaveProperty('langfuseRunId');
    expect(response.body.messageId).toBe(savedMessage.messageId);
    expect(response.body).not.toHaveProperty('contextMeta');
    expect(saveConvo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: authenticatedUserId }),
      {
        conversationId: urlConversationId,
        endpoint: savedMessage.endpoint,
        model: savedMessage.model,
        iconURL: savedMessage.iconURL,
      },
      {
        context: 'POST /api/messages/:conversationId',
        appendMessageIds: [savedMessage._id],
      },
    );
  });

  it('should filter conversation message reads by authenticated user', async () => {
    getMessages.mockResolvedValue([{ messageId: 'message-1', conversationId: 'convo-1' }]);

    const response = await request(app).get('/api/messages/convo-1');

    expect(response.status).toBe(200);
    expect(getMessages).toHaveBeenCalledWith(
      { conversationId: 'convo-1', user: authenticatedUserId },
      CLIENT_MESSAGE_SELECT,
    );
  });

  it.each([
    {
      name: 'default',
      query: 'search=needle',
      searchLimit: 25,
      conversationLimit: 25,
    },
    {
      name: 'custom',
      query: 'search=needle&pageSize=40',
      searchLimit: 40,
      conversationLimit: 40,
    },
    {
      name: 'capped',
      query: `search=needle&pageSize=${MEILI_SEARCH_LIMIT + 1}`,
      searchLimit: MEILI_SEARCH_LIMIT,
      conversationLimit: MEILI_SEARCH_LIMIT + 1,
    },
    {
      name: 'invalid',
      query: 'search=needle&pageSize=-1',
      searchLimit: 25,
      conversationLimit: 25,
    },
  ])(
    'uses the $name page size for message search limits',
    async ({ query, searchLimit, conversationLimit }) => {
      searchMessages.mockResolvedValue({ hits: [] });
      getConvosQueried.mockResolvedValue({ convoMap: {} });
      getMessages.mockResolvedValue([]);

      const response = await request(app).get(`/api/messages?${query}`);

      expect(response.status).toBe(200);
      expect(searchMessages).toHaveBeenCalledWith(
        'needle',
        { filter: `user = "${authenticatedUserId}"`, limit: searchLimit },
        true,
      );
      expect(getConvosQueried).toHaveBeenCalledWith(
        authenticatedUserId,
        [],
        null,
        conversationLimit,
      );
    },
  );

  it('strips server-private context meta from hydrated search hits', async () => {
    searchMessages.mockResolvedValue({
      hits: [
        {
          messageId: 'hit-1',
          conversationId: 'convo-1',
          text: 'needle in a haystack',
          contextMeta: {
            calibrationRatio: 1.2,
            encoding: 'claude',
            fading: { v: 1, budgetTokens: 50_000, masked: true },
          },
        },
      ],
    });
    getConvosQueried.mockResolvedValue({
      convoMap: { 'convo-1': { title: 'Found', model: 'gpt-4' } },
    });
    getMessages.mockResolvedValue([
      { messageId: 'hit-1', isCreatedByUser: false, endpoint: 'agents', iconURL: null },
    ]);

    const response = await request(app).get('/api/messages?search=needle');

    expect(response.status).toBe(200);
    expect(response.body.messages).toHaveLength(1);
    expect(response.body.messages[0]).toMatchObject({ messageId: 'hit-1', title: 'Found' });
    expect(response.body.messages[0]).not.toHaveProperty('contextMeta');
  });

  it('returns indistinguishable not-found responses for child and missing query reads', async () => {
    getConvoOwnership.mockResolvedValueOnce({
      user: authenticatedUserId,
      subagentThread: { parentConversationId: 'parent-convo' },
    });

    const childResponse = await request(app).get(
      '/api/messages?conversationId=child-convo&messageId=child-message',
    );
    getConvoOwnership.mockResolvedValueOnce(null);
    const missingResponse = await request(app).get(
      '/api/messages?conversationId=missing-convo&messageId=missing-message',
    );

    expect(childResponse.status).toBe(404);
    expect(childResponse.body).toEqual({ error: 'Conversation not found' });
    expect(childResponse.status).toBe(missingResponse.status);
    expect(childResponse.body).toEqual(missingResponse.body);
    expect(getMessages).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: 'single-message',
      path: '/api/messages?conversationId=convo-1&messageId=message-1',
      readMock: getMessages,
      readResult: [{ messageId: 'message-1', conversationId: 'convo-1' }],
    },
    {
      name: 'cursor',
      path: '/api/messages?conversationId=convo-1',
      readMock: getMessagesByCursor,
      readResult: { messages: [], nextCursor: null },
    },
  ])(
    'starts the $name query read before ownership validation resolves',
    async ({ path, readMock, readResult }) => {
      const events = [];
      let resolveOwnership;
      const ownershipPromise = new Promise((resolve) => {
        resolveOwnership = resolve;
      });
      getConvoOwnership.mockImplementationOnce(() => {
        events.push('ownership-started');
        return ownershipPromise;
      });

      let resolveReadStarted;
      const readStartedPromise = new Promise((resolve) => {
        resolveReadStarted = resolve;
      });
      readMock.mockImplementationOnce(() => {
        events.push('messages-started');
        resolveReadStarted();
        return Promise.resolve(readResult);
      });

      const responsePromise = new Promise((resolve, reject) => {
        request(app)
          .get(path)
          .end((error, response) => (error ? reject(error) : resolve(response)));
      });

      await Promise.race([readStartedPromise, new Promise((resolve) => setTimeout(resolve, 100))]);
      const eventsBeforeValidation = [...events];
      resolveOwnership({ user: authenticatedUserId });
      const response = await responsePromise;

      expect(eventsBeforeValidation).toEqual(['ownership-started', 'messages-started']);
      expect(response.status).toBe(200);
    },
  );

  it('allows an ordinary owned conversation query read', async () => {
    getConvoOwnership.mockResolvedValue({ user: authenticatedUserId });
    getMessages.mockResolvedValue([{ messageId: 'message-1', conversationId: 'convo-1' }]);

    const response = await request(app).get(
      '/api/messages?conversationId=convo-1&messageId=message-1',
    );

    expect(response.status).toBe(200);
    expect(response.body.messages).toEqual([{ messageId: 'message-1', conversationId: 'convo-1' }]);
  });

  it('allows an owner-scoped active generation before its conversation row exists', async () => {
    getConvoOwnership.mockResolvedValue(null);
    canReadActiveJobConversation.mockResolvedValue(true);
    getMessagesByCursor.mockResolvedValue({
      messages: [{ messageId: 'prompt-1', conversationId: 'active-convo' }],
      nextCursor: null,
    });

    const response = await request(app).get('/api/messages?conversationId=active-convo');

    expect(response.status).toBe(200);
    expect(response.body.messages).toEqual([
      { messageId: 'prompt-1', conversationId: 'active-convo' },
    ]);
    expect(canReadActiveJobConversation).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: authenticatedUserId } }),
      'active-convo',
    );
    /** The paginated read projects like every other client read, so persisted
     *  `contextMeta` never reaches the client through this endpoint. */
    expect(getMessagesByCursor).toHaveBeenCalledWith(
      { conversationId: 'active-convo', user: authenticatedUserId },
      expect.objectContaining({ select: CLIENT_MESSAGE_SELECT }),
    );
  });

  it('projects a single-message query read like every other client read', async () => {
    getConvoOwnership.mockResolvedValue({ conversationId: 'convo-1' });
    getMessages.mockResolvedValue([{ messageId: 'message-1', conversationId: 'convo-1' }]);

    const response = await request(app).get(
      '/api/messages?conversationId=convo-1&messageId=message-1',
    );

    expect(response.status).toBe(200);
    expect(getMessages).toHaveBeenCalledWith(
      { conversationId: 'convo-1', messageId: 'message-1', user: authenticatedUserId },
      CLIENT_MESSAGE_SELECT,
    );
  });

  it('should start conversation message reads before validation resolves', async () => {
    const events = [];
    let resolveValidation;
    const validationPromise = new Promise((resolve) => {
      resolveValidation = resolve;
    });
    prepareMessageRequestValidation.mockImplementationOnce((req, res, next) => {
      req.messageRequestValidation = {
        conversationId: 'convo-1',
        shouldFetchMessages: true,
        promise: validationPromise,
      };
      next();
    });
    let resolveMessagesStarted;
    const messagesStartedPromise = new Promise((resolve) => {
      resolveMessagesStarted = resolve;
    });
    getMessages.mockImplementation(() => {
      events.push('messages-started');
      resolveMessagesStarted();
      return Promise.resolve([{ messageId: 'message-1', conversationId: 'convo-1' }]);
    });

    const responsePromise = new Promise((resolve, reject) => {
      request(app)
        .get('/api/messages/convo-1')
        .end((error, response) => (error ? reject(error) : resolve(response)));
    });
    await Promise.race([
      messagesStartedPromise,
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);

    const eventsBeforeValidation = [...events];
    resolveValidation({ ok: true });
    const response = await responsePromise;

    expect(eventsBeforeValidation).toEqual(['messages-started']);
    expect(getMessages).toHaveBeenCalledWith(
      { conversationId: 'convo-1', user: authenticatedUserId },
      CLIENT_MESSAGE_SELECT,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ messageId: 'message-1', conversationId: 'convo-1' }]);
  });

  it('should not return fetched messages when conversation validation fails', async () => {
    prepareMessageRequestValidation.mockImplementationOnce((req, res, next) => {
      req.messageRequestValidation = {
        conversationId: 'convo-1',
        shouldFetchMessages: true,
        promise: Promise.resolve({
          ok: false,
          status: 404,
          body: { error: 'Conversation not found' },
        }),
      };
      next();
    });
    getMessages.mockResolvedValue([{ messageId: 'secret-message', conversationId: 'convo-1' }]);

    const response = await request(app).get('/api/messages/convo-1');

    expect(getMessages).toHaveBeenCalledWith(
      { conversationId: 'convo-1', user: authenticatedUserId },
      CLIENT_MESSAGE_SELECT,
    );
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Conversation not found' });
  });

  it('should filter single message reads by authenticated user', async () => {
    getMessages.mockResolvedValue([{ messageId: 'message-1', conversationId: 'convo-1' }]);

    const response = await request(app).get('/api/messages/convo-1/message-1');

    expect(response.status).toBe(200);
    expect(getMessages).toHaveBeenCalledWith(
      { conversationId: 'convo-1', messageId: 'message-1', user: authenticatedUserId },
      CLIENT_MESSAGE_SELECT,
    );
  });

  it('should classify indexed text edits as message content parts', async () => {
    getMessages.mockResolvedValue([
      {
        conversationId: 'convo-1',
        content: [{ type: 'text', text: 'old content' }],
        tokenCount: 10,
        userSubmittedPaths: ['/summary'],
      },
    ]);
    updateMessage.mockResolvedValue({ messageId: 'message-1' });

    const response = await request(app).put('/api/messages/convo-1/message-1').send({
      text: 'new content',
      index: 0,
      model: 'test-model',
    });

    expect(response.status).toBe(200);
    expect(extractStoredMessageContent).toHaveBeenCalledWith({
      content: [{ text: 'new content' }],
    });
    expect(updateMessage).toHaveBeenCalledWith(authenticatedUserId, {
      messageId: 'message-1',
      content: [{ type: 'text', text: 'new content' }],
      tokenCount: 10,
      userSubmittedPaths: ['/summary', '/content/0/text'],
    });
  });

  it('marks direct assistant text edits as user-submitted', async () => {
    getMessages.mockResolvedValue([
      {
        conversationId: 'convo-1',
        isCreatedByUser: false,
        quotes: [],
        userSubmittedPaths: ['/content/0/text'],
      },
    ]);
    updateMessage.mockResolvedValue({ messageId: 'message-1' });

    const response = await request(app).put('/api/messages/convo-1/message-1').send({
      text: 'User replacement for assistant prose',
      model: 'test-model',
    });

    expect(response.status).toBe(200);
    expect(updateMessage).toHaveBeenCalledWith(authenticatedUserId, {
      messageId: 'message-1',
      text: 'User replacement for assistant prose',
      tokenCount: 10,
      userSubmittedPaths: ['/content/0/text', '/text'],
    });
  });

  it('filters the finalized indexed edit without rescanning persisted siblings', async () => {
    const finding = {
      detectorId: 'pii-pattern',
      ruleId: 'assembled-secret',
      label: 'assembled secret',
      source: 'assembled_context',
      field: 'assembled_context',
    };
    getMessages.mockResolvedValue([
      {
        conversationId: 'convo-1',
        content: [
          { type: 'text', text: 'api-key:' },
          { type: 'text', text: 'old value' },
        ],
        tokenCount: 10,
      },
    ]);
    inspectContent.mockReturnValueOnce(null).mockReturnValueOnce(finding);
    contentFilterBlockResponse.mockReturnValue({
      error: 'content_filter_block',
      message: 'Submitted content is blocked.',
      source: 'assembled_context',
      field: 'assembled_context',
    });

    const response = await request(app).put('/api/messages/convo-1/message-1').send({
      text: 'secret',
      index: 1,
      model: 'test-model',
    });

    expect(response.status).toBe(400);
    expect(extractStoredMessageContent).toHaveBeenLastCalledWith({
      content: [{ type: 'text', text: 'secret' }],
    });
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('filters partial fragments when indexed stored-message traversal exceeds its bound', async () => {
    const partialFragment = {
      id: 'stored-message.content.1.nested.0',
      path: '/content/1/output/secret',
      text: 'PRIVATE-PARTIAL',
      source: 'message',
      field: 'content_part',
      format: 'plain',
      treatment: 'send',
    };
    const traversalError = Object.assign(new Error('Traversal limit exceeded'), {
      code: 'content_filter_uninspectable',
      statusCode: 400,
      body: {
        error: 'content_filter_uninspectable',
        message: 'Submitted content could not be completely inspected before processing.',
        source: 'message',
        field: 'content_part',
      },
      fragments: [partialFragment],
    });
    const finding = {
      detectorId: 'pii-pattern',
      ruleId: 'partial-secret',
      label: 'protected value',
      source: 'message',
      field: 'content_part',
    };
    getMessages.mockResolvedValue([
      {
        conversationId: 'convo-1',
        content: [
          { type: 'text', text: 'old content' },
          { type: 'text', text: 'existing output' },
        ],
        tokenCount: 10,
      },
    ]);
    extractStoredMessageContent.mockReturnValueOnce([]).mockImplementationOnce(() => {
      throw traversalError;
    });
    inspectContent.mockReturnValueOnce(null).mockReturnValueOnce(finding);
    contentFilterBlockResponse.mockReturnValue({
      error: 'content_filter_block',
      message: 'Submitted content is blocked.',
      source: 'message',
      field: 'content_part',
    });

    const response = await request(app).put('/api/messages/convo-1/message-1').send({
      text: 'replacement',
      index: 0,
      model: 'test-model',
    });

    expect(response.status).toBe(400);
    expect(getContentTraversalFragments).toHaveBeenCalledWith(traversalError);
    expect(inspectContent).toHaveBeenLastCalledWith([partialFragment], {
      filters: expect.any(Object),
    });
    expect(isContentTraversalProtected).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('allows indexed edits when a bounded traversal only affects unprotected scopes', async () => {
    const traversalError = Object.assign(new Error('Traversal limit exceeded'), {
      code: 'content_filter_uninspectable',
      statusCode: 400,
      body: {
        error: 'content_filter_uninspectable',
        message: 'Submitted content could not be completely inspected before processing.',
        source: 'tool_argument',
        field: 'output',
      },
      fragments: [],
    });
    getMessages.mockResolvedValue([
      {
        conversationId: 'convo-1',
        content: [
          { type: 'text', text: 'old content' },
          { type: 'text', text: 'existing output' },
        ],
        tokenCount: 10,
      },
    ]);
    updateMessage.mockResolvedValue({ messageId: 'message-1' });
    extractStoredMessageContent.mockReturnValueOnce([]).mockImplementationOnce(() => {
      throw traversalError;
    });
    isContentTraversalProtected.mockReturnValueOnce(false);

    const response = await request(app).put('/api/messages/convo-1/message-1').send({
      text: 'replacement',
      index: 0,
      model: 'test-model',
    });

    expect(response.status).toBe(200);
    expect(isContentTraversalProtected).toHaveBeenCalledWith({
      error: traversalError,
      filters: expect.any(Object),
    });
    expect(updateMessage).toHaveBeenCalled();
  });

  it('filters the final artifact text assembled from existing and submitted content', async () => {
    const finding = {
      detectorId: 'pii-pattern',
      ruleId: 'secret',
      label: 'protected value',
      source: 'message',
      field: 'content_part',
    };
    getMessage.mockResolvedValue({
      conversationId: 'convo-1',
      content: [{ type: 'text', text: 'existing artifact' }],
      text: '',
      userSubmittedPaths: ['/content/1/steer'],
    });
    findAllArtifacts.mockReturnValue([{ source: 'content', partIndex: 0 }]);
    replaceArtifactContent.mockReturnValue('sk-secret');
    inspectContent.mockReturnValueOnce(null).mockReturnValueOnce(finding);
    contentFilterBlockResponse.mockReturnValue({
      error: 'content_filter_block',
      message: 'Submitted content is blocked.',
      source: 'message',
      field: 'content_part',
    });

    const response = await request(app).post('/api/messages/artifact/message-1').send({
      index: 0,
      original: 'existing',
      updated: 'secret',
    });

    expect(response.status).toBe(400);
    expect(extractStoredMessageContent).toHaveBeenLastCalledWith({
      content: [{ text: 'sk-secret' }],
    });
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('returns a raw-free traversal response when artifact content cannot be fully inspected', async () => {
    const traversalError = Object.assign(new Error('Traversal limit exceeded'), {
      code: 'content_filter_uninspectable',
      statusCode: 400,
      body: {
        error: 'content_filter_uninspectable',
        message: 'Submitted content could not be completely inspected before processing.',
        source: 'message',
        field: 'content_part',
      },
      fragments: [],
    });
    getMessage.mockResolvedValue({
      conversationId: 'convo-1',
      content: [{ type: 'text', text: 'existing artifact' }],
      text: '',
    });
    findAllArtifacts.mockReturnValue([{ source: 'content', partIndex: 0 }]);
    replaceArtifactContent.mockReturnValue('updated artifact');
    extractStoredMessageContent.mockReturnValueOnce([]).mockImplementationOnce(() => {
      throw traversalError;
    });
    isContentTraversalProtected.mockReturnValueOnce(true);

    const response = await request(app).post('/api/messages/artifact/message-1').send({
      index: 0,
      original: 'existing',
      updated: 'replacement',
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(traversalError.body);
    expect(response.text).not.toContain('updated artifact');
    expect(isContentTraversalProtected).toHaveBeenCalledWith({
      error: traversalError,
      filters: expect.any(Object),
    });
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('marks successful assistant artifact edits as user-submitted', async () => {
    getMessage.mockResolvedValue({
      conversationId: 'convo-1',
      content: [{ type: 'text', text: 'existing artifact' }],
      text: '',
      userSubmittedPaths: ['/content/1/steer'],
    });
    findAllArtifacts.mockReturnValue([{ source: 'content', partIndex: 0 }]);
    replaceArtifactContent.mockReturnValue('updated artifact');
    saveMessage.mockImplementation(async (_ctx, message) => message);

    const response = await request(app).post('/api/messages/artifact/message-1').send({
      index: 0,
      original: 'existing',
      updated: 'updated',
    });

    expect(response.status).toBe(200);
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: authenticatedUserId }),
      expect.objectContaining({
        messageId: 'message-1',
        content: [{ type: 'text', text: 'updated artifact' }],
        userSubmittedPaths: ['/content/1/steer', '/content/0/text'],
      }),
      { context: 'POST /api/messages/artifact/:messageId' },
    );
  });

  it('filters edited text after recombining persisted user quotes', async () => {
    const finding = {
      detectorId: 'pii-pattern',
      ruleId: 'assembled-secret',
      label: 'assembled secret',
      source: 'assembled_context',
      field: 'assembled_context',
    };
    getMessages.mockResolvedValue([
      {
        conversationId: 'convo-1',
        quotes: ['api-key:'],
        isCreatedByUser: true,
      },
    ]);
    inspectContent.mockReturnValueOnce(null).mockReturnValueOnce(finding);
    contentFilterBlockResponse.mockReturnValue({
      error: 'content_filter_block',
      message: 'Submitted content is blocked.',
      source: 'assembled_context',
      field: 'assembled_context',
    });

    const response = await request(app).put('/api/messages/convo-1/message-1').send({
      text: 'secret',
      model: 'test-model',
    });

    expect(response.status).toBe(400);
    expect(extractChatContent).toHaveBeenCalledWith({
      text: 'secret',
      quotes: ['api-key:'],
    });
    expect(updateMessage).not.toHaveBeenCalled();
  });
});
