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

const { recordUsage } = require('./manage');

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
