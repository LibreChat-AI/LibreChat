/**
 * Tests for abortMiddleware.
 *
 * The run that produced a stopped response records its own usage on exit
 * (AgentClient labels it 'abort'), so this route must not bill: it only stops
 * the job and persists the partial response.
 */

const mockSpendTokens = jest.fn().mockResolvedValue();
const mockSpendStructuredTokens = jest.fn().mockResolvedValue();
const mockRecordCollectedUsage = jest
  .fn()
  .mockResolvedValue({ input_tokens: 100, output_tokens: 50 });

const mockGetMultiplier = jest.fn().mockReturnValue(1);
const mockGetCacheMultiplier = jest.fn().mockReturnValue(null);
const mockGetTransactionsConfig = jest.fn().mockReturnValue({ enabled: false });

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  /** Real implementations: these tests exist to verify abort classification and the
   *  readable-reply gate themselves, so mocking them would assert the mock rather than the
   *  behavior. */
  isAbortError: jest.requireActual('@librechat/api').isAbortError,
  hasPersistableAbortContent: jest.requireActual('@librechat/api').hasPersistableAbortContent,
  announceReply: jest.requireActual('@librechat/api').announceReply,
  countTokens: jest.fn().mockResolvedValue(100),
  isEnabled: jest.fn().mockReturnValue(false),
  sendEvent: jest.fn(),
  GenerationJobManager: {
    abortJob: jest.fn(),
  },
  recordCollectedUsage: mockRecordCollectedUsage,
  getTransactionsConfig: (...args) => mockGetTransactionsConfig(...args),
  sanitizeMessageForTransmit: jest.fn((msg) => msg),
  buildAbortedResponseMetadata: jest.fn().mockReturnValue(null),
}));

jest.mock('librechat-data-provider', () => ({
  /** Keep the module real: `@librechat/api` is partially un-mocked above and
   *  reads constants (`CacheKeys`, ...) from it at import time. */
  ...jest.requireActual('librechat-data-provider'),
  isAssistantsEndpoint: jest.fn().mockReturnValue(false),
  ErrorTypes: { INVALID_REQUEST: 'INVALID_REQUEST', NO_SYSTEM_MESSAGES: 'NO_SYSTEM_MESSAGES' },
}));

jest.mock('~/app/clients/prompts', () => ({
  truncateText: jest.fn((text) => text),
  smartTruncateText: jest.fn((text) => text),
}));

jest.mock('~/cache/clearPendingReq', () => jest.fn().mockResolvedValue());

jest.mock('~/server/middleware/error', () => ({
  sendError: jest.fn(),
}));

const mockUpdateBalance = jest.fn().mockResolvedValue({});
const mockBulkInsertTransactions = jest.fn().mockResolvedValue(undefined);
jest.mock('~/models', () => ({
  saveMessage: jest.fn().mockResolvedValue(),
  stampConvoLastResponse: jest.fn().mockResolvedValue(),
  getConvo: jest.fn().mockResolvedValue({ title: 'Test Chat' }),
  updateBalance: mockUpdateBalance,
  bulkInsertTransactions: mockBulkInsertTransactions,
  spendTokens: (...args) => mockSpendTokens(...args),
  spendStructuredTokens: (...args) => mockSpendStructuredTokens(...args),
  getMultiplier: mockGetMultiplier,
  getCacheMultiplier: mockGetCacheMultiplier,
}));

jest.mock('./abortRun', () => ({
  abortRun: jest.fn(),
}));

const { logger } = require('@librechat/data-schemas');
const { sendError } = require('~/server/middleware/error');
const { GenerationJobManager } = require('@librechat/api');
const db = require('~/models');
const { handleAbort, handleAbortError } = require('./abortMiddleware');

const buildAbortRequest = () => ({
  body: {
    model: 'gpt-4',
  },
  user: {
    id: 'user-123',
  },
});

describe('abortMiddleware - handleAbortError', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    [
      'native DOMException AbortError',
      new DOMException('The operation was aborted', 'AbortError'),
      'AbortError',
    ],
    [
      'wrapped AbortError message',
      new Error('SSE stream disconnected: AbortError: The operation was aborted'),
      'Error',
    ],
    [
      'cause-nested AbortError',
      new Error('Request failed', {
        cause: new DOMException('The operation was aborted', 'AbortError'),
      }),
      'Error',
    ],
  ])('logs a %s as a debug event instead of an error', async (_label, error, name) => {
    await handleAbortError({}, buildAbortRequest(), error, {
      sender: 'AI',
      conversationId: 'convo-123',
      messageId: 'message-123',
      parentMessageId: 'parent-123',
      userMessageId: 'user-message-123',
    });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith('[handleAbortError] AI response aborted by user', {
      conversationId: 'convo-123',
      code: error.code,
      name,
      message: error.message,
    });
    expect(sendError).toHaveBeenCalledTimes(1);
  });

  it('keeps unexpected generation errors classified as errors', async () => {
    const error = new Error('Provider failed');

    await handleAbortError({}, buildAbortRequest(), error, {
      sender: 'AI',
      conversationId: 'convo-123',
      messageId: 'message-123',
      parentMessageId: 'parent-123',
      userMessageId: 'user-message-123',
    });

    expect(logger.error).toHaveBeenCalledWith(
      '[handleAbortError] AI response error; aborting request:',
      error,
    );
    expect(logger.debug).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledTimes(1);
  });
});

/**
 * The transactions config is resolved from the request's app config and must reach
 * every write path in this file. `createTransaction` reads `transactions` from the
 * caller-supplied data, so an omitted value is indistinguishable from enabled and
 * the write proceeds even when `transactions.enabled` is false.
 */
describe('abortMiddleware - handleAbort billing', () => {
  const buildJobData = () => ({
    model: 'gpt-4',
    responseMessageId: 'msg-123',
    conversationId: 'convo-123',
    endpoint: 'agents',
    sender: 'AI',
    promptTokens: 25,
    userMessage: {
      messageId: 'user-msg-123',
      parentMessageId: 'parent-123',
      conversationId: 'convo-123',
      text: 'hello',
    },
  });

  const buildReq = () => ({
    body: { abortKey: 'convo-123:1', endpoint: 'agents' },
    user: { id: 'user-123', email: 'user@example.com' },
    config: { transactions: { enabled: false } },
  });

  const buildRes = () => ({
    headersSent: false,
    setHeader: jest.fn(),
    send: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTransactionsConfig.mockReturnValue({ enabled: false });
    mockRecordCollectedUsage.mockResolvedValue({ input_tokens: 100, output_tokens: 50 });
    db.getConvo.mockResolvedValue({ title: 'Test Chat' });
  });

  it.each([null, undefined])(
    'keeps read state unchanged when the abort save returns %s',
    async (saved) => {
      const conversation = {
        title: 'Test Chat',
        lastResponseAt: '2026-09-01T10:00:00.000Z',
        lastSeenAt: '2026-09-01T10:01:00.000Z',
      };
      db.saveMessage.mockResolvedValueOnce(saved);
      db.getConvo.mockResolvedValueOnce(conversation);
      GenerationJobManager.abortJob.mockResolvedValue({
        success: true,
        jobData: buildJobData(),
        content: [],
        text: 'partial',
        collectedUsage: [],
      });
      const res = buildRes();

      await handleAbort()(buildReq(), res);

      expect(db.stampConvoLastResponse).not.toHaveBeenCalled();
      expect(JSON.parse(res.send.mock.calls[0][0]).conversation).toEqual(conversation);
    },
  );

  it('announces a persisted stopped reply', async () => {
    db.saveMessage.mockResolvedValueOnce({ messageId: 'msg-123' });
    GenerationJobManager.abortJob.mockResolvedValue({
      success: true,
      jobData: buildJobData(),
      content: [],
      text: 'partial',
      collectedUsage: [],
    });
    const res = buildRes();

    await handleAbort()(buildReq(), res);

    expect(db.stampConvoLastResponse).toHaveBeenCalledWith('user-123', 'convo-123', 'msg-123');
    expect(JSON.parse(res.send.mock.calls[0][0]).final).toBe(true);
  });

  it('does not announce a stopped turn that produced nothing to read', async () => {
    /* An interrupt before the model's first real token still persists the unfinished
       assistant row; a dot raised for it names a reply the user can never open. */
    db.saveMessage.mockResolvedValueOnce({ messageId: 'msg-empty' });
    GenerationJobManager.abortJob.mockResolvedValue({
      success: true,
      jobData: buildJobData(),
      content: [{ type: 'text', text: '   ' }],
      text: '   ',
      collectedUsage: [],
    });
    const res = buildRes();

    await handleAbort()(buildReq(), res);

    expect(db.stampConvoLastResponse).not.toHaveBeenCalled();
    expect(JSON.parse(res.send.mock.calls[0][0]).final).toBe(true);
  });

  it('leaves billing to the run even when the stopped job collected usage', async () => {
    const collectedUsage = [{ input_tokens: 100, output_tokens: 50, model: 'gpt-4' }];
    GenerationJobManager.abortJob.mockResolvedValue({
      success: true,
      jobData: buildJobData(),
      content: [],
      text: 'partial',
      collectedUsage,
    });

    await handleAbort()(buildReq(), buildRes());

    expect(logger.error).not.toHaveBeenCalled();
    expect(mockRecordCollectedUsage).not.toHaveBeenCalled();
    expect(mockSpendTokens).not.toHaveBeenCalled();
    expect(mockSpendStructuredTokens).not.toHaveBeenCalled();
    expect(collectedUsage).toHaveLength(1);
    expect(db.saveMessage).toHaveBeenCalledTimes(1);
  });

  it('carries the context meta the run published onto the job into the stopped response', async () => {
    const contextMeta = {
      calibrationRatio: 1.2,
      encoding: 'claude',
      fading: { v: 1, budgetTokens: 50_000, masked: true },
    };
    GenerationJobManager.abortJob.mockResolvedValue({
      success: true,
      jobData: { ...buildJobData(), contextMeta },
      content: [],
      text: 'partial',
      collectedUsage: [],
    });
    const res = buildRes();

    await handleAbort()(buildReq(), res);

    expect(db.saveMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ messageId: 'msg-123', contextMeta }),
      expect.any(Object),
    );
    const finalEvent = JSON.parse(res.send.mock.calls[0][0]);
    expect(finalEvent.responseMessage.contextMeta).toEqual(contextMeta);
  });

  it('unsets context meta on a stopped response when the job carries none', async () => {
    GenerationJobManager.abortJob.mockResolvedValue({
      success: true,
      jobData: buildJobData(),
      content: [],
      text: 'partial',
      collectedUsage: [],
    });

    await handleAbort()(buildReq(), buildRes());

    const [, savedMessage] = db.saveMessage.mock.calls[0];
    expect(savedMessage.contextMeta).toBeNull();
  });

  it('does not bill a stopped response by token count either', async () => {
    GenerationJobManager.abortJob.mockResolvedValue({
      success: true,
      jobData: buildJobData(),
      content: [],
      text: 'partial',
      collectedUsage: [],
    });

    await handleAbort()(buildReq(), buildRes());

    expect(logger.error).not.toHaveBeenCalled();
    expect(mockRecordCollectedUsage).not.toHaveBeenCalled();
    expect(mockSpendTokens).not.toHaveBeenCalled();
    expect(db.saveMessage).toHaveBeenCalledTimes(1);
  });
});
