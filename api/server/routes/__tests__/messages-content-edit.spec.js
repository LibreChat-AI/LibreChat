const express = require('express');
const request = require('supertest');
const { ContentTypes } = require('librechat-data-provider');

jest.mock('@librechat/agents', () => ({
  sleep: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  unescapeLaTeX: jest.fn((value) => value),
  countTokens: jest.fn().mockResolvedValue(2),
  createContentFilter: jest.fn(() => (_req, _res, next) => next()),
  sendFeedbackScore: jest.fn().mockResolvedValue(undefined),
  traceIdForMessage: jest.fn((messageId) => `trace-${messageId}`),
  mergeQuotedTextForCount: jest.fn((text) => text),
  assertStoredMessageMutationAllowed: jest.fn(),
  assertChatMutationAllowed: jest.fn(),
  assertStoredMessageBranchAllowed: jest.fn(),
  mergeUserSubmittedPaths: (...lists) => [...new Set(lists.flat().filter(Boolean))],
  mergeUserSubmittedMessageFieldPaths: (...lists) => lists.flat().filter(Boolean),
  isContentFilterError: jest.fn(() => false),
  CHILD_THREAD_READ_ONLY_ERROR: 'Child thread is view-only.',
  isSubagentThreadWriteBlocked: jest.fn().mockResolvedValue(false),
  requireFeedbackEnabled: (req, res, next) => next(),
  applyForcedRetention: jest.fn(),
}));

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

jest.mock('~/models', () => ({
  saveConvo: jest.fn(),
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
  updateMessage: jest.fn(),
}));

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(),
  replaceArtifactContent: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  validateMessageReq: (req, res, next) => next(),
  configMiddleware: (req, res, next) => next(),
  sendValidationResponse: jest.fn(),
  prepareMessageRequestValidation: jest.fn(),
}));

describe('PUT /:conversationId/:messageId content edit', () => {
  let app;
  const { getMessages, saveConvo, saveMessage, updateMessage } = require('~/models');
  const { assertStoredMessageMutationAllowed } = require('@librechat/api');

  beforeAll(() => {
    const messagesRouter = require('../messages');
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 'user-1' };
      next();
    });
    app.use('/api/messages', messagesRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    updateMessage.mockResolvedValue({ messageId: 'message-1' });
    saveMessage.mockResolvedValue({ messageId: 'message-1', conversationId: 'conversation-1' });
    saveConvo.mockResolvedValue({ conversationId: 'conversation-1' });
  });

  it('preserves content-part metadata when editing its text', async () => {
    getMessages.mockResolvedValue([
      {
        conversationId: 'conversation-1',
        tokenCount: 10,
        content: [
          {
            type: ContentTypes.TEXT,
            text: 'Original response',
            phase: 'commentary',
            agentId: 'agent-1',
            tool_call_ids: ['tool-1'],
          },
        ],
      },
    ]);

    const response = await request(app)
      .put('/api/messages/conversation-1/message-1')
      .send({ index: 0, text: 'Edited response', model: 'gpt-5' });

    expect(response.status).toBe(200);
    expect(updateMessage).toHaveBeenCalledWith('user-1', {
      messageId: 'message-1',
      tokenCount: 10,
      content: [
        {
          type: ContentTypes.TEXT,
          text: 'Edited response',
          phase: 'commentary',
          agentId: 'agent-1',
          tool_call_ids: ['tool-1'],
        },
      ],
      userSubmittedPaths: ['/content/0/text'],
    });
  });

  it('inspects the finalized edited part without reclassifying untouched model siblings', async () => {
    getMessages.mockResolvedValue([
      {
        conversationId: 'conversation-1',
        tokenCount: 10,
        content: [
          { type: ContentTypes.TEXT, text: 'Original response', phase: 'commentary' },
          { type: ContentTypes.TEXT, text: 'PRIVATE-MODEL-SIBLING', phase: 'final' },
        ],
      },
    ]);

    const response = await request(app)
      .put('/api/messages/conversation-1/message-1')
      .send({ index: 0, text: 'Edited response', model: 'gpt-5' });

    expect(response.status).toBe(200);
    expect(assertStoredMessageMutationAllowed).toHaveBeenNthCalledWith(1, undefined, {
      content: [{ text: 'Edited response' }],
    });
    expect(assertStoredMessageMutationAllowed).toHaveBeenNthCalledWith(2, undefined, {
      content: [{ type: ContentTypes.TEXT, text: 'Edited response', phase: 'commentary' }],
    });
  });

  it('clears the generated reasoning title when its reasoning text is edited', async () => {
    getMessages.mockResolvedValue([
      {
        conversationId: 'conversation-1',
        tokenCount: 10,
        content: [
          {
            type: ContentTypes.THINK,
            think: 'Original reasoning',
            agentId: 'agent-1',
            reasoning_label: 'Inspecting the original path',
            reasoning_label_step_id: 'reasoning-step-1',
            reasoning_label_attempts: 3,
            reasoning_label_submitted_chars: 18,
            reasoning_label_revision: 2,
            reasoning_label_status: 'complete',
          },
        ],
      },
    ]);

    const response = await request(app)
      .put('/api/messages/conversation-1/message-1')
      .send({ index: 0, text: 'Edited reasoning', model: 'gpt-5' });

    expect(response.status).toBe(200);
    expect(updateMessage).toHaveBeenCalledWith('user-1', {
      messageId: 'message-1',
      tokenCount: 10,
      content: [
        {
          type: ContentTypes.THINK,
          think: 'Edited reasoning',
          agentId: 'agent-1',
        },
      ],
      userSubmittedPaths: ['/content/0/think'],
    });
  });

  /**
   * A text part is `string | { value, annotations }`. The Assistants thread sync
   * persists the structured form with its file citations intact and the editor reads
   * it through the same union, so writing the edit straight over the object dropped
   * every citation. Counting the object rather than its value is the same mistake
   * read back: the tokenizer measures `text.length`, which an object does not have,
   * so the stored count became NaN.
   */
  it('edits inside a structured text part instead of flattening it', async () => {
    const { countTokens } = require('@librechat/api');
    const annotations = [
      { type: 'file_citation', text: 'source', file_citation: { file_id: 'file-1' } },
    ];

    getMessages.mockResolvedValue([
      {
        conversationId: 'conversation-1',
        tokenCount: 10,
        content: [
          {
            type: ContentTypes.TEXT,
            text: { value: 'Original response', annotations },
          },
        ],
      },
    ]);

    const response = await request(app)
      .put('/api/messages/conversation-1/message-1')
      .send({ index: 0, text: 'Edited response', model: 'gpt-5' });

    expect(response.status).toBe(200);
    expect(updateMessage).toHaveBeenCalledWith('user-1', {
      messageId: 'message-1',
      tokenCount: 10,
      content: [
        {
          type: ContentTypes.TEXT,
          text: { value: 'Edited response', annotations },
        },
      ],
      userSubmittedPaths: ['/content/0/text'],
    });
    expect(countTokens).toHaveBeenCalledWith('Original response', 'gpt-5');
  });
});
