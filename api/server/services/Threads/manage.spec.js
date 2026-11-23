/**
 * Tests for recordUsage - the assistants-side token spend path.
 *
 * `createTransaction` reads the guard out of caller-supplied data, so an
 * omitted `transactions` is indistinguishable from an enabled one and the
 * write proceeds even when the resolved config says `enabled: false`.
 */

const mockSpendTokens = jest.fn().mockResolvedValue();

jest.mock('@librechat/api', () => ({
  countTokens: jest.fn().mockResolvedValue(0),
  /* The real predicate, because what may raise an unseen indicator is the behaviour under test
     here; a stub would assert only that this file calls something. */
  isAnnounceableReply: jest.requireActual('@librechat/api').isAnnounceableReply,
  announceReply: jest.fn().mockResolvedValue(false),
  settleAll: jest.requireActual('@librechat/api').settleAll,
  settleStarted: jest.requireActual('@librechat/api').settleStarted,
}));

jest.mock('@librechat/data-schemas', () => ({
  escapeRegExp: jest.fn((str) => str),
}));

jest.mock('~/models', () => ({
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
  saveConvo: jest.fn(),
  spendTokens: (...args) => mockSpendTokens(...args),
}));

jest.mock('~/server/services/Files/process', () => ({
  retrieveAndProcessFile: jest.fn(),
}));

const { recordUsage, checkMessageGaps, saveAssistantMessage } = require('./manage');
const { saveConvo, getMessages, saveMessage } = require('~/models');

describe('recordUsage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards the resolved transactions config to spendTokens', async () => {
    await recordUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      model: 'gpt-4',
      user: 'user-123',
      conversationId: 'convo-123',
      transactions: { enabled: false },
    });

    expect(mockSpendTokens).toHaveBeenCalledTimes(1);
    expect(mockSpendTokens).toHaveBeenCalledWith(
      {
        user: 'user-123',
        model: 'gpt-4',
        context: 'message',
        conversationId: 'convo-123',
        transactions: { enabled: false },
      },
      { promptTokens: 100, completionTokens: 50 },
    );
  });

  it('forwards the config alongside an explicit context', async () => {
    await recordUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      model: 'gpt-4',
      user: 'user-123',
      conversationId: 'convo-123',
      context: 'incomplete',
      transactions: { enabled: true },
    });

    expect(mockSpendTokens).toHaveBeenCalledWith(
      expect.objectContaining({ context: 'incomplete', transactions: { enabled: true } }),
      expect.any(Object),
    );
  });

  it('leaves the call unchanged when no config is supplied', async () => {
    await recordUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      model: 'gpt-4',
      user: 'user-123',
      conversationId: 'convo-123',
    });

    expect(mockSpendTokens).toHaveBeenCalledWith(
      expect.objectContaining({ transactions: undefined }),
      expect.any(Object),
    );
  });
});

describe('saveAssistantMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    saveMessage.mockResolvedValue({ messageId: 'assistant-msg' });
    saveConvo.mockResolvedValue({});
  });

  const params = {
    endpoint: 'assistants',
    conversationId: 'convo-123',
    messageId: 'assistant-msg',
    parentMessageId: 'user-msg',
    text: 'done',
    model: 'gpt-4',
  };

  it('asks saveConvo to stamp the reply at write time', async () => {
    /* A precomputed stamp can be outranked by a catch-up recorded while saveConvo's own reads
       are in flight, which would leave the persisted reply reading as already seen. */
    await saveAssistantMessage({ user: { id: 'user-123' }, body: {} }, params);

    expect(saveConvo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
      expect.not.objectContaining({ lastResponseAt: expect.anything() }),
      expect.objectContaining({ stampReply: true }),
    );
  });

  it.each([
    ['no content and no text', { ...params, text: undefined, content: undefined }],
    ['an empty content array', { ...params, text: undefined, content: [] }],
    ['whitespace-only text', { ...params, text: '   ' }],
  ])('does not stamp an assistant row with %s', async (_case, emptyParams) => {
    /* Acknowledging a reply needs the stamped message on screen, so a row that renders nothing
       would leave a dot that opening the conversation could never clear. */
    await saveAssistantMessage({ user: { id: 'user-123' }, body: {} }, emptyParams);

    expect(saveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ stampReply: false }),
    );
    expect(saveConvo.mock.calls[0][2]).not.toHaveProperty('replyMessageId');
  });

  it('never stamps a temporary conversation', async () => {
    await saveAssistantMessage({ user: { id: 'user-123' }, body: { isTemporary: true } }, params);

    expect(saveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ stampReply: false }),
    );
  });
});

describe('checkMessageGaps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    saveConvo.mockResolvedValue({});
    getMessages.mockResolvedValue([]);
  });

  it('waits for the saves it started before rejecting with a failed thread update', async () => {
    /* On a stopped run the caller settles once this rejects; a save still in flight then lands
       after account deletion and recreates the message for the deleted owner. */
    let finishSave;
    saveMessage.mockReturnValue(new Promise((resolve) => (finishSave = resolve)));
    const updateError = new Error('messages.update failed');
    const openai = {
      req: { user: { id: 'user-123' }, body: {} },
      beta: {
        threads: {
          messages: {
            list: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 'msg_user',
                  role: 'user',
                  created_at: 1,
                  content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
                  metadata: {},
                },
              ],
            }),
            update: jest.fn().mockRejectedValue(updateError),
          },
          runs: { steps: { list: jest.fn().mockResolvedValue({ data: [] }) } },
        },
      },
    };

    let settled = false;
    const gaps = checkMessageGaps({
      openai,
      endpoint: 'assistants',
      thread_id: 'thread_1',
      run_id: 'run_1',
      conversationId: 'convo-123',
    }).finally(() => (settled = true));
    gaps.catch(() => undefined);

    await new Promise((resolve) => setImmediate(resolve));
    expect(openai.beta.threads.messages.update).toHaveBeenCalled();
    expect(saveMessage).toHaveBeenCalled();
    expect(settled).toBe(false);

    finishSave({ messageId: 'saved' });
    await expect(gaps).rejects.toBe(updateError);
    expect(saveConvo).not.toHaveBeenCalled();
  });
});
